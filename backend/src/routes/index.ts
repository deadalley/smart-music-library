import {
  isPlaylistType,
  isTrackOwnership,
  PlaylistAnalysisResult,
  PlaylistType,
  TrackOwnership,
} from "@smart-music-library/shared";
import { NextFunction, Request, Response, Router } from "express";
import { getErrorReasons, getErrorStatus } from "../lib/retry";
import { requireAuth } from "../middleware/requireAuth";
import {
  PlaylistService,
  RedisService,
  SearchService,
  StatsService,
  YouTubeService,
} from "../services";
import { LIKED_SONGS_PLAYLIST_ID } from "../services/RedisService";

const router: Router = Router();

const MAX_MEMBERSHIP_TRACK_IDS = 5000;

type LibraryHandler = (
  req: Request,
  res: Response,
  library: RedisService,
) => Promise<unknown>;

/**
 * Wraps a handler that needs the authenticated user's library: resolves the
 * live library generation and turns thrown errors into a JSON 500 (with a
 * consistent log line) instead of an unhandled rejection.
 */
function withLibrary(errorMessage: string, handler: LibraryHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const library = await RedisService.forUser(req.userId!);
      await handler(req, res, library);
    } catch (error) {
      console.error(`${errorMessage}:`, error);
      if (res.headersSent) return next(error);
      res.status(500).json({ error: errorMessage });
    }
  };
}

/** Maps YouTube API write errors to a client-facing response. */
function sendYouTubeWriteError(res: Response, error: unknown, fallback: string) {
  const status = getErrorStatus(error);
  if (status === 401) {
    return res.status(401).json({ error: "Token expired" });
  }
  if (status === 403) {
    const reasons = getErrorReasons(error);
    const insufficientScope =
      reasons.includes("insufficientPermissions") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    return res.status(403).json({
      error: "Permission denied",
      message: insufficientScope
        ? "Log out and log in again, granting permission to manage your YouTube account, to make changes."
        : "You don't have permission to modify this playlist.",
    });
  }
  if (status === 404) {
    return res.status(404).json({ error: "Not found on YouTube" });
  }
  return res.status(502).json({ error: fallback });
}

router.use(requireAuth);

router.get(
  "/tracks",
  withLibrary("Failed to fetch cached tracks", async (_req, res, library) => {
    res.json(await library.getUserTracks());
  }),
);

router.get(
  "/tracks/saved",
  withLibrary("Failed to fetch saved tracks", async (_req, res, library) => {
    res.json(await library.getPlaylistTracks(LIKED_SONGS_PLAYLIST_ID));
  }),
);

router.get(
  "/tracks/aggregate",
  withLibrary(
    "Failed to fetch aggregated liked songs",
    async (_req, res, library) => {
      res.json(await new PlaylistService(library).aggregateLikedSongs());
    },
  ),
);

router.delete(
  "/tracks/saved/:id",
  withLibrary(
    "Failed to remove track from liked songs",
    async (req, res, library) => {
      const trackId = req.params.id;
      try {
        const yt = new YouTubeService({ access_token: req.accessToken! });
        await yt.unlikeVideo(trackId);
      } catch (error) {
        console.error("Error removing like on YouTube:", error);
        return sendYouTubeWriteError(
          res,
          error,
          "Failed to remove track from liked songs",
        );
      }

      await library.removeTrackFromPlaylist(LIKED_SONGS_PLAYLIST_ID, trackId);
      res.json({ success: true });
    },
  ),
);

router.patch(
  "/tracks/:id/ownership",
  withLibrary("Failed to update track ownership", async (req, res, library) => {
    const { ownership } = req.body ?? {};
    if (!isTrackOwnership(ownership)) {
      return res.status(400).json({
        error: "Invalid ownership state",
        validOwnershipStates: Object.values(TrackOwnership),
      });
    }

    await library.updateTrackOwnership(req.params.id, ownership);
    res.json({ success: true, ownership });
  }),
);

router.post(
  "/tracks/playlist-memberships",
  withLibrary(
    "Failed to fetch track playlist memberships",
    async (req, res, library) => {
      const trackIds = req.body?.trackIds;
      if (
        !Array.isArray(trackIds) ||
        !trackIds.every((id) => typeof id === "string")
      ) {
        return res
          .status(400)
          .json({ error: "trackIds must be an array of strings" });
      }
      if (trackIds.length > MAX_MEMBERSHIP_TRACK_IDS) {
        return res.status(400).json({
          error: `At most ${MAX_MEMBERSHIP_TRACK_IDS} trackIds per request`,
        });
      }

      res.json(await library.getTrackPlaylistMemberships(trackIds));
    },
  ),
);

router.get(
  "/search",
  withLibrary("Failed to search library", async (req, res, library) => {
    const query =
      typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2) {
      return res
        .status(400)
        .json({ error: "Query must be at least 2 characters" });
    }

    res.json(await new SearchService(library).search(query));
  }),
);

router.get(
  "/stats",
  withLibrary("Failed to compute library statistics", async (_req, res, library) => {
    res.json(await new StatsService(library).getLibraryStats());
  }),
);

router.get(
  "/playlists/:id/stats",
  withLibrary(
    "Failed to compute playlist statistics",
    async (req, res, library) => {
      const stats = await new StatsService(library).getPlaylistStats(
        req.params.id,
      );
      if (!stats) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      res.json(stats);
    },
  ),
);

router.get(
  "/playlists",
  withLibrary("Failed to fetch cached playlists", async (_req, res, library) => {
    const playlists = await library.getUserPlaylists();
    res.json(playlists.filter((p) => p.id !== LIKED_SONGS_PLAYLIST_ID));
  }),
);

router.get(
  "/playlists/:id",
  withLibrary("Failed to fetch cached playlist", async (req, res, library) => {
    const playlist = await library.getPlaylist(req.params.id);
    if (!playlist) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    res.json(playlist);
  }),
);

router.get(
  "/playlists/:id/tracks",
  withLibrary(
    "Failed to fetch cached playlist tracks",
    async (req, res, library) => {
      res.json(await library.getPlaylistTracks(req.params.id));
    },
  ),
);

router.post(
  "/playlists/:id/tracks",
  withLibrary("Failed to add track to playlist", async (req, res, library) => {
    const playlistId = req.params.id;
    const { trackId } = req.body ?? {};

    if (!trackId || typeof trackId !== "string") {
      return res.status(400).json({ error: "trackId is required" });
    }
    if (playlistId === LIKED_SONGS_PLAYLIST_ID) {
      return res.status(400).json({ error: "Cannot add to Liked Songs" });
    }

    const [playlist, track] = await Promise.all([
      library.getPlaylist(playlistId),
      library.getTrack(trackId),
    ]);
    if (!playlist) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (!track) {
      return res.status(404).json({ error: "Track not found in library" });
    }

    try {
      const yt = new YouTubeService({ access_token: req.accessToken! });
      await yt.addVideoToPlaylist(playlistId, trackId);
    } catch (error) {
      console.error("Error adding track to YouTube playlist:", error);
      return sendYouTubeWriteError(
        res,
        error,
        "Failed to add track to playlist",
      );
    }

    await library.addTrackToPlaylist(playlistId, track);
    res.json({ success: true });
  }),
);

router.get(
  "/playlists/:id/analyze",
  withLibrary("Failed to analyze playlist", async (req, res, library) => {
    const playlistData = await library.getPlaylistData(req.params.id);
    if (!playlistData) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    const consistencyAnalysis = new PlaylistService(
      library,
    ).calculatePlaylistConsistency(
      playlistData.artists,
      playlistData.genres,
      playlistData.tracks.length,
      playlistData.tracks,
    );

    const analysis: PlaylistAnalysisResult = {
      ...playlistData,
      consistencyAnalysis,
    };
    res.json(analysis);
  }),
);

router.patch(
  "/playlists/:id/type",
  withLibrary("Failed to update playlist type", async (req, res, library) => {
    const { playlistType } = req.body ?? {};
    if (!isPlaylistType(playlistType)) {
      return res.status(400).json({
        error: "Invalid playlist type",
        validTypes: Object.values(PlaylistType),
      });
    }

    await library.updatePlaylistType(req.params.id, playlistType);
    res.json({ success: true, playlistType });
  }),
);

router.get(
  "/artists",
  withLibrary("Failed to fetch cached artists", async (_req, res, library) => {
    res.json(await library.getUserArtists());
  }),
);

router.get(
  "/artists/:id",
  withLibrary("Failed to fetch cached artist", async (req, res, library) => {
    const artist = await library.getArtist(req.params.id);
    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }
    res.json(artist);
  }),
);

router.get(
  "/artists/:id/tracks",
  withLibrary(
    "Failed to fetch cached artist tracks",
    async (req, res, library) => {
      res.json(await library.getArtistTracks(req.params.id));
    },
  ),
);

router.get(
  "/albums/:id",
  withLibrary("Failed to fetch album", async (req, res, library) => {
    const tracks = await library.getAlbumTracks(req.params.id);
    if (tracks.length === 0) {
      return res.status(404).json({ error: "Album not found" });
    }
    res.json(tracks[0].album);
  }),
);

router.get(
  "/albums/:id/tracks",
  withLibrary("Failed to fetch album tracks", async (req, res, library) => {
    res.json(await library.getAlbumTracks(req.params.id));
  }),
);

export { router as indexRouter };
