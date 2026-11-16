import { inject } from "vitest";

// Must run before any module that reads REDIS_URL at import time.
const redisUrl = inject("redisUrl");
process.env.REDIS_URL = redisUrl ?? "redis://127.0.0.1:1";
process.env.YOUTUBE_CLIENT_ID ??= "test-client-id";
process.env.YOUTUBE_CLIENT_SECRET ??= "test-client-secret";
