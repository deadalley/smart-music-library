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
import { AuthService } from "../services";
import {
  YOUTUBE_READ_SCOPE,
  YOUTUBE_WRITE_SCOPE,
  YouTubeService,
} from "../services/YouTubeService";

const router: Router = Router();

const CLIENT_URL = process.env.CLIENT_URL || "http://127.0.0.1:5173";
const AUTH_STATE_COOKIE = "youtube_auth_state";

const loginErrorRedirect = (code: string) => `${CLIENT_URL}/login?error=${code}`;

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

  try {
    const authService = new AuthService();
    const tokens = await new YouTubeService().exchangeCode(code);

    if (!tokens.access_token) {
      return res.redirect(loginErrorRedirect("youtube_invalid_token"));
    }

    const yt = new YouTubeService({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
    });

    const grantedScopes = await yt.getGrantedScopes();
    const hasYouTubeScope =
      grantedScopes.includes(YOUTUBE_READ_SCOPE) ||
      grantedScopes.includes(YOUTUBE_WRITE_SCOPE);
    if (!hasYouTubeScope) {
      console.error("YouTube OAuth missing required scopes:", grantedScopes);
      return res.redirect(loginErrorRedirect("youtube_missing_scopes"));
    }

    const channel = await yt.getMyChannel();

    // Google only issues a refresh token on the first-ever grant (or a
    // forced re-consent) — a returning login won't include one in the
    // response. Fall back to whatever we already have on file so the
    // session can still be refreshed transparently later.
    const existingUser = await authService.getUser(channel.id);
    const refreshToken =
      tokens.refresh_token ?? existingUser?.refreshToken ?? undefined;

    await authService.saveYouTubeUser({
      id: channel.id,
      displayName: channel.title,
      refreshToken,
    });

    setAccessTokenCookie(res, tokens.access_token);
    if (refreshToken) setRefreshTokenCookie(res, refreshToken);
    setUserIdCookie(res, channel.id);
    // Legacy unsigned duplicate of the user id.
    res.clearCookie("user_id", baseCookieOptions);

    res.redirect(CLIENT_URL);
  } catch (err) {
    console.error("Error during YouTube token exchange:", err);
    res.redirect(loginErrorRedirect("youtube_invalid_token"));
  }
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
