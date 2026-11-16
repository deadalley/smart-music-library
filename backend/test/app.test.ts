import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { redisClient } from "../src/redis";
import type { BullService } from "../src/services/BullService";
import { RedisService } from "../src/services/RedisService";
import { YouTubeService } from "../src/services/YouTubeService";
import { hasRedis, resetRedis } from "./helpers";

const SECRET = "x".repeat(40);

function makeApp() {
  const bullStub = {
    getActiveJob: async () => null,
    getLastJobStatus: async () => null,
  } as unknown as BullService;
  return createApp({ bullService: bullStub, cookieSecret: SECRET });
}

describe.skipIf(!hasRedis)("HTTP app (Redis integration)", () => {
  beforeEach(async () => {
    await resetRedis();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it("serves an unauthenticated health check", async () => {
    const res = await request(makeApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects requests without a token", async () => {
    const res = await request(makeApp()).get("/api/tracks");
    expect(res.status).toBe(401);
  });

  it("ignores a forged (unsigned) user id cookie and resolves the user from the token", async () => {
    const channelSpy = vi
      .spyOn(YouTubeService.prototype, "getMyChannel")
      .mockResolvedValue({ id: "UC_attacker", title: "me", thumbnails: null });

    const victim = new RedisService("UC_victim", null);
    await victim.storeArtists([
      {
        id: "secret-artist",
        name: "Victim's artist",
        images: [],
        externalUrls: { spotify: "" },
        trackCount: 0,
        genres: [],
      },
    ]);

    const res = await request(makeApp())
      .get("/api/artists")
      .set("Cookie", [
        "youtube_access_token=attacker-token",
        "youtube_user_id=UC_victim",
      ]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(channelSpy).toHaveBeenCalledTimes(1);

    // The re-issued cookie is signed for the token's real owner.
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const userCookie = setCookie.find((c) => c.startsWith("youtube_user_id="));
    expect(decodeURIComponent(userCookie!)).toContain("s:UC_attacker.");
  });

  it("trusts a valid signed cookie without calling YouTube", async () => {
    const channelSpy = vi
      .spyOn(YouTubeService.prototype, "getMyChannel")
      .mockResolvedValue({ id: "UC_me", title: "me", thumbnails: null });

    const app = makeApp();
    const first = await request(app)
      .get("/api/artists")
      .set("Cookie", ["youtube_access_token=tok"]);
    const signed = ([] as string[])
      .concat(first.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith("youtube_user_id="))!
      .split(";")[0];

    channelSpy.mockClear();
    const second = await request(app)
      .get("/api/artists")
      .set("Cookie", ["youtube_access_token=tok", signed]);

    expect(second.status).toBe(200);
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("requires a CSRF token on mutations", async () => {
    const res = await request(makeApp())
      .patch("/api/tracks/v1/ownership")
      .set("Cookie", ["youtube_access_token=tok", "csrf_token=abc"])
      .send({ ownership: "owned" });
    expect(res.status).toBe(403);
  });

  it("validates ownership updates and stores them as annotations", async () => {
    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockResolvedValue({
      id: "UC_me",
      title: "me",
      thumbnails: null,
    });
    const cookies = ["youtube_access_token=tok", "csrf_token=abc"];

    const bad = await request(makeApp())
      .patch("/api/tracks/v1/ownership")
      .set("Cookie", cookies)
      .set("X-CSRF-Token", "abc")
      .send({ ownership: "stolen" });
    expect(bad.status).toBe(400);

    const ok = await request(makeApp())
      .patch("/api/tracks/v1/ownership")
      .set("Cookie", cookies)
      .set("X-CSRF-Token", "abc")
      .send({ ownership: "owned" });
    expect(ok.status).toBe(200);
    expect(
      await redisClient.hGet("smart-spotify:UC_me:yt-music:annotations:ownership", "v1"),
    ).toBe("owned");
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const res = await request(makeApp())
      .post("/api/tracks/playlist-memberships")
      .set("Cookie", ["youtube_access_token=tok", "csrf_token=abc"])
      .set("X-CSRF-Token", "abc")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
  });
});
