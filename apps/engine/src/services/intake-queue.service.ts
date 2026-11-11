import { Queue } from "bullmq";
import { IncidentSnapshot, toBullMQJobId } from "@dlq-healer/sdk";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { getIntakeQueueName } from "../config/env";

export class IntakeQueueService {
  private queues: Map<string, Queue<IncidentSnapshot>> = new Map();

  private getQueue(queueName: string): Queue<IncidentSnapshot> {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue<IncidentSnapshot>(queueName, {
        connection: redis,
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
      queue.on("error", (err) => {
        logger.error(
          { queueName, err: err.message },
          "[Intake Queue] BullMQ queue runtime error"
        );
      });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  public async enqueueSnapshot(
    snapshot: IncidentSnapshot,
    targetQueueName?: string
  ): Promise<{ queueName: string; jobId: string }> {
    const queueName = targetQueueName || getIntakeQueueName();
    const queue = this.getQueue(queueName);
    const jobId = toBullMQJobId(snapshot.idempotencyKey);

    try {
      const job = await queue.add("incident", snapshot, { jobId });
      return {
        queueName,
        jobId: String(job.id || jobId),
      };
    } catch (err: any) {
      if (
        err?.message?.includes("Job already exists") ||
        err?.message?.includes("duplicate")
      ) {
        return { queueName, jobId };
      }
      throw err;
    }
  }

  public async removeSnapshotJob(
    idempotencyKey: string,
    targetQueueName?: string
  ): Promise<void> {
    const queueName = targetQueueName || getIntakeQueueName();
    const queue = this.getQueue(queueName);
    const jobId = toBullMQJobId(idempotencyKey);
    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove().catch(() => undefined);
    }
  }

  public async closeAll(): Promise<void> {
    const closePromises = Array.from(this.queues.values()).map((q) =>
      q.close().catch(() => undefined)
    );
    await Promise.all(closePromises);
    this.queues.clear();
  }
}

export const intakeQueueService = new IntakeQueueService();
