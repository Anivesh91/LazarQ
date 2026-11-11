import { Worker, Job } from "bullmq";
import { IncidentStatus, Prisma } from "@prisma/client";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { getIntakeQueueName } from "../config/env";
import { incidentService } from "../services/incident.service";
import { triageService } from "../services/triage.service";
import { validationService } from "../services/validation.service";
import { circuitBreakerService } from "../services/circuit-breaker.service";
import { eventBroadcaster } from "../services/event-broadcaster.service";
import { sanitizeErrorMessage } from "../services/execution-payload.service";
import {
  RESUMABLE_INTAKE_STATUSES,
  transitionIncidentConditional,
} from "../services/incident-state";
import { prisma } from "../db/prisma";
import { AppError } from "../middleware/error-handler";
import { IncidentSnapshot } from "@dlq-healer/sdk";

export const INTAKE_QUEUE_NAME = getIntakeQueueName();

let healerWorker: Worker<IncidentSnapshot> | null = null;

function isPermanentProcessingError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (err instanceof AppError) {
    return err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as any).message === "string"
      ? (err as any).message
      : "";
  return /Unsafe mutation|Prototype pollution|VALIDATION_ERROR/i.test(message);
}

export async function handleHealerJob(
  job: Pick<Job<IncidentSnapshot>, "id" | "data"> & {
    attemptsMade?: number;
    opts?: { attempts?: number };
  }
) {
  logger.info(
    {
      intakeJobId: job.id,
      sourceQueue: job.data.queueName,
      originalJobId: job.data.jobId,
      idempotencyKey: job.data.idempotencyKey,
    },
    "[Healer Worker] Processing failure snapshot from intake queue"
  );

  const intakeMaxAttempts = job.opts?.attempts ?? 1;
  const intakeAttemptsMade = job.attemptsMade ?? 0;
  const hasRetriesRemaining = intakeAttemptsMade + 1 < intakeMaxAttempts;

  const result = await incidentService.ingestSnapshot(job.data);
  const incident = result.incident;
  let finalStatus: IncidentStatus = incident.status;

  if (result.isDuplicate && !RESUMABLE_INTAKE_STATUSES.has(incident.status)) {
    logger.info(
      {
        incidentId: incident.id,
        status: incident.status,
        idempotencyKey: job.data.idempotencyKey,
      },
      "[Healer Worker] Duplicate delivery for settled incident; skipping pipeline execution"
    );
    return {
      incidentId: incident.id,
      isDuplicate: true,
      status: finalStatus,
    };
  }

  if (result.isDuplicate) {
    logger.info(
      {
        incidentId: incident.id,
        status: incident.status,
        attemptsMade: intakeAttemptsMade,
      },
      "[Healer Worker] Resuming interrupted incident pipeline from durable checkpoint"
    );
  }

  const fingerprint =
    incident.fingerprint ||
    circuitBreakerService.getFingerprint(job.data.queueName, job.data.errorMessage);

  let isHalfOpenTrial = false;

  if (incident.status === "INGESTED") {
    // Check Circuit Breaker before expensive AI / RAG operations
    const breakerDecision = circuitBreakerService.canProcess(fingerprint);

    if (!breakerDecision.allowed) {
      logger.warn(
        {
          incidentId: incident.id,
          fingerprint,
          reason: breakerDecision.reason,
        },
        "[Healer Worker] Circuit breaker OPEN; fast-quarantining incident to prevent retry storm"
      );

      let quarantined = false;
      await prisma.$transaction(async (tx) => {
        const existingRow = await tx.incident
          .findUnique({
            where: { id: incident.id },
            select: { encryptedExecutionPayload: true },
          })
          .catch(() => null);
        quarantined = await transitionIncidentConditional(tx, {
          incidentId: incident.id,
          allowedFrom: ["INGESTED"],
          toStatus: "QUARANTINED",
          data: {
            fingerprint,
            ...(existingRow?.encryptedExecutionPayload != null
              ? { encryptedExecutionPayload: Prisma.DbNull }
              : {}),
          },
          actionName: "circuit breaker fast quarantine",
        });

        if (quarantined) {
          await tx.auditLog.create({
            data: {
              incidentId: incident.id,
              action: "CIRCUIT_BREAKER_TRIPPED",
              actor: "circuit-breaker",
              details: {
                fingerprint,
                state: breakerDecision.state,
                reason: breakerDecision.reason,
              },
            },
          });
        }
      });

      if (quarantined) {
        eventBroadcaster.broadcast("incident:quarantined", {
          incidentId: incident.id,
          status: "QUARANTINED",
          fingerprint,
          reason: breakerDecision.reason,
        });
      }

      return {
        incidentId: incident.id,
        isDuplicate: result.isDuplicate,
        status: "QUARANTINED" as IncidentStatus,
      };
    }

    isHalfOpenTrial = breakerDecision.state === "HALF_OPEN";

    // Only count failures once on the initial intake pass while CLOSED
    // (includes HTTP-ingested records whose fingerprint has not yet been recorded).
    const isInitialIntakePass = !result.isDuplicate || !incident.fingerprint;
    if (!isHalfOpenTrial && isInitialIntakePass) {
      circuitBreakerService.recordFailure(fingerprint);
    }
  }

  try {
    if (!incident.fingerprint) {
      // Persist error fingerprint on non-status metadata without altering state transitions
      await prisma.incident.update({
        where: { id: incident.id },
        data: { fingerprint },
      });
    }

    // Resume or execute RAG + AI Doctor triage if not yet PROPOSAL_READY
    if (
      finalStatus === "INGESTED" ||
      finalStatus === "ANALYZING" ||
      finalStatus === "RAG_MATCHED"
    ) {
      const triageResult = await triageService.diagnoseIncident(incident.id, {
        resume: result.isDuplicate || finalStatus !== "INGESTED",
        rethrowErrors: hasRetriesRemaining,
      });
      finalStatus = triageResult.status;
    }

    // Run or resume 5-Stage Deterministic Validation Gate if PROPOSAL_READY
    if (finalStatus === "PROPOSAL_READY") {
      const validationResult = await validationService.validateProposal(incident.id);
      finalStatus = validationResult.status;
    }

    if (isHalfOpenTrial) {
      if (finalStatus === "AWAITING_APPROVAL") {
        circuitBreakerService.recordSuccess(fingerprint);
      } else {
        // ANALYSIS_FAILED, SANDBOX_FAILED, or QUARANTINED failed to yield a
        // validated recovery plan; re-trip back to OPEN to keep storm dampening active.
        circuitBreakerService.recordFailure(fingerprint);
      }
    }
  } catch (matchErr: any) {
    if (matchErr instanceof AppError && matchErr.statusCode === 409) {
      if (isHalfOpenTrial) {
        circuitBreakerService.releaseHalfOpenTrial(fingerprint);
      }
      const latest = await prisma.incident
        .findUnique({
          where: { id: incident.id },
          select: { status: true },
        })
        .catch(() => null);
      logger.info(
        {
          incidentId: incident.id,
          currentStatus: latest?.status ?? finalStatus,
          err: matchErr.message,
        },
        "[Healer Worker] State transitioned concurrently; skipping ANALYSIS_FAILED overwrite"
      );
      return {
        incidentId: incident.id,
        isDuplicate: result.isDuplicate,
        status: latest?.status ?? finalStatus,
      };
    }

    if (isHalfOpenTrial) {
      circuitBreakerService.recordFailure(fingerprint);
    }

    if (hasRetriesRemaining && !isPermanentProcessingError(matchErr)) {
      logger.warn(
        {
          incidentId: incident.id,
          attemptsMade: intakeAttemptsMade,
          maxAttempts: intakeMaxAttempts,
          err: matchErr?.message,
        },
        "[Healer Worker] Transient error during intake processing; rethrowing for BullMQ retry"
      );
      throw matchErr;
    }

    finalStatus = "ANALYSIS_FAILED";
    const safeErrorMessage = sanitizeErrorMessage(
      matchErr?.message || "Unexpected triage/validation error"
    );
    logger.error(
      { incidentId: incident.id, err: safeErrorMessage },
      "[Healer Worker] AI Doctor triage/validation encountered a fatal error"
    );

    try {
      const current = await prisma.incident
        .findUnique({
          where: { id: incident.id },
          select: { status: true, encryptedExecutionPayload: true },
        })
        .catch(() => null);

      if (current && current.status !== "ANALYSIS_FAILED") {
        let markedFailed = false;
        await prisma.$transaction(async (tx) => {
          markedFailed = await transitionIncidentConditional(tx, {
            incidentId: incident.id,
            allowedFrom: [
              "INGESTED",
              "ANALYZING",
              "RAG_MATCHED",
              "PROPOSAL_READY",
            ],
            toStatus: "ANALYSIS_FAILED",
            ...(current.encryptedExecutionPayload != null
              ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
              : {}),
            actionName: "healer worker failure",
          });

          if (markedFailed) {
            await tx.auditLog.create({
              data: {
                incidentId: incident.id,
                action: "ANALYSIS_FAILED",
                actor: "healer-worker",
                details: {
                  error: safeErrorMessage,
                },
              },
            });
          }
        });

        if (markedFailed) {
          eventBroadcaster.broadcast("incident:failed", {
            incidentId: incident.id,
            status: "ANALYSIS_FAILED",
            error: safeErrorMessage,
          });
        } else {
          finalStatus = current.status;
        }
      } else if (current?.status === "ANALYSIS_FAILED") {
        finalStatus = "ANALYSIS_FAILED";
      }
    } catch (persistErr: any) {
      logger.error(
        { incidentId: incident.id, err: persistErr?.message },
        "[Healer Worker] Failed to persist ANALYSIS_FAILED fallback state"
      );
    }
  }

  return {
    incidentId: incident.id,
    isDuplicate: result.isDuplicate,
    status: finalStatus,
  };
}

export function startHealerWorker(queueName?: string): Worker<IncidentSnapshot> {
  if (healerWorker) {
    return healerWorker;
  }

  const intakeQueueName = queueName || getIntakeQueueName();
  logger.info(
    `[Healer Worker] Starting consumer for Smart DLQ [${intakeQueueName}]...`
  );

  healerWorker = new Worker<IncidentSnapshot>(
    intakeQueueName,
    async (job: Job<IncidentSnapshot>) => handleHealerJob(job),
    {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000,
      },
    }
  );

  healerWorker.on("completed", (job) => {
    logger.info(
      { intakeJobId: job.id, returnvalue: job.returnvalue },
      "[Healer Worker] Intake job processed and persisted"
    );
  });

  healerWorker.on("failed", (job, err) => {
    logger.error(
      { intakeJobId: job?.id, err: err.message },
      "[Healer Worker] Error processing intake job"
    );
  });

  healerWorker.on("error", (err) => {
    logger.error({ err: err.message }, "[Healer Worker] Worker runtime error");
  });

  return healerWorker;
}

export async function stopHealerWorker(): Promise<void> {
  if (healerWorker) {
    logger.info("[Healer Worker] Shutting down healer worker...");
    await healerWorker.close();
    healerWorker = null;
  }
}
