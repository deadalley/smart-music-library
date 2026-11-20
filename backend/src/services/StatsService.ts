import {
  Artist,
  ArtistShare,
  DecadeShare,
  LibraryStats,
  Playlist,
  PlaylistOverlap,
  PlaylistRanking,
  PlaylistStats,
  PlaylistType,
  Track,
  TrackOwnership,
  TrackStats,
} from "@smart-music-library/shared";
import { LIKED_SONGS_PLAYLIST_ID, RedisService } from "./RedisService";

const TOP_ARTISTS = 10;
const MOST_VIEWED = 5;
const TOP_PLAYLISTS = 5;
const TOP_OVERLAPS = 5;

const share = (part: number, total: number) => (total > 0 ? part / total : 0);

// Only real release dates count towards eras; an upload date says when a
// video was posted, not when the music came out.
function releaseYear(track: Track): number | undefined {
  const source = track.album?.releaseDateSource;
  if (source !== "youtube" && source !== "musicbrainz") return undefined;
  const year = parseInt(track.album?.releaseDate?.slice(0, 4) ?? "", 10);
  return Number.isFinite(year) && year > 1800 ? year : undefined;
}

/**
 * Pure statistics over a set of tracks. Tracks are de-duplicated by id, so
 * passing the same track twice (e.g. from overlapping playlists) doesn't
 * double-count it.
 */
export function computeTrackStats(
  inputTracks: Track[],
  artistsById: Map<string, Artist> = new Map(),
): TrackStats {
  const seen = new Set<string>();
  const tracks = inputTracks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  const trackCount = tracks.length;

  let totalDurationMs = 0;
  let longestTrack: Track | null = null;
  let shortestTrack: Track | null = null;
  const ownership = { owned: 0, wishlist: 0, notOwned: 0 };
  const artistCounts = new Map<string, { name: string; count: number }>();
  const decadeCounts = new Map<number, number>();
  let tracksWithYear = 0;
  const releaseDates = {
    fromYouTube: 0,
    fromMusicBrainz: 0,
    unknown: 0,
    lookupPending: false,
  };

  for (const track of tracks) {
    totalDurationMs += track.durationMs;
    if (track.durationMs > 0) {
      if (!longestTrack || track.durationMs > longestTrack.durationMs) {
        longestTrack = track;
      }
      if (!shortestTrack || track.durationMs < shortestTrack.durationMs) {
        shortestTrack = track;
      }
    }

    if (track.ownership === TrackOwnership.OWNED) ownership.owned += 1;
    else if (track.ownership === TrackOwnership.WISHLIST) ownership.wishlist += 1;
    else ownership.notOwned += 1;

    track.artistIds.forEach((id, i) => {
      const entry = artistCounts.get(id);
      if (entry) entry.count += 1;
      else
        artistCounts.set(id, { name: track.artistNames[i] ?? "", count: 1 });
    });

    const source = track.album?.releaseDateSource;
    if (source === "youtube") releaseDates.fromYouTube += 1;
    else if (source === "musicbrainz") releaseDates.fromMusicBrainz += 1;
    else releaseDates.unknown += 1;

    const year = releaseYear(track);
    if (year !== undefined) {
      tracksWithYear += 1;
      const decade = Math.floor(year / 10) * 10;
      decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1);
    }
  }

  const topArtists: ArtistShare[] = [...artistCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
    .slice(0, TOP_ARTISTS)
    .map(([id, { name, count }]) => ({
      artist: artistsById.get(id) ?? {
        id,
        name,
        images: [],
        externalUrls: { spotify: "" },
        trackCount: count,
        genres: [],
      },
      trackCount: count,
      share: share(count, trackCount),
    }));

  const decades: DecadeShare[] = [...decadeCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, count]) => ({
      decade: `${decade}s`,
      count,
      share: share(count, tracksWithYear),
    }));

  const mostViewed = tracks
    .filter((t) => t.popularity > 0)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, MOST_VIEWED);

  return {
    trackCount,
    totalDurationMs,
    averageDurationMs:
      trackCount > 0 ? Math.round(totalDurationMs / trackCount) : 0,
    longestTrack,
    shortestTrack,
    uniqueArtistCount: artistCounts.size,
    topArtists,
    ownership: { ...ownership, ownedShare: share(ownership.owned, trackCount) },
    decades,
    releaseDates,
    mostViewed,
  };
}

const PLAYLIST_TYPE_ORDER: (PlaylistType | "untyped")[] = [
  ...Object.values(PlaylistType),
  "untyped",
];

export class StatsService {
  constructor(private library: RedisService) {}

  private async loadArtistsById(): Promise<Map<string, Artist>> {
    const artists = await this.library.getUserArtists();
    return new Map(artists.map((a) => [a.id, a]));
  }

  async getLibraryStats(): Promise<LibraryStats> {
    const [tracks, allPlaylists, artistsById, meta, lookupPending] =
      await Promise.all([
        this.library.getUserTracks(),
        this.library.getUserPlaylists(),
        this.loadArtistsById(),
        this.library.getSyncMeta(),
        this.library.isReleaseLookupPending(),
      ]);

    const playlists = allPlaylists.filter(
      (p) => p.id !== LIKED_SONGS_PLAYLIST_ID,
    );

    const [likedTracks, playlistTracks, memberships] = await Promise.all([
      this.library.getPlaylistTracks(LIKED_SONGS_PLAYLIST_ID),
      Promise.all(playlists.map((p) => this.library.getPlaylistTracks(p.id))),
      this.library.getTrackPlaylistMemberships(tracks.map((t) => t.id)),
    ]);

    const realPlaylistsOf = (trackId: string) =>
      (memberships[trackId] ?? []).filter(
        (id) => id !== LIKED_SONGS_PLAYLIST_ID,
      );

    const unsortedLikedCount = likedTracks.filter(
      (t) => realPlaylistsOf(t.id).length === 0,
    ).length;
    const multiPlaylistTrackCount = tracks.filter(
      (t) => realPlaylistsOf(t.id).length >= 2,
    ).length;

    const rankings: PlaylistRanking[] = playlists.map((playlist, i) => ({
      playlist,
      trackCount: playlistTracks[i].length,
      totalDurationMs: playlistTracks[i].reduce(
        (sum, t) => sum + t.durationMs,
        0,
      ),
    }));

    const typeCounts = new Map<PlaylistType | "untyped", number>();
    for (const p of playlists) {
      const type = p.playlistType ?? "untyped";
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    const trackStats = computeTrackStats(tracks, artistsById);
    trackStats.releaseDates.lookupPending = lookupPending;

    return {
      ...trackStats,
      playlistCount: playlists.length,
      artistCount: artistsById.size,
      likedCount: likedTracks.length,
      unsortedLikedCount,
      multiPlaylistTrackCount,
      averagePlaylistTrackCount:
        rankings.length > 0
          ? Math.round(
              rankings.reduce((sum, r) => sum + r.trackCount, 0) /
                rankings.length,
            )
          : 0,
      playlistsByType: PLAYLIST_TYPE_ORDER.filter((t) => typeCounts.has(t)).map(
        (type) => ({ type, count: typeCounts.get(type)! }),
      ),
      largestPlaylists: [...rankings]
        .sort((a, b) => b.trackCount - a.trackCount)
        .slice(0, TOP_PLAYLISTS),
      longestPlaylists: [...rankings]
        .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
        .slice(0, TOP_PLAYLISTS),
      lastSync: meta?.lastSync,
    };
  }

  async getPlaylistStats(playlistId: string): Promise<PlaylistStats | null> {
    const playlist = await this.library.getPlaylist(playlistId);
    if (!playlist) return null;

    const [tracks, artistsById, allPlaylists, lookupPending] =
      await Promise.all([
        this.library.getPlaylistTracks(playlistId),
        this.loadArtistsById(),
        this.library.getUserPlaylists(),
        this.library.isReleaseLookupPending(),
      ]);
    const memberships = await this.library.getTrackPlaylistMemberships(
      tracks.map((t) => t.id),
    );

    const playlistsById = new Map<string, Playlist>(
      allPlaylists.map((p) => [p.id, p]),
    );
    let likedCount = 0;
    const overlapCounts = new Map<string, number>();
    for (const track of tracks) {
      for (const otherId of memberships[track.id] ?? []) {
        if (otherId === playlistId) continue;
        if (otherId === LIKED_SONGS_PLAYLIST_ID) {
          likedCount += 1;
          continue;
        }
        overlapCounts.set(otherId, (overlapCounts.get(otherId) ?? 0) + 1);
      }
    }
    if (playlistId === LIKED_SONGS_PLAYLIST_ID) likedCount = tracks.length;

    const overlaps: PlaylistOverlap[] = [...overlapCounts.entries()]
      .map(([id, sharedCount]) => ({
        playlist: playlistsById.get(id),
        sharedCount,
        share: share(sharedCount, tracks.length),
      }))
      .filter((o): o is PlaylistOverlap => !!o.playlist)
      .sort((a, b) => b.sharedCount - a.sharedCount)
      .slice(0, TOP_OVERLAPS);

    const trackStats = computeTrackStats(tracks, artistsById);
    trackStats.releaseDates.lookupPending = lookupPending;

    return {
      ...trackStats,
      likedCount,
      likedShare: share(likedCount, tracks.length),
      overlaps,
    };
  }
}
