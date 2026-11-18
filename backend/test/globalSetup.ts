import { ChildProcess, spawn, spawnSync } from "child_process";
import net from "net";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string | null;
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`redis-server did not start on port ${port}`);
}

let redis: ChildProcess | undefined;

export default async function setup(project: TestProject) {
  const hasRedis =
    spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasRedis) {
    console.warn("redis-server not found: Redis integration tests will be skipped");
    project.provide("redisUrl", null);
    return;
  }

  const port = await getFreePort();
  redis = spawn(
    "redis-server",
    ["--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" },
  );
  await waitForPort(port);
  project.provide("redisUrl", `redis://127.0.0.1:${port}`);

  return () => {
    redis?.kill();
  };
}
