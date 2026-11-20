import { ReleaseDateSource, Track } from "@smart-music-library/shared";
import { Job } from "bullmq";
import { cleanTrackForLookup } from "../lib/releaseDate";
import {
  cacheReleaseDate,
  getCachedReleaseDates,
  MusicBrainzService,
} from "../services/MusicBrainzService";
import { MusicSource, RedisService } from "../services/RedisService";

export interface EnrichReleaseDatesJobData {
  userId: string;
  source: MusicSource;
}

/** Lookups per job; a follow-up job is queued for the rest. */
export const ENRICH_BATCH_SIZE = 50;
/** MusicBrainz allows ~1 request/second per client. */
export const MUSICBRAINZ_INTERVAL_MS = 1100;
/** Safety expiry for the "lookup pending" flag (refreshed per batch). */
export const LOOKUP_FLAG_TTL_SECONDS = 2 * 60 * 60;
const MAX_CONSECUTIVE_ERRORS = 5;

// Descriptions of remastered/reissued tracks carry the reissue's date, so
// those are looked up too and the earlier date wins.
const REISSUE_HINT = /remaster|anniversary|deluxe|expanded|re-?issue/i;

function needsLookup(track: Track): boolean {
  if (!track.album?.id) return false;
  const source = track.album.releaseDateSource;
  if (source === "musicbrainz") return false;
  if (source === "youtube") return REISSUE_HINT.test(track.name);
  return true; // upload date only, or nothing
}

function isImprovement(track: Track, date: string): boolean {
  if (track.album.releaseDateSource !== "youtube") return true;
  return !track.album.releaseDate || date < track.album.releaseDate;
}

export interface EnrichDeps {
  musicBrainz?: Pick<MusicBrainzService, "findReleaseDate">;
  sleep?: (ms: number) => Promise<void>;
  /** Queues the next batch for this user. */
  enqueueNext?: (data: EnrichReleaseDatesJobData) => Promise<void>;
}

export interface EnrichResult {
  lookedUp: number;
  found: number;
  applied: number;
  remaining: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function enrichReleaseDatesJob(
  job: Pick<Job<EnrichReleaseDatesJobData>, "data">,
  {
    musicBrainz = new MusicBrainzService(),
    sleep = defaultSleep,
    enqueueNext,
  }: EnrichDeps = {},
): Promise<EnrichResult> {
  const { userId, source } = job.data;
  const library = await RedisService.forUser(userId, source);

  try {
    const tracks = (await library.getUserTracks()).filter(needsLookup);
    const cached = await getCachedReleaseDates(tracks.map((t) => t.id));

    const updates: {
      albumId: string;
      releaseDate: string;
      source: ReleaseDateSource;
    }[] = [];
    const queueUpdate = (track: Track, date: string | null) => {
      if (date && isImprovement(track, date)) {
        updates.push({
          albumId: track.album.id,
          releaseDate: date,
          source: "musicbrainz",
        });
      }
    };

    // Results another user's lookup already found.
    for (const track of tracks) {
      if (cached.has(track.id)) queueUpdate(track, cached.get(track.id)!);
    }

    const toLookUp = tracks.filter((t) => !cached.has(t.id));
    const batch = toLookUp.slice(0, ENRICH_BATCH_SIZE);
    let found = 0;
    let lookedUp = 0;
    let consecutiveErrors = 0;

    for (const [i, track] of batch.entries()) {
      if (i > 0) await sleep(MUSICBRAINZ_INTERVAL_MS);
      const { artist, title } = cleanTrackForLookup(
        track.name,
        track.artistNames[0] ?? "",
      );
      try {
        const date = await musicBrainz.findReleaseDate(artist, title);
        consecutiveErrors = 0;
        lookedUp += 1;
        await cacheReleaseDate(track.id, date);
        if (date) found += 1;
        queueUpdate(track, date);
      } catch (error) {
        consecutiveErrors += 1;
        console.warn(
          `MusicBrainz lookup failed for "${artist} - ${title}":`,
          error instanceof Error ? error.message : error,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error("MusicBrainz appears unavailable; stopping lookups");
        }
      }
    }

    // Re-resolve: a resync may have swapped generations while we waited.
    const live = await RedisService.forUser(userId, source);
    const applied = await live.updateAlbumReleaseDates(updates);

    const remaining = toLookUp.length - batch.length;
    if (remaining > 0 && enqueueNext) {
      await library.refreshReleaseLookup(LOOKUP_FLAG_TTL_SECONDS);
      await enqueueNext({ userId, source });
    } else {
      await library.clearReleaseLookup();
    }

    return { lookedUp, found, applied, remaining };
  } catch (error) {
    await library.clearReleaseLookup();
    throw error;
  }
}
