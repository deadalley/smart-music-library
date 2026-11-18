import { describe, expect, it, vi } from "vitest";
import { isRetryableError, withRetry } from "../src/lib/retry";

const httpError = (
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => Object.assign(new Error(`HTTP ${status}`), {
  response: { status, headers, ...extra },
});

describe("withRetry", () => {
  it("retries 429 honouring Retry-After", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, {}, { "retry-after": "2" }))
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries 5xx with exponential backoff and gives up after maxAttempts", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fn = vi.fn().mockRejectedValue(httpError(503));

    await expect(
      withRetry(fn, { sleep, maxAttempts: 3, baseDelayMs: 100 }),
    ).rejects.toThrow("HTTP 503");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("does not retry other 4xx errors", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fn = vi.fn().mockRejectedValue(httpError(404));

    await expect(withRetry(fn, { sleep })).rejects.toThrow("HTTP 404");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("isRetryableError", () => {
  it("treats YouTube rate-limit 403s as retryable but not quota/permission 403s", () => {
    const rateLimited = Object.assign(httpError(403), {
      errors: [{ reason: "rateLimitExceeded" }],
    });
    const quota = Object.assign(httpError(403), {
      errors: [{ reason: "quotaExceeded" }],
    });
    expect(isRetryableError(rateLimited)).toBe(true);
    expect(isRetryableError(quota)).toBe(false);
  });

  it("retries transient network errors", () => {
    expect(isRetryableError(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});
