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
  enrichProcessor?: (job: Job<EnrichReleaseDatesJobData>) => Promise<unknown>;
}

type AnyJobData = PersistJobData | EnrichReleaseDatesJobData;

/**
 * Worker polling settings. BullMQ's defaults (a blocking poll every 5s and a
 * stalled-job check every 30s per worker) cost ~300k Redis commands a day
 * while completely idle, which alone exhausts a free Upstash plan. Adding a
 * job still wakes the blocked worker immediately, so long intervals don't
 * delay work; they only delay recovering a job whose worker crashed.
 */
export const WORKER_POLL_OPTIONS = {
  drainDelay: 300, // seconds a worker blocks waiting for jobs
  stalledInterval: 5 * 60 * 1000,
} as const;

export class BullService {
  // One queue and one worker for every job type (sync, release-date
  // lookups): each worker costs Redis commands even when idle.
  private queue: Queue<AnyJobData>;
  private worker?: Worker<AnyJobData>;
  private connection: IORedis;
  private workerConnection?: IORedis;
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

    this.queue = new Queue<AnyJobData>(JobQueues.PERSIST_USER_DATA, {
      connection: this.connection,
    });

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
      this.workerConnection = createBullConnection();
      // Concurrency 1: one sync or lookup batch at a time, which also keeps
      // MusicBrainz lookups within its rate limit.
      this.worker = new Worker<AnyJobData>(
        JobQueues.PERSIST_USER_DATA,
        (job) =>
          job.name === Jobs.ENRICH_RELEASE_DATES
            ? enrichProcessor(job as Job<EnrichReleaseDatesJobData>)
            : processor(job as Job<PersistJobData>),
        {
          connection: this.workerConnection,
          concurrency: 1,
          ...WORKER_POLL_OPTIONS,
        },
      );
      this.setupWorkerListeners(this.worker);
    }
  }

  private setupWorkerListeners(worker: Worker<AnyJobData>): void {
    worker.on("completed", (job, result) => {
      if (job.name === Jobs.ENRICH_RELEASE_DATES) {
        console.log(
          `Release-date lookup for user ${job.data.userId}:`,
          JSON.stringify(result),
        );
      } else {
        console.log(
          `Persist job ${job.id} completed for user ${job.data.userId}`,
        );
      }
    });

    worker.on("failed", (job, err) => {
      console.error(
        `${job?.name === Jobs.ENRICH_RELEASE_DATES ? "Release-date lookup" : "Persist job"} ${job?.id} failed for user ${job?.data?.userId} (attempt ${job?.attemptsMade}):`,
        err?.message,
      );
    });

    worker.on("error", (err) => {
      console.error("Worker error:", err);
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
      const job = await this.queue.getJob(lastJobId);
      if (job) {
        const state = await job.getState();
        if ((UNFINISHED_STATES as string[]).includes(state)) return lastJobId;
        return null;
      }
    }

    const jobs = await this.queue.getJobs(UNFINISHED_STATES);
    // The queue also holds release-date lookups; only syncs count here.
    const userJob = jobs.find(
      (job) =>
        job?.name === Jobs.PERSIST_USER_DATA &&
        job.data.userId === userId &&
        job.data.source === source,
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
      const job = await this.queue.getJob(jobId);
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
    await this.worker?.close();
    await this.queue.close();
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

      const job = await this.queue.add(
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
    if (!isMusicBrainzEnabled()) {
      console.log(
        `Release-date lookups disabled (MUSICBRAINZ_ENABLED=false); skipping for user ${userId}`,
      );
      return false;
    }
    const library = new RedisService(userId, null, source);
    if (!(await library.claimReleaseLookup(LOOKUP_FLAG_TTL_SECONDS))) {
      console.log(`Release-date lookups already pending for user ${userId}`);
      return false;
    }
    await this.enqueueEnrichment({ userId, source });
    console.log(`Release-date lookups queued for user ${userId}`);
    return true;
  }

  private async enqueueEnrichment(data: EnrichReleaseDatesJobData) {
    // No retries: a failed batch clears the pending flag, and the next sync
    // picks up where the cache left off.
    await this.queue.add(Jobs.ENRICH_RELEASE_DATES, data, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    });
  }
}
