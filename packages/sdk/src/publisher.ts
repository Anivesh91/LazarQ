import { Queue } from "bullmq";
import Redis from "ioredis";
import { IncidentSnapshot } from "./types";

export class SmartDLQPublisher {
  private intakeQueue: Queue<IncidentSnapshot>;
  private ownConnection: boolean = false;
  private redisClient?: Redis;
  private shuttingDown = false;

  constructor(
    queueName: string = "dlq-healer-intake",
    connectionOrUrl?: any
  ) {
    let connection = connectionOrUrl;

    if (!connection || typeof connection === "string") {
      const url = connection || "redis://localhost:6379";
      this.redisClient = new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      this.redisClient.on("error", (err) => {
        if (!this.shuttingDown || !this.isExpectedShutdownError(err)) {
          console.error("[DLQ-Healer SDK] Redis connection error:", err);
        }
      });
      connection = this.redisClient;
      this.ownConnection = true;
    }

    this.intakeQueue = new Queue<IncidentSnapshot>(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    this.intakeQueue.on("error", (err) => {
      if (!this.shuttingDown || !this.isExpectedShutdownError(err)) {
        console.error("[DLQ-Healer SDK] Intake queue error:", err);
      }
    });
  }

  private isExpectedShutdownError(error: Error): boolean {
    return /connection is (already )?closed/i.test(error.message);
  }

  /**
   * Publishes a captured terminal failure snapshot into the Smart DLQ intake queue.
   * Uses the idempotencyKey as the BullMQ jobId to prevent duplicate queued items.
   */
  async publish(snapshot: IncidentSnapshot): Promise<string> {
    try {
      const job = await this.intakeQueue.add("incident", snapshot, {
        jobId: snapshot.idempotencyKey,
      });
      return job.id || snapshot.idempotencyKey;
    } catch (err: any) {
      if (err.message?.includes("Job already exists") || err.message?.includes("duplicate")) {
        return snapshot.idempotencyKey;
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    let closeError: unknown;

    try {
      await this.intakeQueue.close();
    } catch (err) {
      if (!(err instanceof Error) || !this.isExpectedShutdownError(err)) {
        closeError = err;
      }
    }

    if (this.ownConnection && this.redisClient) {
      try {
        if (this.redisClient.status === "ready") {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const quitCompleted = await Promise.race([
            this.redisClient.quit().then(() => true),
            new Promise<boolean>((resolve) => {
              timeout = setTimeout(() => resolve(false), 5000);
            }),
          ]);
          if (timeout) clearTimeout(timeout);
          if (!quitCompleted) {
            this.redisClient.disconnect();
          }
        } else {
          this.redisClient.disconnect();
        }
      } catch (err) {
        this.redisClient.disconnect();
        if (!(err instanceof Error) || !this.isExpectedShutdownError(err)) {
          closeError ??= err;
        }
      }
    }

    if (closeError) throw closeError;
  }
}
