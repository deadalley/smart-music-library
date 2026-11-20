import { normalizeDate } from "../lib/releaseDate";
import { withRetry } from "../lib/retry";
import { redisClient } from "../redis";

const API_URL = "https://musicbrainz.org/ws/2/recording";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_SCORE = 90;

const CACHE_PREFIX = "smart-spotify:release-date";
const HIT_TTL_SECONDS = 180 * 24 * 60 * 60;
const MISS_TTL_SECONDS = 30 * 24 * 60 * 60;
const MISS = "none";

export function isMusicBrainzEnabled(env = process.env): boolean {
  return env.MUSICBRAINZ_ENABLED !== "false";
}

/**
 * MusicBrainz asks clients to identify themselves. No user data is sent;
 * operators can append a contact (URL or email) via MUSICBRAINZ_CONTACT.
 */
export function musicBrainzUserAgent(env = process.env): string {
  const contact = env.MUSICBRAINZ_CONTACT?.trim();
  return contact ? `SmartMusicLibrary/1.0 ( ${contact} )` : "SmartMusicLibrary/1.0";
}

// --- global (cross-user) cache of looked-up release dates -----------------

/** Cached lookups by video id: a date, `null` for a known miss, or absent. */
export async function getCachedReleaseDates(
  videoIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (videoIds.length === 0) return result;
  const values = await redisClient.mGet(
    videoIds.map((id) => `${CACHE_PREFIX}:${id}`),
  );
  videoIds.forEach((id, i) => {
    const value = values[i];
    if (value === null || value === undefined) return;
    result.set(id, value === MISS ? null : value);
  });
  return result;
}

export async function cacheReleaseDate(
  videoId: string,
  date: string | null,
): Promise<void> {
  await redisClient.set(`${CACHE_PREFIX}:${videoId}`, date ?? MISS, {
    EX: date ? HIT_TTL_SECONDS : MISS_TTL_SECONDS,
  });
}

// --- matching ---------------------------------------------------------------

interface MusicBrainzRecording {
  id: string;
  score: number;
  title: string;
  "first-release-date"?: string;
  "artist-credit"?: { name?: string; artist?: { name?: string } }[];
}

const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim();

function artistMatches(recording: MusicBrainzRecording, artist: string) {
  const wanted = normalize(artist);
  if (!wanted) return false;
  const credits = (recording["artist-credit"] ?? []).flatMap((c) =>
    [c.name, c.artist?.name].filter((n): n is string => !!n).map(normalize),
  );
  const joined = credits.join(" ");
  return credits.some((c) => c === wanted) || joined.includes(wanted);
}

function titleMatches(recording: MusicBrainzRecording, title: string) {
  const a = normalize(recording.title);
  const b = normalize(title);
  return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));
}

/** Earliest release date among confident matches, or null. */
export function pickReleaseDate(
  recordings: MusicBrainzRecording[],
  artist: string,
  title: string,
): string | null {
  const dates = recordings
    .filter((r) => r.score >= MIN_SCORE)
    .filter((r) => artistMatches(r, artist) && titleMatches(r, title))
    .map((r) => normalizeDate(r["first-release-date"]))
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] ?? null;
}

const escapeLucene = (value: string) => value.replace(/(["\\])/g, "\\$1");

type FetchLike = typeof fetch;

export class MusicBrainzService {
  constructor(
    private fetchImpl: FetchLike = fetch,
    private userAgent = musicBrainzUserAgent(),
  ) {}

  async findReleaseDate(artist: string, title: string): Promise<string | null> {
    if (!artist || !title) return null;

    const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
    const url = `${API_URL}?${new URLSearchParams({ query, fmt: "json", limit: "10" })}`;

    const body = await withRetry(
      async () => {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          // Shape it like an HTTP client error so withRetry can classify it
          // (MusicBrainz answers 503 when we're over its rate limit).
          throw Object.assign(new Error(`MusicBrainz HTTP ${res.status}`), {
            response: {
              status: res.status,
              headers: { "retry-after": res.headers.get("retry-after") ?? undefined },
            },
          });
        }
        return (await res.json()) as { recordings?: MusicBrainzRecording[] };
      },
      { maxAttempts: 4, baseDelayMs: 1500 },
    );

    return pickReleaseDate(body.recordings ?? [], artist, title);
  }
}
