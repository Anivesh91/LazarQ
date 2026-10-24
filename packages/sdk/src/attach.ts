import { Worker, Job } from "bullmq";
import { DLQHealerConfig, IncidentSnapshot } from "./types";
import { resolveConfig } from "./config";
import { redactPayload } from "./redaction";
import { SmartDLQPublisher } from "./publisher";

export interface AttachedDLQHealer {
  attached: boolean;
  workerName: string;
  publisher: SmartDLQPublisher;
  detach: () => void;
}

/**
 * Attaches DLQ-Healer failure capture hook to an existing BullMQ Worker.
 * Only triggers when a job permanently exhausts all configured retry attempts.
 */
export function attachDLQHealer(
  worker: Worker,
  userConfig?: DLQHealerConfig
): AttachedDLQHealer {
  const config = resolveConfig(userConfig);
  const publisher = new SmartDLQPublisher(
    config.intakeQueueName,
    config.redisConnection || config.redisUrl
  );

  const failureHandler = async (job: Job | undefined, err: Error) => {
    if (!job) return;

    const configuredAttempts = job.opts.attempts || 1;
    const attemptsMade = job.attemptsMade;

    // ── Critical: Only capture terminal failures (exhausted retries) ──
    if (attemptsMade < configuredAttempts) {
      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] Intermediate retry failure for Job #${job.id} (${attemptsMade}/${configuredAttempts}). Skipping capture.`
        );
      }
      return;
    }

    try {
      const sanitizedPayload = redactPayload(job.data, config.redactFields);
      const idempotencyKey = `${worker.name}:${job.id}:${attemptsMade}`;

      const snapshot: IncidentSnapshot = {
        idempotencyKey,
        source: config.sourceId,
        queueName: worker.name,
        jobId: String(job.id),
        jobName: job.name,
        payloadSnapshot: sanitizedPayload,
        expectedJsonSchema: config.expectedJsonSchema,
        errorMessage: err.message,
        stackTrace: err.stack,
        attemptsMade,
        configuredAttempts,
        occurredAt: new Date().toISOString(),
      };

      if (config.enableLogging) {
        console.warn(
          `[DLQ-Healer SDK] 🚨 Terminal failure detected! Publishing Job #${job.id} to Smart DLQ [${config.intakeQueueName}]...`
        );
      }

      await publisher.publish(snapshot);

      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] ✅ Snapshot published successfully (Key: ${idempotencyKey})`
        );
      }
    } catch (publishErr: any) {
      console.error(
        `[DLQ-Healer SDK] ❌ Failed to publish terminal failure for Job #${job.id}:`,
        publishErr.message
      );
    }
  };

  worker.on("failed", failureHandler);

  return {
    attached: true,
    workerName: worker.name,
    publisher,
    detach: () => {
      worker.off("failed", failureHandler);
    },
  };
}
