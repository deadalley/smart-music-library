import {
  Artist,
  Playlist,
  ReleaseDateSource,
  Track,
  TrackOwnership,
} from "@smart-music-library/shared";
import { Job } from "bullmq";
import { parseReleaseDateFromDescription } from "../lib/releaseDate";
import { getErrorStatus } from "../lib/retry";
import { getCachedReleaseDates } from "../services/MusicBrainzService";
import {
  LIKED_SONGS_PLAYLIST_ID,
  MusicSource,
  RedisService,
} from "../services/RedisService";
import {
  convertYouTubeThumbnails,
  YOUTUBE_MUSIC_CATEGORY_ID,
  YouTubeService,
  YouTubeVideo,
} from "../services/YouTubeService";

// YouTube's API has no concept of "YouTube Music" playlists distinct from
// regular YouTube ones — they're the same underlying objects. Approximate
// it by requiring a majority of a playlist's videos to be tagged with the
// "Music" video category; playlists that are mostly non-music (vlogs,
// gaming, tutorials, etc.) are skipped. Not perfect — video category is
// set by the uploader and is sometimes wrong — but it's the best signal
// the official Data API exposes.
const MIN_MUSIC_RATIO = 0.5;

// Playlist-level errors that mean "this one playlist can't be read" (deleted,
// private, region-locked...) rather than "the whole sync is broken".
const SKIPPABLE_PLAYLIST_STATUSES = new Set([403, 404]);

export enum JobProgressPercentage {
  START = 0,
  USER_INFO_STORED = 5,
  PLAYLISTS_STORED = 25,
  TRACKS_STORED = 65,
  ARTISTS_STORED = 80,
  COMPLETED = 100,
}

export interface PersistJobData {
  userId: string;
  accessToken: string;
  source: MusicSource;
  refreshToken?: string;
}

export function getPersistJobStatusMessage(progress: number): string {
  if (progress === JobProgressPercentage.START) {
    return "Job started...";
  } else if (progress < JobProgressPercentage.PLAYLISTS_STORED) {
    return "Fetching liked songs...";
  } else if (progress < JobProgressPercentage.TRACKS_STORED) {
    return "Storing playlists...";
  } else if (progress < JobProgressPercentage.ARTISTS_STORED) {
    return "Storing artists...";
  } else if (progress < JobProgressPercentage.COMPLETED) {
    return "Finalizing...";
  } else if (progress === JobProgressPercentage.COMPLETED) {
    return "Data persistence completed.";
  }
  return "Unknown progress state.";
}

function calculateProgress({
  currentStep,
  totalSteps,
  startPercent,
  endPercent,
}: {
  currentStep: number;
  totalSteps: number;
  startPercent: number;
  endPercent: number;
}): number {
  if (totalSteps <= 0) return endPercent;
  return Math.round(
    startPercent +
      ((currentStep + 1) / totalSteps) * (endPercent - startPercent),
  );
}

/**
 * Best known release date for a video: the YouTube Music description, then a
 * cached MusicBrainz lookup (only used if earlier — descriptions of remasters
 * carry the remaster's date), then the upload date.
 */
export function resolveReleaseDate(
  v: YouTubeVideo,
  cached?: string | null,
): { releaseDate?: string; releaseDateSource?: ReleaseDateSource } {
  const fromDescription = parseReleaseDateFromDescription(v.description);
  if (fromDescription && (!cached || fromDescription <= cached)) {
    return { releaseDate: fromDescription, releaseDateSource: "youtube" };
  }
  if (cached) return { releaseDate: cached, releaseDateSource: "musicbrainz" };
  const upload = v.publishedAt?.slice(0, 10);
  return upload
    ? { releaseDate: upload, releaseDateSource: "upload" }
    : {};
}

export function videoToTrack(v: YouTubeVideo, cachedReleaseDate?: string | null): Track {
  const artistName = v.channelTitle.replace(/ - Topic$/, "");
  return {
    id: v.id,
    name: v.title,
    uri: `youtube:video:${v.id}`,
    durationMs: v.durationMs,
    explicit: false,
    popularity: v.viewCount ?? 0,
    previewUrl: null,
    trackNumber: 0,
    discNumber: 0,
    externalUrls: {
      spotify: `https://www.youtube.com/watch?v=${v.id}`,
    },
    artistIds: [v.channelId],
    artistNames: [artistName],
    album: {
      // Unique per video, not per channel: each YouTube video has its own
      // thumbnail, and this "album" only exists to carry that thumbnail.
      // Reusing the channel id here would collide across every track from
      // the same artist (see RedisService.storeTracks' album dedupe).
      id: `${v.channelId}:${v.id}`,
      name: artistName,
      type: "youtube",
      ...resolveReleaseDate(v, cachedReleaseDate),
      images: convertYouTubeThumbnails(v.thumbnails),
      externalUrls: {
        spotify: `https://www.youtube.com/channel/${v.channelId}`,
      },
    },
    // Ownership is a user annotation stored separately; never written here.
    ownership: TrackOwnership.NOT_OWNED,
  };
}

export interface SyncResult {
  playlistCount: number;
  trackCount: number;
  artistCount: number;
  skippedPlaylists: number;
}

/**
 * Builds a complete copy of the user's library in `store` (a fresh, not
 * yet live, generation). Does not activate it.
 */
export async function syncYouTubeLibrary({
  userId,
  yt,
  store,
  reportProgress,
}: {
  userId: string;
  yt: YouTubeService;
  store: RedisService;
  reportProgress: (progress: number) => Promise<void>;
}): Promise<SyncResult> {
  const uniqueArtists = new Map<string, { id: string; name: string }>();
  const trackIds = new Set<string>();
  const playlists: Playlist[] = [];
  let skippedPlaylists = 0;

  // Video details are fetched once per sync, not once per playlist they
  // appear in — saves YouTube API quota for overlapping playlists.
  const videoCache = new Map<string, YouTubeVideo>();
  const getVideos = async (ids: string[]): Promise<YouTubeVideo[]> => {
    const missing = ids.filter((id) => !videoCache.has(id));
    if (missing.length > 0) {
      for (const video of await yt.getVideosByIds(missing)) {
        videoCache.set(video.id, video);
      }
    }
    return ids
      .map((id) => videoCache.get(id))
      .filter((v): v is YouTubeVideo => !!v);
  };

  // Release dates found by earlier MusicBrainz lookups (any user).
  const toTracks = async (videos: YouTubeVideo[]): Promise<Track[]> => {
    const cached = await getCachedReleaseDates(videos.map((v) => v.id));
    return videos.map((v) => videoToTrack(v, cached.get(v.id)));
  };

  const collect = (tracks: Track[]) => {
    for (const track of tracks) {
      trackIds.add(track.id);
      track.artistIds.forEach((id, i) =>
        uniqueArtists.set(id, { id, name: track.artistNames[i] ?? "" }),
      );
    }
  };

  // Liked songs -> virtual "liked-songs" playlist (music videos only).
  const allLikedVideos = await yt.listLikedVideos();
  const likedVideos = allLikedVideos.filter(
    (v) => v.categoryId === YOUTUBE_MUSIC_CATEGORY_ID,
  );
  console.log(
    `Liked videos for user ${userId}: ${allLikedVideos.length} total, ${likedVideos.length} in the Music category`,
  );
  likedVideos.forEach((v) => videoCache.set(v.id, v));
  const likedTracks = await toTracks(likedVideos);
  if (likedTracks.length > 0) {
    playlists.push({
      id: LIKED_SONGS_PLAYLIST_ID,
      name: "Liked Songs",
      description: "Your liked music on YouTube",
      ownerId: userId,
      public: false,
      collaborative: false,
      trackCount: likedTracks.length,
      images: likedTracks[0].album.images ?? [],
      externalUrls: { spotify: "https://music.youtube.com/playlist?list=LM" },
      snapshotId: "",
    });
    await store.storeTracks(LIKED_SONGS_PLAYLIST_ID, likedTracks);
    collect(likedTracks);
  }
  await reportProgress(JobProgressPercentage.USER_INFO_STORED);

  const youtubePlaylists = await yt.listMyPlaylists();

  for (let i = 0; i < youtubePlaylists.length; i++) {
    const p = youtubePlaylists[i];

    let videos: YouTubeVideo[];
    try {
      const ids = await yt.listPlaylistVideoIds(p.id);
      videos = await getVideos(ids);
    } catch (err) {
      const status = getErrorStatus(err);
      if (status !== undefined && SKIPPABLE_PLAYLIST_STATUSES.has(status)) {
        console.warn(
          `Skipping playlist ${p.id} for user ${userId}: HTTP ${status}`,
        );
        skippedPlaylists += 1;
        continue;
      }
      throw err;
    }

    const musicRatio =
      videos.length === 0
        ? 1
        : videos.filter((v) => v.categoryId === YOUTUBE_MUSIC_CATEGORY_ID)
            .length / videos.length;

    if (musicRatio >= MIN_MUSIC_RATIO) {
      const tracks = await toTracks(videos);
      playlists.push({
        id: p.id,
        name: p.title,
        description: p.description,
        ownerId: userId,
        public: false,
        collaborative: false,
        trackCount: tracks.length,
        images: convertYouTubeThumbnails(p.thumbnails),
        externalUrls: {
          spotify: `https://www.youtube.com/playlist?list=${p.id}`,
        },
        snapshotId: "",
      });
      await store.storeTracks(p.id, tracks);
      collect(tracks);
    }

    await reportProgress(
      calculateProgress({
        currentStep: i,
        totalSteps: youtubePlaylists.length,
        startPercent: JobProgressPercentage.PLAYLISTS_STORED,
        endPercent: JobProgressPercentage.TRACKS_STORED,
      }),
    );
  }

  await store.storePlaylists(playlists);

  // Artists are channels. Genres are unknown for YouTube, store empty.
  const artistIds = Array.from(uniqueArtists.keys());
  const channels = await yt.getChannelsByIds(artistIds);
  const channelThumbnails = new Map(
    channels.map((c) => [c.id, c.thumbnails] as const),
  );

  const artists: Artist[] = Array.from(uniqueArtists.values()).map((a) => ({
    id: a.id,
    name: a.name,
    images: convertYouTubeThumbnails(channelThumbnails.get(a.id)),
    externalUrls: { spotify: `https://www.youtube.com/channel/${a.id}` },
    trackCount: 0,
    genres: [],
  }));

  await store.storeArtists(artists);
  await reportProgress(JobProgressPercentage.ARTISTS_STORED);

  const result: SyncResult = {
    playlistCount: playlists.length,
    trackCount: trackIds.size,
    artistCount: artists.length,
    skippedPlaylists,
  };

  await store.setSyncMeta({ lastSync: new Date().toISOString(), ...result });

  return result;
}

export type YouTubeServiceFactory = (
  data: PersistJobData,
) => YouTubeService;

const defaultYouTubeFactory: YouTubeServiceFactory = (data) =>
  // The OAuth2 client refreshes the access token on its own (on expiry or
  // a 401) when it has a refresh token.
  new YouTubeService({
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
  });

export interface PersistHooks {
  /** Called once the new library generation is live. */
  onActivated?: (userId: string) => Promise<void>;
}

export async function persistUserDataJob(
  job: Job<PersistJobData>,
  createYouTubeService: YouTubeServiceFactory = defaultYouTubeFactory,
  hooks: PersistHooks = {},
): Promise<SyncResult> {
  const { userId, source } = job.data;
  if (source !== "yt-music") {
    throw new Error(`Unsupported music source: ${source}`);
  }

  // Each attempt builds its own generation; the live library is untouched
  // until the new one is complete.
  const generation = `${job.id}-${job.attemptsMade}`;
  const store = new RedisService(userId, generation, source);

  try {
    await job.updateProgress(JobProgressPercentage.START);

    const result = await syncYouTubeLibrary({
      userId,
      yt: createYouTubeService(job.data),
      store,
      reportProgress: (progress) => job.updateProgress(progress),
    });

    await RedisService.activateGeneration(userId, generation, source);
    await job.updateProgress(JobProgressPercentage.COMPLETED);

    if (hooks.onActivated) {
      // Follow-up work (release-date lookups) must never fail the sync.
      await hooks.onActivated(userId).catch((hookError) => {
        console.error("Post-sync hook failed:", hookError);
      });
    }

    console.log(
      `YouTube sync completed for user ${userId}: ${result.playlistCount} playlists, ${result.trackCount} tracks, ${result.artistCount} artists, ${result.skippedPlaylists} skipped`,
    );
    return result;
  } catch (error) {
    // Discard the partial generation; the previous library stays live.
    await store.deleteLibraryData().catch((cleanupError) => {
      console.error("Failed to clean up partial sync data:", cleanupError);
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Persist job failed: ${message}`);
  }
}
