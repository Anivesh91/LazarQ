import { Queue } from "bullmq";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { INTAKE_QUEUE_NAME } from "../workers/healer.worker";

/**
 * System queues that can NEVER be targeted for re-injection
 * to prevent cascading ingestion loops.
 */
const FORBIDDEN_QUEUES = new Set<string>([
  INTAKE_QUEUE_NAME,
  "dlq-healer-intake",
  "dlq-healer-events",
]);

export interface ReinjectOptions {
  delayMs?: number;
  jobId?: string;
  attempts?: number;
  backoff?: {
    type: "exponential" | "fixed";
    delay: number;
  };
}

export class QueueReinjector {
  private queues: Map<string, Queue> = new Map();

  /**
   * Validates if a target queue name is eligible for re-injection.
   */
  public validateQueueName(queueName: string): void {
    if (!queueName || typeof queueName !== "string" || queueName.trim().length === 0) {
      throw new AppError("Invalid queue name: queue name cannot be empty", 400, "INVALID_QUEUE_NAME");
    }

    const trimmed = queueName.trim();
    if (FORBIDDEN_QUEUES.has(trimmed)) {
      throw new AppError(
        `Cannot re-inject jobs into internal system queue: "${trimmed}"`,
        400,
        "FORBIDDEN_TARGET_QUEUE"
      );
    }

    // Ensure queue name only contains safe characters (alphanumeric, hyphens, underscores, colons)
    const validFormat = /^[a-zA-Z0-9_\-:]+$/;
    if (!validFormat.test(trimmed)) {
      throw new AppError(
        `Queue name "${trimmed}" contains invalid characters. Only alphanumeric, hyphens, underscores, and colons are allowed.`,
        400,
        "INVALID_QUEUE_NAME"
      );
    }
  }

  /**
   * Gets or initializes a cached BullMQ Queue instance for the target queue.
   */
  public getQueue(queueName: string): Queue {
    this.validateQueueName(queueName);

    let queue = this.queues.get(queueName);
    if (!queue) {
      logger.info({ queueName }, "[Reinjector] Creating new BullMQ Queue connection for replay");
      queue = new Queue(queueName, {
        connection: redis,
      });
      this.queues.set(queueName, queue);
    }

    return queue;
  }

  /**
   * Re-enqueues the mutated repair payload into the target BullMQ queue.
   */
  public async reinjectJob(
    queueName: string,
    jobName: string,
    payload: Record<string, any>,
    options: ReinjectOptions = {}
  ): Promise<{ jobId: string; queueName: string; jobName: string }> {
    this.validateQueueName(queueName);

    const queue = this.getQueue(queueName);
    const delay = Math.max(0, options.delayMs ?? 0);
    const jobId = options.jobId || `recovery-${Date.now()}`;

    logger.info(
      {
        queueName,
        jobName,
        jobId,
        delayMs: delay,
      },
      "[Reinjector] Re-injecting repaired job into source queue"
    );

    const job = await queue.add(jobName, payload, {
      delay,
      jobId,
      removeOnComplete: false,
      removeOnFail: false,
      attempts: options.attempts ?? 3,
      backoff: options.backoff ?? {
        type: "exponential",
        delay: 2000,
      },
    });

    const assignedId = String(job.id || jobId);

    logger.info(
      {
        assignedId,
        queueName,
        jobName,
      },
      "✅ [Reinjector] Successfully re-injected job into source queue"
    );

    return {
      jobId: assignedId,
      queueName,
      jobName,
    };
  }

  /**
   * Closes all cached Queue connections gracefully.
   */
  public async closeAll(): Promise<void> {
    logger.info(`[Reinjector] Closing ${this.queues.size} cached queue connections...`);
    const closePromises = Array.from(this.queues.values()).map((q) => q.close());
    await Promise.all(closePromises);
    this.queues.clear();
    logger.info("[Reinjector] All queue connections closed");
  }
}

export const queueReinjector = new QueueReinjector();
