import { TrackOwnership, PlaylistType } from "@smart-music-library/shared";
import type { Job } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PersistJobData,
  persistUserDataJob,
} from "../src/jobs/persistUserData";
import { redisClient } from "../src/redis";
import { RedisService } from "../src/services/RedisService";
import { hasRedis, keysMatching, resetRedis } from "./helpers";
import { fakeYouTube, FakeLibrary, video } from "./youtubeFakes";

const USER = "UC_user";
const ROOT = `smart-spotify:${USER}:yt-music`;

let jobCounter = 0;
function fakeJob(): Job<PersistJobData> {
  jobCounter += 1;
  return {
    id: `job${jobCounter}`,
    attemptsMade: 0,
    data: { userId: USER, accessToken: "tok", source: "yt-music" },
    updateProgress: async () => {},
  } as unknown as Job<PersistJobData>;
}

const baseLibrary = (): FakeLibrary => ({
  liked: [video("v1"), video("vlog", "ch9", "22")],
  playlists: [
    { id: "PL1", title: "Mix", videos: [video("v1"), video("v2", "ch2")] },
    { id: "PL2", title: "Vlogs", videos: [video("x1", "ch3", "22")] },
  ],
});

describe.skipIf(!hasRedis)("sync job (Redis integration)", () => {
  beforeEach(async () => {
    jobCounter = 0;
    await resetRedis();
  });
  afterAll(async () => {
    await redisClient.quit();
  });

  it("builds the library, liked songs included, and filters non-music", async () => {
    const yt = fakeYouTube(baseLibrary());
    const result = await persistUserDataJob(fakeJob(), () => yt);

    expect(result).toMatchObject({
      playlistCount: 2, // liked-songs + PL1 (PL2 is not music)
      trackCount: 2,
      skippedPlaylists: 0,
    });

    const library = await RedisService.forUser(USER);
    expect(library.generation).toBe("job1-0");
    expect((await library.getPlaylistTracks("liked-songs")).map((t) => t.id)).toEqual(["v1"]);
    expect((await library.getPlaylistTracks("PL1")).map((t) => t.id)).toEqual(["v1", "v2"]);
    expect((await library.getUserPlaylists()).map((p) => p.id).sort()).toEqual([
      "PL1",
      "liked-songs",
    ]);
    expect((await library.getSyncMeta())?.trackCount).toBe(2);

    // v1 is already known from liked songs, so PL1 doesn't look it up again.
    const lookups = (yt as unknown as { videoLookups: string[][] }).videoLookups.flat();
    expect(lookups.filter((id) => id === "v1")).toHaveLength(0);
  });

  it("keeps wishlist marks and playlist types across a resync and drops the old generation", async () => {
    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));
    let library = await RedisService.forUser(USER);
    await library.updateTrackOwnership("v2", TrackOwnership.WISHLIST);
    await library.updatePlaylistType("PL1", PlaylistType.MOOD);

    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));
    library = await RedisService.forUser(USER);

    expect(library.generation).toBe("job2-0");
    const tracks = await library.getPlaylistTracks("PL1");
    expect(tracks.find((t) => t.id === "v2")?.ownership).toBe(TrackOwnership.WISHLIST);
    expect((await library.getPlaylist("PL1"))?.playlistType).toBe(PlaylistType.MOOD);
    expect(await keysMatching(`${ROOT}:g:job1-0:*`)).toEqual([]);
  });

  it("leaves the previous library live and removes partial data when a sync fails", async () => {
    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));

    const failing = { ...baseLibrary(), failChannels: true };
    await expect(
      persistUserDataJob(fakeJob(), () => fakeYouTube(failing)),
    ).rejects.toThrow(/Persist job failed/);

    const library = await RedisService.forUser(USER);
    expect(library.generation).toBe("job1-0");
    expect(await library.getPlaylistTracks("PL1")).toHaveLength(2);
    expect(await keysMatching(`${ROOT}:g:job2-0:*`)).toEqual([]);
  });

  it("skips playlists that can't be read instead of failing the sync", async () => {
    const lib = {
      ...baseLibrary(),
      failPlaylist: { id: "PL2", status: 404 },
    };
    const result = await persistUserDataJob(fakeJob(), () => fakeYouTube(lib));
    expect(result.skippedPlaylists).toBe(1);
    const library = await RedisService.forUser(USER);
    expect((await library.getSyncMeta())?.skippedPlaylists).toBe(1);
  });

  it("migrates annotations from legacy (pre-generation) data and removes it", async () => {
    // Data shaped like the old layout: no current-gen pointer, annotations
    // stored inside the track/playlist hashes.
    await redisClient
      .multi()
      .hSet(`${ROOT}:track:v2`, { id: "v2", name: "Old", ownership: "owned" })
      .sAdd(`${ROOT}:tracks-index`, "v2")
      .hSet(`${ROOT}:playlist:PL1`, { id: "PL1", name: "Mix", playlistType: "genre" })
      .sAdd(`${ROOT}:playlists-index`, "PL1")
      .set(`${ROOT}:lastSyncedAt`, "2024-01-01T00:00:00Z")
      .exec();

    const legacy = await RedisService.forUser(USER);
    expect(legacy.generation).toBeNull();
    expect((await legacy.getUserTracks())[0].ownership).toBe(TrackOwnership.OWNED);

    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));

    const library = await RedisService.forUser(USER);
    const v2 = (await library.getPlaylistTracks("PL1")).find((t) => t.id === "v2");
    expect(v2?.ownership).toBe(TrackOwnership.OWNED);
    expect((await library.getPlaylist("PL1"))?.playlistType).toBe(PlaylistType.GENRE);
    expect(await redisClient.exists(`${ROOT}:track:v2`)).toBe(0);
    expect(await redisClient.exists(`${ROOT}:tracks-index`)).toBe(0);
  });

  it("keeps the album and playlist indexes consistent on add/remove", async () => {
    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));
    const library = await RedisService.forUser(USER);

    const v2 = (await library.getTrack("v2"))!;
    await library.addTrackToPlaylist("liked-songs", v2);
    await library.addTrackToPlaylist("liked-songs", v2); // idempotent
    expect((await library.getPlaylistTracks("liked-songs")).map((t) => t.id)).toEqual(["v1", "v2"]);
    expect((await library.getTrackPlaylistMemberships(["v2"])).v2.sort()).toEqual([
      "PL1",
      "liked-songs",
    ]);

    await library.removeTrackFromPlaylist("PL1", "v2");
    await library.removeTrackFromPlaylist("liked-songs", "v2");
    expect(await library.getTrack("v2")).toBeNull();
    expect(await library.getAlbumTracks(v2.album.id)).toEqual([]);
    expect((await library.getArtistTracks("ch2")).map((t) => t.id)).toEqual([]);
    expect(
      await redisClient.sIsMember(`${ROOT}:g:${library.generation}:artist:ch2:playlists`, "PL1"),
    ).toBe(false);
    // ch1 still has v1 in PL1, so that link stays.
    expect(
      await redisClient.sIsMember(`${ROOT}:g:${library.generation}:artist:ch1:playlists`, "PL1"),
    ).toBe(true);
  });

  it("deleteAllUserData removes everything including annotations", async () => {
    await persistUserDataJob(fakeJob(), () => fakeYouTube(baseLibrary()));
    const library = await RedisService.forUser(USER);
    await library.updateTrackOwnership("v1", TrackOwnership.OWNED);

    await RedisService.deleteAllUserData(USER);
    expect(await keysMatching(`${ROOT}:*`)).toEqual([]);
  });
});
