import { inject } from "vitest";
import { connectRedis, redisClient } from "../src/redis";

export const redisUrl = inject("redisUrl");
export const hasRedis = !!redisUrl;

export async function resetRedis() {
  await connectRedis();
  await redisClient.flushAll();
}

export async function keysMatching(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redisClient.scanIterator({ MATCH: pattern })) {
    keys.push(key);
  }
  return keys.sort();
}
