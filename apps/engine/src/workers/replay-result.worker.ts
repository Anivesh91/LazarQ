import { QueueEvents } from "bullmq";
import Redis from "ioredis";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";

export class ReplayResultObserver {
  private observers: Map<string, QueueEvents> = new Map();
  private connections: Map<string, Redis> = new Map();

  /**
   * Ensures an active QueueEvents subscriber is listening to the target queue.
   */
  public ensureQueueObserver(queueName: string): QueueEvents {
    let observer = this.observers.get(queueName);
    if (observer) {
      return observer;
    }

    logger.info({ queueName }, "[Replay Observer] Initializing QueueEvents subscriber for queue");

    // QueueEvents requires its own connection instance in ioredis to listen to pub/sub streams
    const subscriberConnection = redis.duplicate({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.connections.set(queueName, subscriberConnection);

    observer = new QueueEvents(queueName, {
      connection: subscriberConnection,
    });

    observer.on("completed", async ({ jobId, returnvalue }) => {
      logger.info(
        { queueName, jobId },
        "[Replay Observer] Detected completed job event in queue"
      );
      await this.handleJobCompleted(queueName, jobId, returnvalue);
    });

    observer.on("failed", async ({ jobId, failedReason }) => {
      logger.warn(
        { queueName, jobId, failedReason },
        "[Replay Observer] Detected failed job event in queue"
      );
      await this.handleJobFailed(queueName, jobId, failedReason);
    });

    observer.on("error", (err) => {
      logger.error(
        { queueName, err: err.message },
        "[Replay Observer] QueueEvents listener runtime error"
      );
    });

    this.observers.set(queueName, observer);
    return observer;
  }

  /**
   * Handles successful execution of a replayed recovery job.
   */
  public async handleJobCompleted(
    queueName: string,
    jobId: string,
    returnvalue?: any
  ): Promise<boolean> {
    try {
      // Find matching active recovery attempt
      const attempt = await prisma.recoveryAttempt.findFirst({
        where: {
          replayJobId: jobId,
          status: "IN_PROGRESS",
        },
        include: { incident: true },
      });

      if (!attempt) {
        // Not a monitored recovery job or already finalized
        return false;
      }

      logger.info(
        {
          incidentId: attempt.incidentId,
          attemptId: attempt.id,
          replayJobId: jobId,
          queueName,
        },
        "🎉 [Replay Observer] Recovery job succeeded! Marking incident RESOLVED"
      );

      await prisma.$transaction([
        prisma.recoveryAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
          },
        }),
        prisma.incident.update({
          where: { id: attempt.incidentId },
          data: {
            status: "RESOLVED",
          },
        }),
        prisma.auditLog.create({
          data: {
            incidentId: attempt.incidentId,
            action: "RECOVERY_RESOLVED",
            actor: "replay-observer",
            details: {
              attemptId: attempt.id,
              replayJobId: jobId,
              queueName,
              returnvalue: returnvalue || null,
            },
          },
        }),
      ]);

      return true;
    } catch (err: any) {
      logger.error(
        { queueName, jobId, err: err.message },
        "[Replay Observer] Failed to process recovery job completion in database"
      );
      return false;
    }
  }

  /**
   * Handles failed execution of a replayed recovery job.
   */
  public async handleJobFailed(
    queueName: string,
    jobId: string,
    failedReason?: string
  ): Promise<boolean> {
    try {
      // Find matching active recovery attempt
      const attempt = await prisma.recoveryAttempt.findFirst({
        where: {
          replayJobId: jobId,
          status: "IN_PROGRESS",
        },
        include: { incident: true },
      });

      if (!attempt) {
        // Not a monitored recovery job or already finalized
        return false;
      }

      logger.error(
        {
          incidentId: attempt.incidentId,
          attemptId: attempt.id,
          replayJobId: jobId,
          queueName,
          failedReason,
        },
        "❌ [Replay Observer] Recovery job failed again! Marking incident REPLAY_FAILED"
      );

      await prisma.$transaction([
        prisma.recoveryAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "FAILED",
            failureReason: failedReason || "Unknown failure during replay execution",
            completedAt: new Date(),
          },
        }),
        prisma.incident.update({
          where: { id: attempt.incidentId },
          data: {
            status: "REPLAY_FAILED",
          },
        }),
        prisma.auditLog.create({
          data: {
            incidentId: attempt.incidentId,
            action: "RECOVERY_REPLAY_FAILED",
            actor: "replay-observer",
            details: {
              attemptId: attempt.id,
              replayJobId: jobId,
              queueName,
              failedReason: failedReason || null,
            },
          },
        }),
      ]);

      return true;
    } catch (err: any) {
      logger.error(
        { queueName, jobId, err: err.message },
        "[Replay Observer] Failed to process recovery job failure in database"
      );
      return false;
    }
  }

  /**
   * Closes all active QueueEvents observers and their subscriber connections gracefully.
   */
  public async closeAll(): Promise<void> {
    logger.info(`[Replay Observer] Closing ${this.observers.size} active QueueEvents observers...`);
    const closePromises = Array.from(this.observers.values()).map((obs) => obs.close());
    await Promise.all(closePromises);
    this.observers.clear();

    const connPromises = Array.from(this.connections.values()).map((conn) =>
      conn.status === "ready" || conn.status === "connect"
        ? conn.quit().catch(() => conn.disconnect())
        : conn.disconnect()
    );
    await Promise.all(connPromises);
    this.connections.clear();

    logger.info("[Replay Observer] All observers and connections closed");
  }
}

export const replayResultObserver = new ReplayResultObserver();
