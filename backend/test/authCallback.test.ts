import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { redisClient } from "../src/redis";
import { AuthService } from "../src/services/AuthService";
import type { BullService } from "../src/services/BullService";
import {
  YOUTUBE_READ_SCOPE,
  YouTubeService,
} from "../src/services/YouTubeService";
import { hasRedis, resetRedis } from "./helpers";

const app = () =>
  createApp({ bullService: {} as BullService, cookieSecret: "s".repeat(40) });

/** Starts a login to get a valid state cookie, then hits the callback. */
async function callback() {
  const agent = request.agent(app());
  const login = await agent.get("/api/auth/youtube/login");
  expect(login.status).toBe(302);
  const state = new URL(login.headers.location).searchParams.get("state")!;
  return agent.get(`/api/auth/youtube/callback?code=abc&state=${state}`);
}

const errorFrom = (res: request.Response) =>
  Object.fromEntries(new URL(res.headers.location).searchParams);

const googleTokenError = (error: string) =>
  Object.assign(new Error(error), {
    response: { status: 400, data: { error, error_description: "Bad Request" } },
  });

const youtubeApiError = (status: number, reason: string) =>
  Object.assign(new Error(reason), {
    response: { status, data: { error: { code: status, errors: [{ reason }] } } },
  });

function mockHappyGoogle() {
  vi.spyOn(YouTubeService.prototype, "exchangeCode").mockResolvedValue({
    access_token: "at",
    refresh_token: "rt",
    expiry_date: Date.now() + 3600_000,
  });
  vi.spyOn(YouTubeService.prototype, "getGrantedScopes").mockResolvedValue([
    YOUTUBE_READ_SCOPE,
  ]);
  vi.spyOn(YouTubeService.prototype, "getMyChannel").mockResolvedValue({
    id: "UC_login",
    title: "Me",
    thumbnails: null,
  });
}

describe("YouTube login callback", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a rejected code exchange with Google's error code", async () => {
    vi.spyOn(YouTubeService.prototype, "exchangeCode").mockRejectedValue(
      googleTokenError("invalid_grant"),
    );
    const res = await callback();
    expect(res.status).toBe(302);
    expect(errorFrom(res)).toEqual({
      error: "youtube_exchange_failed",
      reason: "invalid_grant",
    });
  });

  it("reports a spent YouTube API quota", async () => {
    mockHappyGoogle();
    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockRejectedValue(
      youtubeApiError(403, "quotaExceeded"),
    );
    expect(errorFrom(await callback())).toEqual({
      error: "youtube_quota_exceeded",
      reason: "quotaExceeded",
    });
  });

  it("reports other channel lookup failures", async () => {
    mockHappyGoogle();
    vi.spyOn(YouTubeService.prototype, "getMyChannel").mockRejectedValue(
      youtubeApiError(500, "backendError"),
    );
    expect(errorFrom(await callback())).toEqual({
      error: "youtube_channel_failed",
      reason: "backendError",
    });
  });

  it("reports storage failures, including Upstash's request limit", async () => {
    mockHappyGoogle();
    vi.spyOn(AuthService.prototype, "getUser").mockRejectedValue(
      new Error("ERR max daily request limit exceeded. Limit: 10000, Usage: 10000"),
    );
    expect(errorFrom(await callback())).toEqual({
      error: "storage_unavailable",
      reason: "redis_request_limit",
    });
  });

  it("never puts tokens or the authorization code in the redirect", async () => {
    vi.spyOn(YouTubeService.prototype, "exchangeCode").mockRejectedValue(
      googleTokenError("invalid_client"),
    );
    const res = await callback();
    expect(res.headers.location).not.toContain("abc");
  });
});

describe.skipIf(!hasRedis)("YouTube login callback (Redis integration)", () => {
  beforeEach(resetRedis);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await redisClient.quit();
  });

  it("logs in: stores the user, sets the session cookies, redirects to the app", async () => {
    mockHappyGoogle();
    const res = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("error=");

    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.some((c) => c.startsWith("youtube_access_token=at"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("youtube_refresh_token=rt"))).toBe(true);
    expect(cookies.some((c) => decodeURIComponent(c).startsWith("youtube_user_id=s:UC_login."))).toBe(true);

    const user = await new AuthService().getUser("UC_login");
    expect(user).toMatchObject({ displayName: "Me", refreshToken: "rt" });
  });
});
