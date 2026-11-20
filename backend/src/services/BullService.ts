import { Job, JobType, Queue, Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import {
  EnrichReleaseDatesJobData,
  enrichReleaseDatesJob,
  LOOKUP_FLAG_TTL_SECONDS,
} from "../jobs/enrichReleaseDates";
import {
  getPersistJobStatusMessage,
  PersistJobData,
  persistUserDataJob,
} from "../jobs/persistUserData";
import { isMusicBrainzEnabled } from "./MusicBrainzService";
import { redisClient } from "../redis";
import { JobProgress, JobQueues, Jobs, JobStatus } from "../types";
import { MusicSource, RedisService } from "./RedisService";

// Jobs that haven't reached a final state. "delayed" matters: between retry
// attempts BullMQ parks a job there, and ignoring it made a sync that was
// backing off look finished.
const UNFINISHED_STATES: JobType[] = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
];

const LOCK_TTL_SECONDS = 30;

export function createBullConnection(url = process.env.REDIS_URL) {
  // ioredis understands the full URL (username, password, db, rediss:// TLS).
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  return new IORedis(url || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

export interface BullServiceOptions {
  startWorker?: boolean;
  attempts?: number;
  backoffDelayMs?: number;
  processor?: (job: Job<PersistJobData>) => Promise<unknown>;
  enrichProcessor?: (
    job: Job<EnrichReleaseDatesJobData>,
  ) => Promise<unknown>;
}

export class BullService {
  private persistQueue: Queue<PersistJobData>;
  private persistWorker?: Worker<PersistJobData>;
  private connection: IORedis;
  private workerConnection?: IORedis;
  private enrichQueue: Queue<EnrichReleaseDatesJobData>;
  private enrichWorker?: Worker<EnrichReleaseDatesJobData>;
  private enrichWorkerConnection?: IORedis;
  private attempts: number;
  private backoffDelayMs: number;

  constructor({
    startWorker = true,
    attempts = 3,
    backoffDelayMs = 5000,
    processor,
    enrichProcessor,
  }: BullServiceOptions = {}) {
    this.connection = createBullConnection();
    this.attempts = attempts;
    this.backoffDelayMs = backoffDelayMs;

    this.persistQueue = new Queue<PersistJobData>(JobQueues.PERSIST_USER_DATA, {
      connection: this.connection,
    });
    this.enrichQueue = new Queue<EnrichReleaseDatesJobData>(
      JobQueues.ENRICH_RELEASE_DATES,
      { connection: this.connection },
    );

    processor ??= (job) =>
      persistUserDataJob(job, undefined, {
        onActivated: async (userId) => {
          await this.startReleaseDateEnrichment(userId);
        },
      });
    enrichProcessor ??= (job) =>
      enrichReleaseDatesJob(job, {
        enqueueNext: (data) => this.enqueueEnrichment(data),
      });

    if (startWorker) {
      // One lookup batch at a time across all users keeps us within
      // MusicBrainz's rate limit.
      this.enrichWorkerConnection = createBullConnection();
      this.enrichWorker = new Worker<EnrichReleaseDatesJobData>(
        JobQueues.ENRICH_RELEASE_DATES,
        enrichProcessor,
        { connection: this.enrichWorkerConnection, concurrency: 1 },
      );
      this.enrichWorker.on("completed", (job, result) => {
        console.log(
          `Release-date lookup for user ${job.data.userId}:`,
          JSON.stringify(result),
        );
      });
      this.enrichWorker.on("failed", (job, err) => {
        console.error(
          `Release-date lookup failed for user ${job?.data.userId}:`,
          err?.message,
        );
      });

      this.workerConnection = createBullConnection();
      this.persistWorker = new Worker<PersistJobData>(
        JobQueues.PERSIST_USER_DATA,
        processor,
        {
          connection: this.workerConnection,
          concurrency: 1, // Process one persist job at a time
        },
      );
      this.setupWorkerListeners(this.persistWorker);
    }
  }

  private setupWorkerListeners(worker: Worker<PersistJobData>): void {
    worker.on("completed", (job) => {
      console.log(`Persist job ${job.id} completed for user ${job.data.userId}`);
    });

    worker.on("failed", (job, err) => {
      console.error(
        `Persist job ${job?.id} failed for user ${job?.data?.userId} (attempt ${job?.attemptsMade}):`,
        err?.message,
      );
    });

    worker.on("error", (err) => {
      console.error("Persist worker error:", err);
    });
  }

  private lastJobKey(userId: string, source: MusicSource) {
    return RedisService.rootKey(userId, source, "last-job");
  }

  private lockKey(userId: string, source: MusicSource) {
    return RedisService.rootKey(userId, source, "sync-lock");
  }

  async getActiveJob(
    userId: string,
    source: MusicSource = "yt-music",
  ): Promise<string | null> {
    // Fast path: the most recently enqueued job for this user.
    const lastJobId = await redisClient.get(this.lastJobKey(userId, source));
    if (lastJobId) {
      const job = await this.persistQueue.getJob(lastJobId);
      if (job) {
        const state = await job.getState();
        if ((UNFINISHED_STATES as string[]).includes(state)) return lastJobId;
        return null;
      }
    }

    const jobs = await this.persistQueue.getJobs(UNFINISHED_STATES);
    const userJob = jobs.find(
      (job) => job?.data.userId === userId && job.data.source === source,
    );
    return userJob?.id ?? null;
  }

  /** Status of the user's most recent job (finished or not), if any. */
  async getLastJobStatus(
    userId: string,
    source: MusicSource = "yt-music",
  ): Promise<(JobProgress & { jobId: string }) | null> {
    const jobId = await redisClient.get(this.lastJobKey(userId, source));
    if (!jobId) return null;
    const status = await this.getJobStatus(jobId);
    return status ? { ...status, jobId } : null;
  }

  async getJobStatus(jobId: string): Promise<JobProgress | null> {
    try {
      const job = await this.persistQueue.getJob(jobId);
      if (!job) return null;

      const state = await job.getState();
      let status: JobStatus;
      switch (state) {
        case "active":
          status = JobStatus.ACTIVE;
          break;
        case "completed":
          status = JobStatus.COMPLETED;
          break;
        case "failed":
          status = JobStatus.FAILED;
          break;
        default:
          // waiting, delayed (between retries), prioritized, ...
          status = JobStatus.WAITING;
      }

      const progressValue = Number(job.progress || 0);
      const progress: JobProgress = {
        status,
        progress: progressValue,
        message:
          state === "delayed"
            ? "Retrying after an error..."
            : getPersistJobStatusMessage(progressValue),
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
      };

      if (status === JobStatus.FAILED) {
        progress.error = job.failedReason || "Sync failed";
      }

      return progress;
    } catch (error) {
      console.error("Error getting job status:", error);
      return null;
    }
  }

  async cleanup(): Promise<void> {
    await this.persistWorker?.close();
    await this.enrichWorker?.close();
    await this.persistQueue.close();
    await this.enrichQueue.close();
    this.enrichWorkerConnection?.disconnect();
    this.workerConnection?.disconnect();
    this.connection.disconnect();
  }

  async startPersistJob(
    userId: string,
    accessToken: string,
    refreshToken: string | undefined,
    source: MusicSource = "yt-music",
  ): Promise<{ jobId: string; alreadyRunning: boolean }> {
    // Short-lived lock so two concurrent requests can't both pass the
    // "no active job" check and enqueue two syncs.
    const lockKey = this.lockKey(userId, source);
    const locked = await redisClient.set(lockKey, "1", {
      NX: true,
      EX: LOCK_TTL_SECONDS,
    });

    try {
      if (!locked) {
        const active = await this.getActiveJob(userId, source);
        if (active) return { jobId: active, alreadyRunning: true };
        throw new Error("A sync is already being started, try again shortly");
      }

      const existing = await this.getActiveJob(userId, source);
      if (existing) return { jobId: existing, alreadyRunning: true };

      const job: Job<PersistJobData> = await this.persistQueue.add(
        Jobs.PERSIST_USER_DATA,
        { userId, accessToken, refreshToken, source },
        {
          attempts: this.attempts,
          backoff: { type: "exponential", delay: this.backoffDelayMs },
          removeOnComplete: { count: 100, age: 24 * 60 * 60 },
          removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
        },
      );

      await redisClient.set(this.lastJobKey(userId, source), job.id!, {
        EX: 7 * 24 * 60 * 60,
      });

      return { jobId: job.id!, alreadyRunning: false };
    } finally {
      if (locked) await redisClient.del(lockKey);
    }
  }

  /** Queues background MusicBrainz lookups unless already pending. */
  async startReleaseDateEnrichment(
    userId: string,
    source: MusicSource = "yt-music",
  ): Promise<boolean> {
    if (!isMusicBrainzEnabled()) return false;
    const library = new RedisService(userId, null, source);
    if (!(await library.claimReleaseLookup(LOOKUP_FLAG_TTL_SECONDS))) {
      return false;
    }
    await this.enqueueEnrichment({ userId, source });
    return true;
  }

  private async enqueueEnrichment(data: EnrichReleaseDatesJobData) {
    // No retries: a failed batch clears the pending flag, and the next sync
    // picks up where the cache left off.
    await this.enrichQueue.add(Jobs.ENRICH_RELEASE_DATES, data, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    });
  }
}
