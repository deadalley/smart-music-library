import {
  Album,
  Artist,
  ExternalUrls,
  Playlist,
  PlaylistType,
  Track,
  TrackOwnership,
} from "./types";

/**
 * JSON.parse that never throws: returns `fallback` for missing, empty or
 * corrupt input (and for values whose parsed type doesn't match the
 * fallback's array/object shape). A single malformed field in Redis should
 * degrade one value, not turn every list endpoint into a 500.
 */
export function safeJsonParse<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || parsed === undefined) return fallback;
    if (Array.isArray(fallback) !== Array.isArray(parsed)) return fallback;
    if (typeof parsed !== typeof fallback) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function safeInt(value: string | undefined, fallback = 0): number {
  const parsed = parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const EMPTY_EXTERNAL_URLS: ExternalUrls = { spotify: "" };

const PLAYLIST_TYPES = new Set<string>(Object.values(PlaylistType));
const TRACK_OWNERSHIP_STATES = new Set<string>(Object.values(TrackOwnership));

export function isPlaylistType(value: unknown): value is PlaylistType {
  return typeof value === "string" && PLAYLIST_TYPES.has(value);
}

export function isTrackOwnership(value: unknown): value is TrackOwnership {
  return typeof value === "string" && TRACK_OWNERSHIP_STATES.has(value);
}

// User annotations (playlistType, ownership) are stored separately from the
// synced library data and overlaid at read time, so they are intentionally
// not part of these "to Redis" conversions.
export function convertToRedisPlaylist(
  playlist: Playlist,
): Record<string, string> {
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    ownerId: playlist.ownerId,
    public: playlist.public.toString(),
    collaborative: playlist.collaborative.toString(),
    trackCount: playlist.trackCount.toString(),
    images: JSON.stringify(playlist.images),
    externalUrls: JSON.stringify(playlist.externalUrls),
    snapshotId: playlist.snapshotId,
  };
}

export function convertToRedisTrack(track: Track): Record<string, string> {
  return {
    id: track.id,
    name: track.name,
    uri: track.uri,
    durationMs: track.durationMs.toString(),
    explicit: track.explicit.toString(),
    popularity: track.popularity.toString(),
    previewUrl: track.previewUrl || "",
    trackNumber: track.trackNumber.toString(),
    discNumber: track.discNumber.toString(),
    playlistPosition: track.playlistPosition?.toString() || "",
    externalUrls: JSON.stringify(track.externalUrls),
    artistIds: JSON.stringify(track.artistIds),
    artistNames: JSON.stringify(track.artistNames),
    albumId: track.album.id,
  };
}

export function convertToRedisAlbum(album: Album): Record<string, string> {
  return {
    id: album.id,
    name: album.name,
    type: album.type,
    releaseDate: album.releaseDate || "",
    totalTracks: album.totalTracks?.toString() || "",
    images: JSON.stringify(album.images || []),
    externalUrls: JSON.stringify(album.externalUrls || EMPTY_EXTERNAL_URLS),
  };
}

export function convertToRedisArtist(artist: Artist): Record<string, string> {
  return {
    id: artist.id,
    name: artist.name,
    images: JSON.stringify(artist.images),
    externalUrls: JSON.stringify(artist.externalUrls),
    trackCount: artist.trackCount.toString(),
    genres: JSON.stringify(artist.genres),
  };
}

export function convertFromRedisPlaylist(
  data: Record<string, string>,
): Playlist {
  return {
    id: data.id,
    name: data.name || "",
    description: data.description || "",
    ownerId: data.ownerId || "",
    public: data.public === "true",
    collaborative: data.collaborative === "true",
    trackCount: safeInt(data.trackCount),
    images: safeJsonParse(data.images, []),
    externalUrls: safeJsonParse(data.externalUrls, EMPTY_EXTERNAL_URLS),
    snapshotId: data.snapshotId || "",
    // Legacy location; current data keeps this in a separate annotations
    // hash that callers overlay on top.
    playlistType: isPlaylistType(data.playlistType)
      ? data.playlistType
      : undefined,
  };
}

export function convertFromRedisTrack(
  data: Record<string, string>,
  album?: Album,
): Track {
  return {
    id: data.id,
    name: data.name || "",
    uri: data.uri || `youtube:video:${data.id}`,
    durationMs: safeInt(data.durationMs),
    explicit: data.explicit === "true",
    popularity: safeInt(data.popularity),
    previewUrl: data.previewUrl || null,
    trackNumber: safeInt(data.trackNumber),
    discNumber: safeInt(data.discNumber),
    playlistPosition: data.playlistPosition
      ? safeInt(data.playlistPosition)
      : undefined,
    externalUrls: safeJsonParse(data.externalUrls, EMPTY_EXTERNAL_URLS),
    artistIds: safeJsonParse<string[]>(data.artistIds, []),
    artistNames: safeJsonParse<string[]>(data.artistNames, []),
    album: album ?? ({ id: data.albumId || "", name: "", type: "" } as Album),
    // Legacy location; see convertFromRedisPlaylist.
    ownership: isTrackOwnership(data.ownership)
      ? data.ownership
      : TrackOwnership.NOT_OWNED,
  };
}

export function convertFromRedisAlbum(data: Record<string, string>): Album {
  return {
    id: data.id,
    name: data.name || "",
    type: data.type || "",
    releaseDate: data.releaseDate || undefined,
    totalTracks: data.totalTracks ? safeInt(data.totalTracks) : undefined,
    images: safeJsonParse(data.images, []),
    externalUrls: safeJsonParse(data.externalUrls, EMPTY_EXTERNAL_URLS),
  };
}

export function convertFromRedisArtist(data: Record<string, string>): Artist {
  return {
    id: data.id,
    name: data.name || "",
    images: safeJsonParse(data.images, []),
    externalUrls: safeJsonParse(data.externalUrls, EMPTY_EXTERNAL_URLS),
    trackCount: safeInt(data.trackCount),
    genres: safeJsonParse<string[]>(data.genres, []),
  };
}
