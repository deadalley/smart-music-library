import { Request, Response, Router } from "express";
import {
  REFRESH_TOKEN_COOKIE,
  requireAuth,
} from "../middleware/requireAuth";
import { BullService, RedisService } from "../services";

export function createPersistRouter(bullService: BullService): Router {
  const router: Router = Router();
  router.use(requireAuth);

  router.post("/", async (req: Request, res: Response) => {
    try {
      const { jobId, alreadyRunning } = await bullService.startPersistJob(
        req.userId!,
        req.accessToken!,
        req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined,
      );

      res.json({
        success: true,
        message: alreadyRunning
          ? "Persist job is already running"
          : "Persist job started successfully",
        jobId,
        status: alreadyRunning ? "active" : "started",
      });
    } catch (error) {
      console.error("Error starting persist job:", error);
      res.status(500).json({ error: "Failed to start sync" });
    }
  });

  router.get("/status", async (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const library = await RedisService.forUser(userId);

      const [meta, lastSyncedAtMarker, activeJobId, lastJob] =
        await Promise.all([
          library.getSyncMeta(),
          library.getLastSyncedAt(),
          bullService.getActiveJob(userId),
          bullService.getLastJobStatus(userId),
        ]);

      // Libraries stored in the old per-key format count as "needs a sync".
      const hasData = !!meta?.lastSync && !!meta.hasSnapshot;
      // The marker key has no TTL, so it survives after the rest of a
      // user's library data auto-expires — letting us tell "never synced"
      // apart from "synced before, but the cache has since expired".
      const dataExpired = !hasData && !!lastSyncedAtMarker;
      const lastSyncedAt = meta?.lastSync || lastSyncedAtMarker || undefined;

      const base = {
        success: true,
        hasData,
        dataExpired,
        lastSync: meta?.lastSync,
        lastSyncedAt,
        stats: meta
          ? {
              playlists: meta.playlistCount,
              tracks: meta.trackCount,
              artists: meta.artistCount,
              skippedPlaylists: meta.skippedPlaylists,
            }
          : undefined,
        // Outcome of the most recent sync (completed / failed + error), so
        // the client can tell success from failure once nothing is active.
        lastJob: lastJob
          ? {
              jobId: lastJob.jobId,
              status: lastJob.status,
              error: lastJob.error,
              completedAt: lastJob.completedAt,
            }
          : undefined,
      };

      if (!activeJobId) {
        return res.json({
          ...base,
          hasActiveJob: false,
          message: "No active persist job found",
        });
      }

      const jobStatus = await bullService.getJobStatus(activeJobId);
      res.json({
        ...base,
        hasActiveJob: true,
        jobId: activeJobId,
        ...jobStatus,
      });
    } catch (error) {
      console.error("Error getting sync status:", error);
      res.status(500).json({ error: "Failed to get sync status" });
    }
  });

  router.delete("/", async (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      if (await bullService.getActiveJob(userId)) {
        return res.status(409).json({
          error: "Cannot delete data while sync is in progress",
        });
      }

      await RedisService.deleteAllUserData(userId);

      res.json({ success: true, message: "User data deleted successfully" });
    } catch (error) {
      console.error("Error deleting user data:", error);
      res.status(500).json({ error: "Failed to delete user data" });
    }
  });

  return router;
}
