import type { Job } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichReleaseDatesJob } from "../src/jobs/enrichReleaseDates";
import { PersistJobData, persistUserDataJob } from "../src/jobs/persistUserData";
import { redisClient } from "../src/redis";
import {
  cacheReleaseDate,
  getCachedReleaseDates,
  MusicBrainzService,
} from "../src/services/MusicBrainzService";
import { RedisService } from "../src/services/RedisService";
import { StatsService } from "../src/services/StatsService";
import { hasRedis, resetRedis } from "./helpers";
import { fakeYouTube, video } from "./youtubeFakes";

const USER = "UC_release";

describe("MusicBrainzService", () => {
  it("sends a scoped query with a User-Agent and picks the earliest match", async () => {
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          recordings: [
            {
              id: "1",
              score: 100,
              title: "Hotel California",
              "first-release-date": "1976-12-08",
              "artist-credit": [{ name: "Eagles" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const mb = new MusicBrainzService(fetchStub as unknown as typeof fetch, "TestAgent/1.0");

    await expect(mb.findReleaseDate("Eagles", 'Hotel "California"')).resolves.toBe("1976-12-08");
    await expect(mb.findReleaseDate("Eagles", "Hotel California")).resolves.toBe("1976-12-08");

    const [url, init] = fetchStub.mock.calls[1] as unknown as [string, RequestInit];
    const query = new URL(url).searchParams.get("query");
    expect(query).toBe('recording:"Hotel California" AND artist:"Eagles"');
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("TestAgent/1.0");
    // quotes are escaped for Lucene
    const [firstUrl] = fetchStub.mock.calls[0] as unknown as [string];
    expect(new URL(firstUrl).searchParams.get("query")).toContain('Hotel \\"California\\"');
  });

  it("does not retry client errors", async () => {
    const fetchStub = vi.fn(async () => new Response("bad", { status: 400 }));
    const mb = new MusicBrainzService(fetchStub as unknown as typeof fetch);
    await expect(mb.findReleaseDate("a", "b")).rejects.toThrow("HTTP 400");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

let jobCounter = 0;
const syncJob = () =>
  ({
    id: `rel-job${++jobCounter}`,
    attemptsMade: 0,
    data: { userId: USER, accessToken: "tok", source: "yt-music" },
    updateProgress: async () => {},
  }) as unknown as Job<PersistJobData>;

// t1: Topic track with a description date
// t2: music video, date only via MusicBrainz
// t3: music video already in the global cache
// t4: music video MusicBrainz doesn't know
const library = () => ({
  liked: [],
  playlists: [
    {
      id: "PL1",
      title: "Mix",
      videos: [
        { ...video("t1", "Eagles - Topic"), title: "Take It Easy", description: "Released on: 1972-05-01" },
        { ...video("t2", "EaglesVEVO"), title: "Eagles - Hotel California (Official Video)" },
        { ...video("t3", "QueenVEVO"), title: "Queen - Bohemian Rhapsody (Official Video)" },
        { ...video("t4", "nobody"), title: "Unknown jam" },
      ],
    },
  ],
});

describe.skipIf(!hasRedis)("release dates (Redis integration)", () => {
  beforeEach(async () => {
    jobCounter = 0;
    await resetRedis();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it("uses description and cached dates during sync, then looks up the rest", async () => {
    await cacheReleaseDate("t3", "1975-10-31");

    const onActivated = vi.fn(async () => {});
    await persistUserDataJob(syncJob(), () => fakeYouTube(library()), { onActivated });
    expect(onActivated).toHaveBeenCalledWith(USER);

    let lib = await RedisService.forUser(USER);
    const before = Object.fromEntries(
      (await lib.getPlaylistTracks("PL1")).map((t) => [t.id, t.album]),
    );
    expect(before.t1).toMatchObject({ releaseDate: "1972-05-01", releaseDateSource: "youtube" });
    expect(before.t2).toMatchObject({ releaseDate: "2015-06-01", releaseDateSource: "upload" });
    expect(before.t3).toMatchObject({ releaseDate: "1975-10-31", releaseDateSource: "musicbrainz" });

    // Pending flag drives the "looking up" state in stats.
    await lib.claimReleaseLookup(60);
    let stats = await new StatsService(lib).getLibraryStats();
    expect(stats.releaseDates).toEqual({
      fromYouTube: 1,
      fromMusicBrainz: 1,
      unknown: 2,
      lookupPending: true,
    });
    expect(stats.decades.map((d) => d.decade)).toEqual(["1970s"]);

    const findReleaseDate = vi.fn(async (artist: string, title: string) =>
      artist === "Eagles" && title === "Hotel California" ? "1976-12-08" : null,
    );
    const result = await enrichReleaseDatesJob(
      { data: { userId: USER, source: "yt-music" } },
      { musicBrainz: { findReleaseDate }, sleep: async () => {} },
    );

    // Only t2 and t4 needed a lookup (t1 has a description date, t3 was cached).
    expect(findReleaseDate.mock.calls.map((c) => c.join(" / ")).sort()).toEqual([
      "Eagles / Hotel California",
      "nobody / Unknown jam",
    ]);
    expect(result).toMatchObject({ lookedUp: 2, found: 1, remaining: 0 });

    lib = await RedisService.forUser(USER);
    const after = Object.fromEntries(
      (await lib.getPlaylistTracks("PL1")).map((t) => [t.id, t.album]),
    );
    expect(after.t2).toMatchObject({ releaseDate: "1976-12-08", releaseDateSource: "musicbrainz" });
    expect(after.t4.releaseDateSource).toBe("upload");

    // Hits and misses are cached globally for the next user / resync.
    const cache = await getCachedReleaseDates(["t2", "t4"]);
    expect(cache.get("t2")).toBe("1976-12-08");
    expect(cache.has("t4") && cache.get("t4")).toBeNull();

    stats = await new StatsService(lib).getLibraryStats();
    expect(stats.releaseDates.lookupPending).toBe(false);
    expect(stats.releaseDates.fromMusicBrainz).toBe(2);

    // A resync applies the cached result without looking it up again.
    await persistUserDataJob(syncJob(), () => fakeYouTube(library()));
    lib = await RedisService.forUser(USER);
    const resynced = (await lib.getPlaylistTracks("PL1")).find((t) => t.id === "t2");
    expect(resynced?.album.releaseDateSource).toBe("musicbrainz");
  });

  it("processes large libraries in batches and queues the next one", async () => {
    const videos = Array.from({ length: 55 }, (_, i) => ({
      ...video(`m${i}`, "SomeVEVO"),
      title: `Some - Song ${i}`,
    }));
    await persistUserDataJob(syncJob(), () =>
      fakeYouTube({ liked: [], playlists: [{ id: "PL", title: "Big", videos }] }),
    );

    const enqueueNext = vi.fn(async () => {});
    const result = await enrichReleaseDatesJob(
      { data: { userId: USER, source: "yt-music" } },
      { musicBrainz: { findReleaseDate: async () => null }, sleep: async () => {}, enqueueNext },
    );
    expect(result).toMatchObject({ lookedUp: 50, remaining: 5 });
    expect(enqueueNext).toHaveBeenCalledWith({ userId: USER, source: "yt-music" });

    const second = await enrichReleaseDatesJob(
      { data: { userId: USER, source: "yt-music" } },
      { musicBrainz: { findReleaseDate: async () => null }, sleep: async () => {}, enqueueNext },
    );
    expect(second).toMatchObject({ lookedUp: 5, remaining: 0 });
    expect(enqueueNext).toHaveBeenCalledTimes(1);
  });

  it("stops after repeated MusicBrainz failures and clears the pending flag", async () => {
    await persistUserDataJob(syncJob(), () => fakeYouTube(library()));
    const lib = await RedisService.forUser(USER);
    await lib.claimReleaseLookup(60);

    const many = Array.from({ length: 6 }, (_, i) => ({ ...video(`x${i}`, "V"), title: `A - B${i}` }));
    await persistUserDataJob(syncJob(), () =>
      fakeYouTube({ liked: [], playlists: [{ id: "PL", title: "x", videos: many }] }),
    );

    await expect(
      enrichReleaseDatesJob(
        { data: { userId: USER, source: "yt-music" } },
        {
          musicBrainz: { findReleaseDate: async () => { throw new Error("down"); } },
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/unavailable/);
    expect(await lib.isReleaseLookupPending()).toBe(false);
  });
});
