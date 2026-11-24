import type { Job } from "bullmq";
import { randomBytes } from "crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { PersistJobData, persistUserDataJob } from "../src/jobs/persistUserData";
import { redisClient } from "../src/redis";
import type { BullService } from "../src/services/BullService";
import { RedisService, SNAPSHOT_CHUNK_BYTES } from "../src/services/RedisService";
import { StatsService } from "../src/services/StatsService";
import { YouTubeService } from "../src/services/YouTubeService";
import { makeTrack } from "./fixtures";
import { hasRedis, keysMatching, resetRedis } from "./helpers";
import { fakeYouTube, FakeLibrary, video } from "./youtubeFakes";

const USER = "UC_budget";
const ROOT = `smart-spotify:${USER}:yt-music`;

/** Redis commands executed by `fn` (server-side count). */
async function commandsUsed(fn: () => Promise<unknown>): Promise<number> {
  await redisClient.configResetStat();
  await fn();
  const info = await redisClient.info("stats");
  // Minus the INFO call itself.
  return Number(/total_commands_processed:(\d+)/.exec(info)![1]) - 1;
}

let jobCounter = 0;
const job = () =>
  ({
    id: `budget-job${++jobCounter}`,
    attemptsMade: 0,
    data: { userId: USER, accessToken: "tok", source: "yt-music" },
    updateProgress: async () => {},
  }) as unknown as Job<PersistJobData>;

// 300 tracks across 10 playlists, many shared: big enough that per-track
// storage would cost thousands of commands.
const library = (): FakeLibrary => {
  const videos = Array.from({ length: 300 }, (_, i) => video(`v${i}`, `ch${i % 25}`));
  return {
    liked: videos.slice(0, 60),
    playlists: Array.from({ length: 10 }, (_, p) => ({
      id: `PL${p}`,
      title: `Playlist ${p}`,
      videos: videos.filter((_, i) => i % 10 === p || i % 7 === p),
    })),
  };
};

describe.skipIf(!hasRedis)("Redis command budget", () => {
  beforeEach(async () => {
    jobCounter = 0;
    await resetRedis();
  });
  afterAll(async () => {
    await redisClient.quit();
  });

  it("a full sync writes the library in a few dozen commands", async () => {
    const used = await commandsUsed(() =>
      persistUserDataJob(job(), () => fakeYouTube(library())),
    );
    expect(used).toBeLessThanOrEqual(60);
  });

  it("a Statistics page view costs a handful of commands", async () => {
    await persistUserDataJob(job(), () => fakeYouTube(library()));
    const view = async () =>
      new StatsService(await RedisService.forUser(USER)).getLibraryStats();

    const warm = await commandsUsed(view); // snapshot cached by the sync
    expect(warm).toBeLessThanOrEqual(6);

    // Another process wrote the library: the cache is stale and reloads.
    await redisClient.set(`${ROOT}:g:budget-job1-0:snapshot`, `other-rev:1`);
    const cold = await commandsUsed(view);
    expect(cold).toBeLessThanOrEqual(10);
    expect((await view()).trackCount).toBe(300);
  });

  it("a playlist page (playlist + tracks + stats) stays small", async () => {
    await persistUserDataJob(job(), () => fakeYouTube(library()));
    const used = await commandsUsed(async () => {
      const lib = await RedisService.forUser(USER);
      await lib.getPlaylist("PL1");
      await lib.getPlaylistTracks("PL1");
      await new StatsService(lib).getPlaylistStats("PL1");
    });
    expect(used).toBeLessThanOrEqual(12);
  });

  it("splits large snapshots into chunks and reads them back", async () => {
    // Random names barely compress, forcing more than one chunk.
    const tracks = Array.from({ length: 10_000 }, (_, i) =>
      makeTrack(`t${i}`, {
        name: randomBytes(150).toString("base64"),
        artistIds: [`a${i % 50}`],
      }),
    );
    const lib = new RedisService(USER, "big", "yt-music");
    await lib.storeTracks("PL", tracks);

    const chunks = await keysMatching(`${ROOT}:g:big:snapshot:*`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const key of chunks) {
      expect(await redisClient.strLen(key)).toBeLessThanOrEqual(SNAPSHOT_CHUNK_BYTES);
    }

    // Force a reload from Redis rather than the in-process cache.
    await redisClient.set(
      `${ROOT}:g:big:snapshot`,
      `forced-reload:${chunks.length}`,
    );
    const fresh = new RedisService(USER, "big", "yt-music");
    expect(await fresh.getPlaylistTracks("PL")).toHaveLength(10_000);
  });

  it("treats a library in the old per-key format as needing a sync", async () => {
    // Old format: generation pointer + meta, but per-entity keys, no snapshot.
    await redisClient
      .multi()
      .set(`${ROOT}:current-gen`, "old")
      .hSet(`${ROOT}:g:old:meta`, { lastSync: "2026-01-01T00:00:00Z", trackCount: "1" })
      .hSet(`${ROOT}:g:old:track:v1`, { id: "v1", name: "Old" })
      .set(`${ROOT}:lastSyncedAt`, "2026-01-01T00:00:00Z")
      .exec();

    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockResolvedValue({
      id: USER,
      title: "me",
      thumbnails: null,
    });
    const bullStub = {
      getActiveJob: async () => null,
      getLastJobStatus: async () => null,
    } as unknown as BullService;
    const status = await request(createApp({ bullService: bullStub, cookieSecret: "s".repeat(40) }))
      .get("/api/persist/status")
      .set("Cookie", ["youtube_access_token=tok"]);
    expect(status.body).toMatchObject({ hasData: false, dataExpired: true });
    vi.restoreAllMocks();

    // The resync replaces it and cleans up the old keys.
    await persistUserDataJob(job(), () => fakeYouTube(library()));
    expect(await keysMatching(`${ROOT}:g:old:*`)).toEqual([]);
    expect((await (await RedisService.forUser(USER)).getUserTracks()).length).toBe(300);
  });
});
