import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisClient } from "../src/redis";
import { BullService } from "../src/services/BullService";
import { hasRedis, resetRedis } from "./helpers";

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
};

describe.skipIf(!hasRedis)("BullService (Redis integration)", () => {
  let bull: BullService;
  let attempts = 0;

  beforeAll(async () => {
    await resetRedis();
    bull = new BullService({
      attempts: 2,
      backoffDelayMs: 500,
      processor: async () => {
        attempts += 1;
        throw new Error("YouTube is down");
      },
    });
  });

  afterAll(async () => {
    await bull.cleanup();
    await redisClient.quit();
  });

  it("reports a job waiting to retry as active and the final failure as failed", async () => {
    const { jobId, alreadyRunning } = await bull.startPersistJob("u1", "tok", undefined);
    expect(alreadyRunning).toBe(false);

    // A second request while the first is unfinished reuses it.
    const second = await bull.startPersistJob("u1", "tok", undefined);
    expect(second).toEqual({ jobId, alreadyRunning: true });

    // After the first failed attempt the job sits in "delayed" (backoff):
    // it must still count as active, not as finished.
    await waitFor(async () => attempts >= 1);
    expect(await bull.getActiveJob("u1")).toBe(jobId);

    await waitFor(async () => (await bull.getActiveJob("u1")) === null);
    const last = await bull.getLastJobStatus("u1");
    expect(last).toMatchObject({ jobId, status: "failed" });
    expect(last?.error).toContain("YouTube is down");
    expect(attempts).toBe(2);
  });
});
