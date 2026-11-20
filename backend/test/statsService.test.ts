import { TrackOwnership, PlaylistType } from "@smart-music-library/shared";
import type { Job } from "bullmq";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { PersistJobData, persistUserDataJob } from "../src/jobs/persistUserData";
import { redisClient } from "../src/redis";
import type { BullService } from "../src/services/BullService";
import { RedisService } from "../src/services/RedisService";
import { computeTrackStats, StatsService } from "../src/services/StatsService";
import { YouTubeService } from "../src/services/YouTubeService";
import { makeTrack } from "./fixtures";
import { hasRedis, resetRedis } from "./helpers";
import { fakeYouTube, FakeLibrary, video } from "./youtubeFakes";

const withYear = (id: string, year: number, extra = {}) =>
  makeTrack(id, {
    album: {
      id: `al-${id}`,
      name: "",
      type: "album",
      releaseDate: `${year}-01-01`,
      releaseDateSource: "youtube",
    },
    ...extra,
  });

describe("computeTrackStats", () => {
  it("returns zeros (no NaN) for an empty list", () => {
    const stats = computeTrackStats([]);
    expect(stats).toMatchObject({
      trackCount: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      longestTrack: null,
      shortestTrack: null,
      uniqueArtistCount: 0,
      topArtists: [],
      decades: [],
      mostViewed: [],
      ownership: { owned: 0, wishlist: 0, notOwned: 0, ownedShare: 0 },
    });
  });

  it("computes durations, ownership, decades and artist shares", () => {
    const tracks = [
      withYear("t1", 1994, { durationMs: 100_000, ownership: TrackOwnership.OWNED, popularity: 5 }),
      withYear("t2", 1999, { durationMs: 300_000, ownership: TrackOwnership.WISHLIST, popularity: 50 }),
      withYear("t3", 2011, {
        durationMs: 200_000,
        artistIds: ["a2"],
        artistNames: ["Artist Two"],
      }),
      makeTrack("t4", {
        durationMs: 0,
        // upload date only: excluded from decades
        album: { id: "x", name: "", type: "youtube", releaseDate: "2016-01-01", releaseDateSource: "upload" },
      }),
      // duplicate id is ignored
      withYear("t1", 1994, { durationMs: 100_000 }),
    ];

    const stats = computeTrackStats(tracks);
    expect(stats.trackCount).toBe(4);
    expect(stats.totalDurationMs).toBe(600_000);
    expect(stats.averageDurationMs).toBe(150_000);
    expect(stats.longestTrack?.id).toBe("t2");
    expect(stats.shortestTrack?.id).toBe("t1"); // zero-length tracks ignored
    expect(stats.ownership).toEqual({ owned: 1, wishlist: 1, notOwned: 2, ownedShare: 0.25 });
    expect(stats.decades).toEqual([
      { decade: "1990s", count: 2, share: 2 / 3 },
      { decade: "2010s", count: 1, share: 1 / 3 },
    ]);
    expect(stats.topArtists.map((a) => [a.artist.id, a.trackCount])).toEqual([
      ["a1", 3],
      ["a2", 1],
    ]);
    expect(stats.topArtists[0].share).toBe(0.75);
    expect(stats.mostViewed.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(stats.releaseDates).toEqual({
      fromYouTube: 3,
      fromMusicBrainz: 0,
      unknown: 1,
      lookupPending: false,
    });
  });
});

const USER = "UC_stats";
let jobCounter = 0;
function fakeJob(): Job<PersistJobData> {
  jobCounter += 1;
  return {
    id: `stats-job${jobCounter}`,
    attemptsMade: 0,
    data: { userId: USER, accessToken: "tok", source: "yt-music" },
    updateProgress: async () => {},
  } as unknown as Job<PersistJobData>;
}

// liked: v1 (in PL1 + PL2), v9 (in no playlist)
// PL1: v1, v2, v3 ; PL2: v1, v2 ; PL3: v4
const library = (): FakeLibrary => ({
  liked: [video("v1"), video("v9", "ch9")],
  playlists: [
    { id: "PL1", title: "One", videos: [video("v1"), video("v2", "ch2"), video("v3", "ch2")] },
    { id: "PL2", title: "Two", videos: [video("v1"), video("v2", "ch2")] },
    { id: "PL3", title: "Three", videos: [video("v4", "ch3")] },
  ],
});

describe.skipIf(!hasRedis)("StatsService (Redis integration)", () => {
  beforeEach(async () => {
    jobCounter = 0;
    await resetRedis();
    vi.restoreAllMocks();
    await persistUserDataJob(fakeJob(), () => fakeYouTube(library()));
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it("computes library-wide organization stats", async () => {
    const lib = await RedisService.forUser(USER);
    await lib.updatePlaylistType("PL1", PlaylistType.MOOD);
    await lib.updateTrackOwnership("v2", TrackOwnership.OWNED);

    const stats = await new StatsService(lib).getLibraryStats();
    expect(stats).toMatchObject({
      trackCount: 5,
      playlistCount: 3,
      likedCount: 2,
      unsortedLikedCount: 1, // v9
      multiPlaylistTrackCount: 2, // v1, v2
      averagePlaylistTrackCount: 2, // (3 + 2 + 1) / 3
      artistCount: 4,
    });
    expect(stats.ownership.owned).toBe(1);
    expect(stats.playlistsByType).toEqual([
      { type: "mood", count: 1 },
      { type: "untyped", count: 2 },
    ]);
    expect(stats.largestPlaylists.map((r) => r.playlist.id)).toEqual(["PL1", "PL2", "PL3"]);
    expect(stats.lastSync).toBeTruthy();
  });

  it("computes per-playlist liked share and overlaps", async () => {
    const lib = await RedisService.forUser(USER);
    const stats = await new StatsService(lib).getPlaylistStats("PL1");

    expect(stats).not.toBeNull();
    expect(stats!.trackCount).toBe(3);
    expect(stats!.likedCount).toBe(1);
    expect(stats!.likedShare).toBeCloseTo(1 / 3);
    expect(stats!.overlaps).toEqual([
      expect.objectContaining({ sharedCount: 2, share: 2 / 3, playlist: expect.objectContaining({ id: "PL2" }) }),
    ]);
    expect(await new StatsService(lib).getPlaylistStats("missing")).toBeNull();
  });

  it("serves the stats endpoints", async () => {
    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockResolvedValue({
      id: USER,
      title: "me",
      thumbnails: null,
    });
    const app = createApp({
      bullService: {} as BullService,
      cookieSecret: "s".repeat(40),
    });
    const cookies = ["youtube_access_token=tok"];

    const library = await request(app).get("/api/stats").set("Cookie", cookies);
    expect(library.status).toBe(200);
    expect(library.body.trackCount).toBe(5);

    const playlist = await request(app).get("/api/playlists/PL2/stats").set("Cookie", cookies);
    expect(playlist.status).toBe(200);
    expect(playlist.body.trackCount).toBe(2);

    const missing = await request(app).get("/api/playlists/nope/stats").set("Cookie", cookies);
    expect(missing.status).toBe(404);
  });
});
