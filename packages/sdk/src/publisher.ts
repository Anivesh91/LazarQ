import { Queue } from "bullmq";
import Redis from "ioredis";
import { IncidentSnapshot } from "./types";

export class SmartDLQPublisher {
  private intakeQueue: Queue<IncidentSnapshot>;
  private ownConnection: boolean = false;
  private redisClient?: Redis;

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
      // If job with this ID already exists, BullMQ might throw or ignore; handle gracefully
      if (err.message?.includes("Job already exists") || err.message?.includes("duplicate")) {
        return snapshot.idempotencyKey;
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.intakeQueue.close();
    if (this.ownConnection && this.redisClient) {
      await this.redisClient.quit();
    }
  }
}
