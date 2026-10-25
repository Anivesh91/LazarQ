import { Worker, Job } from "bullmq";
import { redis } from "../config/redis";
import { logger } from "../config/logger";
import { incidentService } from "../services/incident.service";
import { triageService } from "../services/triage.service";
import { IncidentSnapshot } from "@dlq-healer/sdk";

export const INTAKE_QUEUE_NAME = "dlq-healer-intake";

let healerWorker: Worker<IncidentSnapshot> | null = null;

export function startHealerWorker(): Worker<IncidentSnapshot> {
  if (healerWorker) {
    return healerWorker;
  }

  logger.info(
    `[Healer Worker] Starting consumer for Smart DLQ [${INTAKE_QUEUE_NAME}]...`
  );

  healerWorker = new Worker<IncidentSnapshot>(
    INTAKE_QUEUE_NAME,
    async (job: Job<IncidentSnapshot>) => {
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

      // Automatically trigger RAG + AI Doctor triage for non-duplicate incidents
      let triageResult = null;
      if (!result.isDuplicate) {
        try {
          triageResult = await triageService.diagnoseIncident(result.incident.id);
        } catch (matchErr: any) {
          logger.error(
            { incidentId: result.incident.id, err: matchErr.message },
            "[Healer Worker] AI Doctor triage encountered an unexpected error"
          );
        }
      }

      return {
        incidentId: result.incident.id,
        isDuplicate: result.isDuplicate,
        status: triageResult ? triageResult.status : result.incident.status,
      };
    },
    {
      connection: redis,
      concurrency: 5,
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
