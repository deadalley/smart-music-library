import "dotenv/config";
import { createApp, resolveCookieSecret } from "./app";
import { connectRedis, redisClient } from "./redis";
import { BullService } from "./services";

const PORT = Number(process.env.PORT) || 3001;
const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

const startServer = async () => {
  try {
    // Validate config before touching any external service.
    const cookieSecret = resolveCookieSecret();

    await connectRedis();
    const bullService = new BullService();
    const app = createApp({ bullService, cookieSecret });

    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://127.0.0.1:${PORT}`);
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down...`);

      const forceExit = setTimeout(() => {
        console.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Lets an in-flight sync job finish its current step; BullMQ
        // re-queues it as stalled if we're killed before it completes.
        await bullService.cleanup();
        await redisClient.quit();
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
