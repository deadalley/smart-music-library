import {
  LibrarySearchResult,
  SearchResultGroup,
  Track,
} from "@smart-music-library/shared";
import { LIKED_SONGS_PLAYLIST_ID, RedisService } from "./RedisService";

const MAX_RESULTS_PER_SECTION = 8;

// Every query token must appear somewhere across the given fields, so a
// query like "artist title" matches a track whose artist and title each
// contain one of the words.
export function matches(
  queryTokens: string[],
  ...fields: (string | undefined)[]
): boolean {
  const haystack = fields
    .filter((f): f is string => !!f)
    .join(" \u0000 ")
    .toLowerCase();
  if (!haystack) return false;
  return queryTokens.every((token) => haystack.includes(token));
}

function toGroup<T>(matched: T[]): SearchResultGroup<T> {
  return {
    items: matched.slice(0, MAX_RESULTS_PER_SECTION),
    totalCount: matched.length,
  };
}

function derivePrimaryArtistName(tracks: Track[]): string | null {
  const counts = tracks
    .flatMap((t) => t.artistNames ?? [])
    .reduce(
      (acc, name) => acc.set(name, (acc.get(name) ?? 0) + 1),
      new Map<string, number>()
    );

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function deriveAlbums(tracks: Track[]) {
  const tracksByAlbumId = new Map<string, Track[]>();

  for (const track of tracks) {
    const album = track.album;
    if (!album?.id || album.type === "youtube") continue;
    const existing = tracksByAlbumId.get(album.id);
    if (existing) {
      existing.push(track);
    } else {
      tracksByAlbumId.set(album.id, [track]);
    }
  }

  return [...tracksByAlbumId.entries()].map(([, albumTracks]) => ({
    ...albumTracks[0].album,
    artistName: derivePrimaryArtistName(albumTracks),
  }));
}

export class SearchService {
  constructor(private redisService: RedisService) {}

  async search(query: string): Promise<LibrarySearchResult> {
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

    const [tracks, artists, playlists] = await Promise.all([
      this.redisService.getUserTracks(),
      this.redisService.getUserArtists(),
      this.redisService.getUserPlaylists(),
    ]);

    const matchedTracks = tracks.filter((t) =>
      matches(queryTokens, t.name, ...(t.artistNames ?? []))
    );

    const matchedAlbums = deriveAlbums(tracks).filter((a) =>
      matches(queryTokens, a.name)
    );

    const matchedArtists = artists.filter((a) =>
      matches(queryTokens, a.name)
    );

    const matchedPlaylists = playlists
      .filter((p) => p.id !== LIKED_SONGS_PLAYLIST_ID)
      .filter((p) => matches(queryTokens, p.name));

    return {
      tracks: toGroup(matchedTracks),
      albums: toGroup(matchedAlbums),
      artists: toGroup(matchedArtists),
      playlists: toGroup(matchedPlaylists),
    };
  }
}
