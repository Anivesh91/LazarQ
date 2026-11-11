import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import { eventBroadcaster } from "../services/event-broadcaster.service";
import { circuitBreakerService } from "../services/circuit-breaker.service";

export class ReplayResultObserver {
  private observers: Map<string, QueueEvents> = new Map();
  private connections: Map<string, Redis> = new Map();
  private inspectionQueues: Map<string, Queue> = new Map();

  private getInspectionQueue(queueName: string): Queue {
    let queue = this.inspectionQueues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: redis });
      this.inspectionQueues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * Checks whether a BullMQ failed event represents a terminal retry exhaustion
   * rather than an intermediate retry attempt that is still scheduled to run again.
   */
  public async isTerminalFailure(queueName: string, jobId: string): Promise<boolean> {
    try {
      const queue = this.getInspectionQueue(queueName);
      const job = await queue.getJob(jobId);
      if (!job) {
        return true;
      }

      const state = await job.getState();
      const maxAttempts = job.opts?.attempts ?? 1;

      if (state !== "failed" && job.attemptsMade < maxAttempts) {
        logger.info(
          {
            queueName,
            jobId,
            state,
            attemptsMade: job.attemptsMade,
            maxAttempts,
          },
          "[Replay Observer] Replayed job failed on intermediate retry; waiting for remaining attempts"
        );
        return false;
      }

      return true;
    } catch (err: any) {
      logger.warn(
        { queueName, jobId, err: err.message },
        "[Replay Observer] Could not inspect BullMQ job state; treating failed event as terminal"
      );
      return true;
    }
  }

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
      const isTerminal = await this.isTerminalFailure(queueName, jobId);
      if (!isTerminal) {
        return;
      }

      logger.warn(
        { queueName, jobId, failedReason },
        "[Replay Observer] Detected terminal failed job event in queue"
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
          status: { in: ["IN_PROGRESS", "QUEUED"] },
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

      if (attempt.incident.fingerprint) {
        circuitBreakerService.recordSuccess(attempt.incident.fingerprint);
      }

      eventBroadcaster.broadcast("incident:resolved", {
        incidentId: attempt.incidentId,
        attemptId: attempt.id,
        replayJobId: jobId,
        queueName,
      });

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
          status: { in: ["IN_PROGRESS", "QUEUED"] },
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

      eventBroadcaster.broadcast("incident:failed", {
        incidentId: attempt.incidentId,
        attemptId: attempt.id,
        replayJobId: jobId,
        queueName,
        failedReason,
      });

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
   * Re-attaches QueueEvents listeners on Engine startup for any incidents left
   * in REPLAYING state and reconciles replay jobs that settled during downtime.
   */
  public async recoverActiveReplayObservers(): Promise<number> {
    const activeIncidents = await prisma.incident.findMany({
      where: { status: "REPLAYING" },
      include: {
        recoveryAttempts: {
          where: { status: { in: ["IN_PROGRESS", "QUEUED"] } },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    });

    if (activeIncidents.length === 0) {
      return 0;
    }

    logger.info(
      { count: activeIncidents.length },
      "[Replay Observer] Recovering QueueEvents observers for active REPLAYING incidents"
    );

    for (const incident of activeIncidents) {
      this.ensureQueueObserver(incident.queueName);
      const attempt = incident.recoveryAttempts[0];
      if (!attempt?.replayJobId) {
        continue;
      }

      try {
        const queue = this.getInspectionQueue(incident.queueName);
        const job = await queue.getJob(attempt.replayJobId);
        if (!job) {
          continue;
        }

        const state = await job.getState();
        if (state === "completed") {
          await this.handleJobCompleted(
            incident.queueName,
            attempt.replayJobId,
            job.returnvalue
          );
        } else if (
          state === "failed" &&
          (await this.isTerminalFailure(incident.queueName, attempt.replayJobId))
        ) {
          await this.handleJobFailed(
            incident.queueName,
            attempt.replayJobId,
            job.failedReason
          );
        }
      } catch (err: any) {
        logger.warn(
          {
            incidentId: incident.id,
            queueName: incident.queueName,
            replayJobId: attempt.replayJobId,
            err: err?.message,
          },
          "[Replay Observer] Could not reconcile active replay job state during startup"
        );
      }
    }

    return activeIncidents.length;
  }

  /**
   * Closes all active QueueEvents observers and their subscriber connections gracefully.
   */
  public async closeAll(): Promise<void> {
    logger.info(`[Replay Observer] Closing ${this.observers.size} active QueueEvents observers...`);
    const closePromises = Array.from(this.observers.values()).map((obs) => obs.close());
    await Promise.all(closePromises);
    this.observers.clear();

    const queueClosePromises = Array.from(this.inspectionQueues.values()).map((q) => q.close());
    await Promise.all(queueClosePromises);
    this.inspectionQueues.clear();

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
