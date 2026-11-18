export {};

declare global {
  namespace Express {
    interface Request {
      /** Stable user id (YouTube channel id), set by requireAuth. */
      userId?: string;
      /** YouTube OAuth access token, set by requireAuth. */
      accessToken?: string;
    }
  }
}
