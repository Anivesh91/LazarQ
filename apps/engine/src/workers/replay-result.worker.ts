import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { Prisma } from "@prisma/client";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";
import { eventBroadcaster } from "../services/event-broadcaster.service";
import { circuitBreakerService } from "../services/circuit-breaker.service";
import { transitionIncidentConditional } from "../services/incident-state";
import { sanitizeErrorMessage } from "../services/execution-payload.service";
import { AppError } from "../middleware/error-handler";

export interface ReplayObserverOptions {
  dbRetryAttempts?: number;
  dbRetryBaseDelayMs?: number;
  reconcileIntervalMs?: number;
}

export class ReplayResultObserver {
  private observers: Map<string, QueueEvents> = new Map();
  private connections: Map<string, Redis> = new Map();
  private inspectionQueues: Map<string, Queue> = new Map();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  private readonly dbRetryAttempts: number;
  private readonly dbRetryBaseDelayMs: number;
  private readonly defaultReconcileIntervalMs: number;

  constructor(options: ReplayObserverOptions = {}) {
    this.dbRetryAttempts = Math.max(1, options.dbRetryAttempts ?? 4);
    this.dbRetryBaseDelayMs = Math.max(5, options.dbRetryBaseDelayMs ?? 150);
    this.defaultReconcileIntervalMs = Math.max(
      250,
      options.reconcileIntervalMs ?? 5000
    );
  }

  private getInspectionQueue(queueName: string): Queue {
    let queue = this.inspectionQueues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: redis });
      this.inspectionQueues.set(queueName, queue);
    }
    return queue;
  }

  private async withDbRetry<T>(
    operation: () => Promise<T>,
    context: Record<string, any>
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.dbRetryAttempts; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (err instanceof AppError || attempt >= this.dbRetryAttempts) {
          throw err;
        }
        const delayMs = this.dbRetryBaseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(
          {
            ...context,
            attempt,
            maxAttempts: this.dbRetryAttempts,
            delayMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "[Replay Observer] Transient DB error persisting replay outcome; retrying"
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
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
      const discarded = Boolean((job as unknown as { discarded?: boolean }).discarded);
      const finishedOn = (job as unknown as { finishedOn?: number }).finishedOn;

      if (
        !discarded &&
        typeof finishedOn !== "number" &&
        state !== "failed" &&
        job.attemptsMade < maxAttempts
      ) {
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
   * Attaches the QueueEvents subscriber and awaits readiness (including entering
   * the Redis XREAD loop where applicable) before callers enqueue a replay job.
   */
  public async ensureQueueObserverReady(queueName: string): Promise<QueueEvents> {
    const observer = this.ensureQueueObserver(queueName);
    const anyObserver = observer as unknown as {
      waitUntilReady?: () => Promise<unknown>;
      running?: boolean;
      blocking?: boolean;
      closing?: boolean;
    };

    if (typeof anyObserver?.waitUntilReady === "function") {
      await anyObserver.waitUntilReady();

      // Wait briefly for QueueEvents.consumeEvents() to enter its blocking XREAD '$' state
      // so fast 0ms workers never beat stream initialization.
      if (typeof anyObserver.running === "boolean") {
        const deadline = Date.now() + 200;
        while (!anyObserver.blocking && !anyObserver.closing && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    }

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
      const outcome = await this.withDbRetry(
        async () => {
          const attempt = await prisma.recoveryAttempt.findFirst({
            where: {
              replayJobId: jobId,
              status: { in: ["IN_PROGRESS", "QUEUED"] },
            },
            include: { incident: true },
          });

          if (!attempt) {
            return null;
          }

          return prisma.$transaction(async (tx) => {
            const attemptUpdate = await tx.recoveryAttempt.updateMany({
              where: {
                id: attempt.id,
                status: { in: ["IN_PROGRESS", "QUEUED"] },
              },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
              },
            });

            if (attemptUpdate.count !== 1) {
              return { applied: false, attempt };
            }

            const shouldPurgeEncryptedPayload =
              attempt.incident?.encryptedExecutionPayload != null;

            const incidentTransitioned = await transitionIncidentConditional(tx, {
              incidentId: attempt.incidentId,
              allowedFrom: ["REPLAYING"],
              toStatus: "RESOLVED",
              ...(shouldPurgeEncryptedPayload
                ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
                : {}),
              actionName: "replay completed",
            });

            if (incidentTransitioned) {
              await tx.auditLog.create({
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
              });
            }

            return {
              applied: incidentTransitioned,
              attempt,
            };
          });
        },
        { queueName, jobId, event: "completed" }
      );

      if (!outcome || !outcome.applied) {
        return false;
      }

      const { attempt } = outcome;

      logger.info(
        {
          incidentId: attempt.incidentId,
          attemptId: attempt.id,
          replayJobId: jobId,
          queueName,
        },
        "🎉 [Replay Observer] Recovery job succeeded! Marking incident RESOLVED"
      );

      if (attempt.incident?.fingerprint) {
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
        "[Replay Observer] Failed to process recovery job completion in database; will reconcile asynchronously"
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
      const outcome = await this.withDbRetry(
        async () => {
          const attempt = await prisma.recoveryAttempt.findFirst({
            where: {
              replayJobId: jobId,
              status: { in: ["IN_PROGRESS", "QUEUED"] },
            },
            include: { incident: true },
          });

          if (!attempt) {
            return null;
          }

          const sanitizedReason = failedReason
            ? sanitizeErrorMessage(failedReason)
            : "Unknown failure during replay execution";

          return prisma.$transaction(async (tx) => {
            const attemptUpdate = await tx.recoveryAttempt.updateMany({
              where: {
                id: attempt.id,
                status: { in: ["IN_PROGRESS", "QUEUED"] },
              },
              data: {
                status: "FAILED",
                failureReason: sanitizedReason,
                completedAt: new Date(),
              },
            });

            if (attemptUpdate.count !== 1) {
              return { applied: false, attempt, sanitizedReason };
            }

            const shouldPurgeEncryptedPayload =
              attempt.incident?.encryptedExecutionPayload != null;

            const incidentTransitioned = await transitionIncidentConditional(tx, {
              incidentId: attempt.incidentId,
              allowedFrom: ["REPLAYING"],
              toStatus: "REPLAY_FAILED",
              ...(shouldPurgeEncryptedPayload
                ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
                : {}),
              actionName: "replay failed",
            });

            if (incidentTransitioned) {
              await tx.auditLog.create({
                data: {
                  incidentId: attempt.incidentId,
                  action: "RECOVERY_REPLAY_FAILED",
                  actor: "replay-observer",
                  details: {
                    attemptId: attempt.id,
                    replayJobId: jobId,
                    queueName,
                    failedReason: failedReason ? sanitizedReason : null,
                  },
                },
              });
            }

            return {
              applied: incidentTransitioned,
              attempt,
              sanitizedReason,
            };
          });
        },
        { queueName, jobId, event: "failed" }
      );

      if (!outcome || !outcome.applied) {
        return false;
      }

      const { attempt, sanitizedReason } = outcome;

      logger.error(
        {
          incidentId: attempt.incidentId,
          attemptId: attempt.id,
          replayJobId: jobId,
          queueName,
          failedReason: sanitizedReason,
        },
        "❌ [Replay Observer] Recovery job failed again! Marking incident REPLAY_FAILED"
      );

      if (attempt.incident?.fingerprint) {
        circuitBreakerService.recordFailure(attempt.incident.fingerprint);
      }

      eventBroadcaster.broadcast("incident:failed", {
        incidentId: attempt.incidentId,
        attemptId: attempt.id,
        replayJobId: jobId,
        queueName,
        failedReason: failedReason ? sanitizedReason : undefined,
      });

      return true;
    } catch (err: any) {
      logger.error(
        { queueName, jobId, err: err.message },
        "[Replay Observer] Failed to process recovery job failure in database; will reconcile asynchronously"
      );
      return false;
    }
  }

  /**
   * Re-attaches QueueEvents listeners for any incidents still REPLAYING or having
   * IN_PROGRESS attempts, and reconciles completed/failed BullMQ jobs into PostgreSQL.
   */
  public async reconcileOutstandingReplays(): Promise<number> {
    if (this.reconciling) {
      return 0;
    }

    this.reconciling = true;
    try {
      const activeIncidents = await prisma.incident.findMany({
        where: {
          OR: [
            { status: "REPLAYING" },
            {
              recoveryAttempts: {
                some: { status: "IN_PROGRESS" },
              },
            },
          ],
        },
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
        "[Replay Observer] Reconciling active/outstanding replay incidents"
      );

      for (const incident of activeIncidents) {
        try {
          await this.ensureQueueObserverReady(incident.queueName);
        } catch (obsErr: any) {
          logger.warn(
            {
              incidentId: incident.id,
              queueName: incident.queueName,
              err: obsErr?.message,
            },
            "[Replay Observer] Could not attach ready QueueEvents observer during reconciliation"
          );
        }

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
            "[Replay Observer] Could not inspect/reconcile active replay job state"
          );
        }
      }

      return activeIncidents.length;
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Re-attaches QueueEvents listeners on Engine startup for any incidents left
   * in REPLAYING state and reconciles replay jobs that settled during downtime.
   */
  public async recoverActiveReplayObservers(): Promise<number> {
    return this.reconcileOutstandingReplays();
  }

  /**
   * Starts periodic reconciliation for outstanding replays whose DB completion
   * updates encountered transient outages.
   */
  public startReconciler(intervalMs?: number): void {
    if (this.reconcileTimer) {
      return;
    }
    const effectiveInterval = Math.max(
      250,
      intervalMs ?? this.defaultReconcileIntervalMs
    );
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOutstandingReplays().catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[Replay Observer] Background reconciliation sweep failed"
        );
      });
    }, effectiveInterval);
    this.reconcileTimer.unref?.();
  }

  public stopReconciler(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Closes all active QueueEvents observers and their subscriber connections gracefully.
   */
  public async closeAll(): Promise<void> {
    this.stopReconciler();
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
