import { Worker, Job } from "bullmq";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { incidentService } from "../services/incident.service";
import { triageService } from "../services/triage.service";
import { validationService } from "../services/validation.service";
import { circuitBreakerService } from "../services/circuit-breaker.service";
import { eventBroadcaster } from "../services/event-broadcaster.service";
import { prisma } from "../db/prisma";
import { IncidentSnapshot } from "@dlq-healer/sdk";

export const INTAKE_QUEUE_NAME = "dlq-healer-intake";

let healerWorker: Worker<IncidentSnapshot> | null = null;

export async function handleHealerJob(
  job: Pick<Job<IncidentSnapshot>, "id" | "data">
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

  const result = await incidentService.ingestSnapshot(job.data);

  // Automatically trigger RAG + AI Doctor triage + Validation Gate for non-duplicate incidents
  let finalStatus = result.incident.status;
  if (!result.isDuplicate) {
    const fingerprint = circuitBreakerService.getFingerprint(
      job.data.queueName,
      job.data.errorMessage
    );

    // Check Circuit Breaker before expensive AI / RAG operations
    const breakerDecision = circuitBreakerService.canProcess(fingerprint);

    if (!breakerDecision.allowed) {
      logger.warn(
        {
          incidentId: result.incident.id,
          fingerprint,
          reason: breakerDecision.reason,
        },
        "[Healer Worker] Circuit breaker OPEN; fast-quarantining incident to prevent retry storm"
      );

      await prisma.$transaction([
        prisma.incident.update({
          where: { id: result.incident.id },
          data: {
            status: "QUARANTINED",
            fingerprint,
          },
        }),
        prisma.auditLog.create({
          data: {
            incidentId: result.incident.id,
            action: "CIRCUIT_BREAKER_TRIPPED",
            actor: "circuit-breaker",
            details: {
              fingerprint,
              state: breakerDecision.state,
              reason: breakerDecision.reason,
            },
          },
        }),
      ]);

      return {
        incidentId: result.incident.id,
        isDuplicate: result.isDuplicate,
        status: "QUARANTINED",
      };
    }

    const isHalfOpenTrial = breakerDecision.state === "HALF_OPEN";

    // Only count new failures while CLOSED; in HALF_OPEN, let trial outcome decide recovery vs re-trip
    if (!isHalfOpenTrial) {
      circuitBreakerService.recordFailure(fingerprint);
    }

    try {
      // Associate fingerprint with incident record
      await prisma.incident.update({
        where: { id: result.incident.id },
        data: { fingerprint },
      });

      const triageResult = await triageService.diagnoseIncident(result.incident.id);
      finalStatus = triageResult.status;

      // If proposal is ready, run through 5-Stage Deterministic Validation Gate
      if (triageResult.status === "PROPOSAL_READY") {
        const validationResult = await validationService.validateProposal(result.incident.id);
        finalStatus = validationResult.status;
      }

      if (isHalfOpenTrial) {
        if (finalStatus === "ANALYSIS_FAILED") {
          circuitBreakerService.recordFailure(fingerprint);
        } else {
          circuitBreakerService.recordSuccess(fingerprint);
        }
      }
    } catch (matchErr: any) {
      if (isHalfOpenTrial) {
        circuitBreakerService.recordFailure(fingerprint);
      }

      finalStatus = "ANALYSIS_FAILED";
      logger.error(
        { incidentId: result.incident.id, err: matchErr?.message },
        "[Healer Worker] AI Doctor triage/validation encountered an unexpected error"
      );

      try {
        const current = await prisma.incident
          .findUnique({
            where: { id: result.incident.id },
            select: { status: true },
          })
          .catch(() => null);

        if (current?.status !== "ANALYSIS_FAILED") {
          await prisma.$transaction([
            prisma.incident.update({
              where: { id: result.incident.id },
              data: { status: "ANALYSIS_FAILED" },
            }),
            prisma.auditLog.create({
              data: {
                incidentId: result.incident.id,
                action: "ANALYSIS_FAILED",
                actor: "healer-worker",
                details: { error: matchErr?.message || "Unexpected triage/validation error" },
              },
            }),
          ]);
        }

        eventBroadcaster.broadcast("incident:failed", {
          incidentId: result.incident.id,
          status: "ANALYSIS_FAILED",
          error: matchErr?.message || "Unexpected triage/validation error",
        });
      } catch (persistErr: any) {
        logger.error(
          { incidentId: result.incident.id, err: persistErr?.message },
          "[Healer Worker] Failed to persist ANALYSIS_FAILED fallback state"
        );
      }
    }
  }

  return {
    incidentId: result.incident.id,
    isDuplicate: result.isDuplicate,
    status: finalStatus,
  };
}

export function startHealerWorker(): Worker<IncidentSnapshot> {
  if (healerWorker) {
    return healerWorker;
  }

  logger.info(
    `[Healer Worker] Starting consumer for Smart DLQ [${INTAKE_QUEUE_NAME}]...`
  );

  healerWorker = new Worker<IncidentSnapshot>(
    INTAKE_QUEUE_NAME,
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
