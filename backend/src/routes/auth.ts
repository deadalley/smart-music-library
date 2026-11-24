import crypto from "crypto";
import { Request, Response, Router } from "express";
import {
  baseCookieOptions,
  clearAuthCookies,
  refreshYouTubeAccessToken,
  requireAuth,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setUserIdCookie,
} from "../middleware/requireAuth";
import {
  getErrorReasons,
  getErrorStatus,
  isQuotaExhausted,
} from "../lib/retry";
import { AuthService } from "../services";
import {
  YOUTUBE_READ_SCOPE,
  YOUTUBE_WRITE_SCOPE,
  YouTubeService,
} from "../services/YouTubeService";

const router: Router = Router();

const CLIENT_URL = process.env.CLIENT_URL || "http://127.0.0.1:5173";
const AUTH_STATE_COOKIE = "youtube_auth_state";

const loginErrorRedirect = (code: string, reason?: string) =>
  `${CLIENT_URL}/login?${new URLSearchParams(
    reason ? { error: code, reason } : { error: code },
  )}`;

type LoginStep = "exchange" | "scopes" | "channel" | "storage";

/** Short, non-secret identifier of what Google (or Redis) said. */
function errorReason(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response
    ?.data;
  // OAuth token endpoint: { error: "invalid_grant", error_description }
  if (typeof data?.error === "string") return data.error.slice(0, 64);
  const [first] = getErrorReasons(err);
  if (first) return first.slice(0, 64);
  const status = getErrorStatus(err);
  if (status) return `http_${status}`;
  const message = err instanceof Error ? err.message : "";
  // Upstash's free plan rejects commands once its daily limit is reached.
  if (/max (daily )?requests? limit/i.test(message))
    return "redis_request_limit";
  const name = (err as { name?: string })?.name;
  return name && name !== "Error" ? name.slice(0, 64) : undefined;
}

/** Maps a failed login step to an error code the login page explains. */
export function classifyLoginFailure(
  step: LoginStep,
  err: unknown,
): { code: string; reason?: string } {
  const reason = errorReason(err);
  if (isQuotaExhausted(err)) {
    return { code: "youtube_quota_exceeded", reason };
  }
  switch (step) {
    case "exchange":
      return { code: "youtube_exchange_failed", reason };
    case "storage":
      return { code: "storage_unavailable", reason };
    case "scopes":
    case "channel":
      return { code: "youtube_channel_failed", reason };
  }
}

router.get("/youtube/login", (_req: Request, res: Response) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.redirect(loginErrorRedirect("youtube_not_configured"));
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(AUTH_STATE_COOKIE, state, {
    ...baseCookieOptions,
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  return res.redirect(YouTubeService.createAuthUrl(state));
});

router.get("/youtube/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const storedState = req.cookies?.[AUTH_STATE_COOKIE];

  if (error === "access_denied") {
    return res.redirect(loginErrorRedirect("youtube_missing_scopes"));
  }
  if (!code || typeof code !== "string") {
    return res.redirect(loginErrorRedirect("youtube_missing_code"));
  }
  if (!state || typeof state !== "string" || state !== storedState) {
    return res.redirect(loginErrorRedirect("youtube_state_mismatch"));
  }

  res.clearCookie(AUTH_STATE_COOKIE, baseCookieOptions);

  const authService = new AuthService();
  const fail = (step: LoginStep, err: unknown) => {
    const failure = classifyLoginFailure(step, err);
    // One line per failure, without tokens or the authorization code.
    console.error(
      `YouTube login failed at "${step}": code=${failure.code} reason=${failure.reason ?? "-"} status=${getErrorStatus(err) ?? "-"}`,
      err instanceof Error ? err.message : err,
    );
    return res.redirect(loginErrorRedirect(failure.code, failure.reason));
  };

  // 1. Exchange the authorization code for tokens.
  let tokens: Awaited<ReturnType<YouTubeService["exchangeCode"]>>;
  try {
    tokens = await new YouTubeService().exchangeCode(code);
  } catch (err) {
    return fail("exchange", err);
  }
  if (!tokens.access_token) {
    return res.redirect(loginErrorRedirect("youtube_invalid_token"));
  }

  const yt = new YouTubeService({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
  });

  // 2. Make sure YouTube access was actually granted.
  let grantedScopes: string[];
  try {
    grantedScopes = await yt.getGrantedScopes();
  } catch (err) {
    return fail("scopes", err);
  }
  const hasYouTubeScope =
    grantedScopes.includes(YOUTUBE_READ_SCOPE) ||
    grantedScopes.includes(YOUTUBE_WRITE_SCOPE);
  if (!hasYouTubeScope) {
    console.error("YouTube OAuth missing required scopes:", grantedScopes);
    return res.redirect(loginErrorRedirect("youtube_missing_scopes"));
  }

  // 3. Identify the user (YouTube channel). Costs YouTube API quota.
  let channel: Awaited<ReturnType<YouTubeService["getMyChannel"]>>;
  try {
    channel = await yt.getMyChannel();
  } catch (err) {
    return fail("channel", err);
  }

  // 4. Store the user. Google only issues a refresh token on the
  // first-ever grant (or a forced re-consent) — a returning login won't
  // include one — so fall back to the one already on file.
  let refreshToken: string | undefined;
  try {
    const existingUser = await authService.getUser(channel.id);
    refreshToken =
      tokens.refresh_token ?? existingUser?.refreshToken ?? undefined;
    await authService.saveYouTubeUser({
      id: channel.id,
      displayName: channel.title,
      refreshToken,
    });
  } catch (err) {
    return fail("storage", err);
  }

  setAccessTokenCookie(res, tokens.access_token);
  if (refreshToken) setRefreshTokenCookie(res, refreshToken);
  setUserIdCookie(res, channel.id);
  // Legacy unsigned duplicate of the user id.
  res.clearCookie("user_id", baseCookieOptions);

  res.redirect(CLIENT_URL);
});

router.post("/youtube/refresh", async (req: Request, res: Response) => {
  const accessToken = await refreshYouTubeAccessToken(req, res);
  if (!accessToken) {
    return res.status(401).json({ error: "Failed to refresh token" });
  }
  res.json({ success: true });
});

router.post("/youtube/logout", (_req: Request, res: Response) => {
  clearAuthCookies(res);
  res.json({ success: true });
});

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const user = await new AuthService().getUser(userId);
    res.json({ id: userId, display_name: user?.displayName ?? userId });
  } catch (err) {
    console.error("Error fetching user data:", err);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

export { router as authRouter };
