import type { Job } from "bullmq";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { PersistJobData, persistUserDataJob } from "../src/jobs/persistUserData";
import { redisClient } from "../src/redis";
import type { BullService } from "../src/services/BullService";
import { YouTubeService } from "../src/services/YouTubeService";
import { hasRedis, resetRedis } from "./helpers";
import { fakeYouTube, FakeLibrary, video } from "./youtubeFakes";

const USER = "UC_track";

// v1: liked + in Zeta and Alpha; v2: only Zeta; v9: only liked
const library = (): FakeLibrary => ({
  liked: [video("v1"), video("v9", "ch9")],
  playlists: [
    { id: "PLZ", title: "Zeta", videos: [video("v1"), video("v2", "ch2")] },
    { id: "PLA", title: "Alpha", videos: [video("v1")] },
  ],
});

const job = () =>
  ({
    id: "track-job",
    attemptsMade: 0,
    data: { userId: USER, accessToken: "tok", source: "yt-music" },
    updateProgress: async () => {},
  }) as unknown as Job<PersistJobData>;

describe.skipIf(!hasRedis)("GET /api/tracks/:id", () => {
  const app = createApp({ bullService: {} as BullService, cookieSecret: "s".repeat(40) });
  const get = (path: string) =>
    request(app).get(path).set("Cookie", ["youtube_access_token=tok"]);

  beforeEach(async () => {
    await resetRedis();
    await persistUserDataJob(job(), () => fakeYouTube(library()));
    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockResolvedValue({
      id: USER,
      title: "me",
      thumbnails: null,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await redisClient.quit();
  });

  it("returns the track, its playlists by name (without Liked Songs) and whether it's liked", async () => {
    const res = await get("/api/tracks/v1");
    expect(res.status).toBe(200);
    expect(res.body.track).toMatchObject({ id: "v1", name: "Song v1", artistIds: ["ch1"] });
    expect(res.body.playlists.map((p: { name: string }) => p.name)).toEqual(["Alpha", "Zeta"]);
    expect(res.body.liked).toBe(true);
  });

  it("handles tracks that are only liked, or not liked", async () => {
    const onlyLiked = await get("/api/tracks/v9");
    expect(onlyLiked.body).toMatchObject({ playlists: [], liked: true });

    const notLiked = await get("/api/tracks/v2");
    expect(notLiked.body.liked).toBe(false);
    expect(notLiked.body.playlists.map((p: { id: string }) => p.id)).toEqual(["PLZ"]);
  });

  it("returns 404 for a track that isn't in the library", async () => {
    expect((await get("/api/tracks/nope")).status).toBe(404);
  });

  it("doesn't shadow /tracks/saved or /tracks/aggregate", async () => {
    const saved = await get("/api/tracks/saved");
    expect(saved.status).toBe(200);
    expect(Array.isArray(saved.body)).toBe(true);
    expect(saved.body.map((t: { id: string }) => t.id)).toEqual(["v1", "v9"]);

    const aggregate = await get("/api/tracks/aggregate");
    expect(aggregate.status).toBe(200);
    expect(Array.isArray(aggregate.body)).toBe(true);
  });

  it("costs only a few Redis commands", async () => {
    await get("/api/tracks/v1"); // warm the snapshot cache, as a live server would be
    await redisClient.configResetStat();
    await get("/api/tracks/v1");
    const info = await redisClient.info("stats");
    const used = Number(/total_commands_processed:(\d+)/.exec(info)![1]) - 1;
    expect(used).toBeLessThanOrEqual(6);
  });
});
