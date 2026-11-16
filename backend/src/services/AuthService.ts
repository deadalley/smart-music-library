import { redisClient } from "../redis";

// Matches the fixed, login-anchored expiry used for the auth cookies.
const USER_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AuthUser {
  id: string;
  displayName: string;
  createdAt?: string;
  /**
   * Google only issues a refresh token on the first grant (or a forced
   * re-consent), so it's kept server-side to restore it on later logins.
   * Access tokens are deliberately not stored: they live in the cookie only.
   */
  refreshToken?: string;
}

export class AuthService {
  private getRedisKey(userId: string): string {
    return `smart-spotify:user:${userId}`;
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const userData = await redisClient.hGetAll(this.getRedisKey(userId));
    if (!userData || Object.keys(userData).length === 0) return null;

    // Legacy shape stored the YouTube data as a JSON blob under "ytMusic".
    let legacy: { refreshToken?: string } = {};
    if (userData.ytMusic) {
      try {
        legacy = JSON.parse(userData.ytMusic);
      } catch {
        legacy = {};
      }
    }

    return {
      id: userId,
      displayName: userData.displayName || userId,
      createdAt: userData.createdAt,
      refreshToken: userData.refreshToken || legacy.refreshToken || undefined,
    };
  }

  async saveYouTubeUser(user: {
    id: string;
    displayName: string;
    refreshToken?: string;
  }): Promise<void> {
    const key = this.getRedisKey(user.id);
    const fields: Record<string, string> = { displayName: user.displayName };
    if (user.refreshToken) fields.refreshToken = user.refreshToken;

    await redisClient
      .multi()
      .hSetNX(key, "createdAt", new Date().toISOString())
      .hSet(key, fields)
      // Drop the legacy blob, which also contained a stale access token.
      .hDel(key, ["ytMusic", "spotify"])
      .expire(key, USER_TTL_SECONDS)
      .exec();
  }
}
