/**
 * Generic retry-with-backoff for upstream API calls (YouTube Data API via
 * googleapis/gaxios, or any axios-style client).
 *
 * Retries:
 *  - 429 Too Many Requests (honouring Retry-After when present)
 *  - 5xx (500/502/503/504)
 *  - 403 with a rate-limit reason (YouTube reports per-user/per-second rate
 *    limits as 403 rateLimitExceeded / userRateLimitExceeded)
 *  - transient network errors (resets, timeouts, DNS hiccups)
 *
 * Never retries other 4xx errors (auth, not found, quota exhausted, ...).
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

type ErrorLike = {
  code?: string | number;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, unknown> | { get?: (name: string) => unknown };
    data?: { error?: { errors?: { reason?: string }[] } };
  };
  errors?: { reason?: string }[];
};

export function getErrorStatus(err: unknown): number | undefined {
  const e = err as ErrorLike | undefined;
  if (!e) return undefined;
  if (typeof e.response?.status === "number") return e.response.status;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

export function getErrorReasons(err: unknown): string[] {
  const e = err as ErrorLike | undefined;
  const reasons = [
    ...(e?.errors ?? []),
    ...(e?.response?.data?.error?.errors ?? []),
  ]
    .map((x) => x?.reason)
    .filter((r): r is string => typeof r === "string");
  return reasons;
}

function getRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as ErrorLike | undefined)?.response?.headers;
  if (!headers) return undefined;
  const raw =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get: (n: string) => unknown }).get("retry-after")
      : (headers as Record<string, unknown>)["retry-after"];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function isRetryableError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 429) return true;
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  if (status === 403) {
    return getErrorReasons(err).some((r) => RATE_LIMIT_REASONS.has(r));
  }
  const code = (err as ErrorLike | undefined)?.code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    sleep = defaultSleep,
  }: RetryOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;

      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const waitMs = Math.min(maxDelayMs, getRetryAfterMs(err) ?? backoff);
      await sleep(waitMs);
    }
  }
}
