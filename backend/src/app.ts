import cookieParser from "cookie-parser";
import cors from "cors";
import crypto from "crypto";
import express, {
  Express,
  NextFunction,
  Request,
  Response,
} from "express";
import { redisClient } from "./redis";
import { indexRouter } from "./routes";
import { authRouter } from "./routes/auth";
import { createPersistRouter } from "./routes/persist";
import { BullService } from "./services";

export function resolveCookieSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = env.COOKIE_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "COOKIE_SECRET must be set (at least 32 characters) in production",
    );
  }

  console.warn(
    "⚠️  COOKIE_SECRET is not set (or too short); using a random per-process secret. " +
      "Sessions will re-validate against YouTube after each restart.",
  );
  return crypto.randomBytes(32).toString("hex");
}

export function createApp({
  bullService,
  cookieSecret = resolveCookieSecret(),
  clientUrl = process.env.CLIENT_URL || "http://127.0.0.1:5173",
}: {
  bullService: BullService;
  cookieSecret?: string;
  clientUrl?: string;
}): Express {
  const app = express();
  const isProduction = process.env.NODE_ENV === "production";

  // Helps secure cookies work correctly behind proxies in production
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(cors({ origin: clientUrl, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser(cookieSecret));

  // Liveness/readiness for the hosting platform. Registered before CSRF and
  // auth so it stays unauthenticated.
  app.get("/api/health", async (_req: Request, res: Response) => {
    try {
      await redisClient.ping();
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  // Minimal CSRF protection (double-submit cookie):
  // - server sets a readable csrf cookie
  // - client echoes it in X-CSRF-Token for non-GET requests
  app.use((req, res, next) => {
    const existing = req.cookies?.csrf_token as string | undefined;
    const csrfToken = existing ?? crypto.randomBytes(32).toString("hex");

    if (!existing) {
      res.cookie("csrf_token", csrfToken, {
        httpOnly: false,
        secure: isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
    }

    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }

    const headerToken = req.header("x-csrf-token");
    if (!headerToken || headerToken !== csrfToken) {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }

    next();
  });

  app.use("/api/auth", authRouter);
  app.use("/api/persist", createPersistRouter(bullService));
  app.use("/api", indexRouter);

  // Final error handler: anything that escaped a route's own handling.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      (err as { type?: string })?.type === "entity.parse.failed" ? 400 : 500;
    if (status === 500) console.error("Unhandled request error:", err);
    if (res.headersSent) return;
    res
      .status(status)
      .json({ error: status === 400 ? "Invalid JSON body" : "Internal error" });
  });

  return app;
}
