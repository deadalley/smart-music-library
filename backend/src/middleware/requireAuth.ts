import { CookieOptions, NextFunction, Request, Response } from "express";
import { YouTubeService } from "../services";

const isProduction = process.env.NODE_ENV === "production";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
};

export const USER_ID_COOKIE = "youtube_user_id";
export const ACCESS_TOKEN_COOKIE = "youtube_access_token";
export const REFRESH_TOKEN_COOKIE = "youtube_refresh_token";

/**
 * The user id cookie is signed (see COOKIE_SECRET in server.ts). Without a
 * signature a caller could pair their own valid access token with someone
 * else's (public) channel id and read or modify that user's library.
 */
export function setUserIdCookie(res: Response, userId: string) {
  res.cookie(USER_ID_COOKIE, userId, {
    ...baseCookieOptions,
    signed: true,
    maxAge: THIRTY_DAYS_MS,
  });
}

export function setAccessTokenCookie(res: Response, accessToken: string) {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    ...baseCookieOptions,
    maxAge: 60 * 60 * 1000, // 1 hour
  });
}

export function setRefreshTokenCookie(res: Response, refreshToken: string) {
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...baseCookieOptions,
    maxAge: THIRTY_DAYS_MS,
  });
}

export function clearAuthCookies(res: Response) {
  for (const name of [
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    USER_ID_COOKIE,
    // Legacy cookie from before the user id was consolidated + signed.
    "user_id",
  ]) {
    res.clearCookie(name, baseCookieOptions);
  }
}

/**
 * Exchanges the youtube_refresh_token cookie for a fresh access token and
 * writes it back as a cookie. The access token cookie is short-lived (1h),
 * so this lets a session survive past that without forcing a full re-login.
 * Returns the new access token, or null if there's no valid refresh token.
 */
export async function refreshYouTubeAccessToken(
  req: Request,
  res: Response,
): Promise<string | null> {
  const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE] as
    | string
    | undefined;
  if (!refreshToken) return null;

  try {
    const yt = new YouTubeService({ refresh_token: refreshToken });
    const tokens = await yt.refreshAccessToken();
    if (!tokens.access_token) return null;

    setAccessTokenCookie(res, tokens.access_token);
    return tokens.access_token;
  } catch (error) {
    console.error("Error refreshing YouTube access token:", error);
    return null;
  }
}

/** Reads the signed user id cookie; false/undefined if absent or tampered. */
export function getSignedUserId(req: Request): string | undefined {
  const value = req.signedCookies?.[USER_ID_COOKIE] as unknown;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const accessToken =
    (req.cookies?.[ACCESS_TOKEN_COOKIE] as string | undefined) ??
    (await refreshYouTubeAccessToken(req, res)) ??
    undefined;

  if (!accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  req.accessToken = accessToken;

  const signedUserId = getSignedUserId(req);
  if (signedUserId) {
    req.userId = signedUserId;
    return next();
  }

  // No (valid) signed id: derive it from the token itself and re-issue it.
  try {
    const yt = new YouTubeService({ access_token: accessToken });
    const me = await yt.getMyChannel();
    req.userId = me.id;
    setUserIdCookie(res, me.id);
    return next();
  } catch {
    return res.status(401).json({ error: "Token expired" });
  }
}
