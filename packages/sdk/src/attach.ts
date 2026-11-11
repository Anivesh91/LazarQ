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
  close: () => Promise<void>;
}

const RECOVERY_JOB_ID_PATTERN =
  /^recovery-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-)?\d+$/i;

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

  const failureHandler = async (job: Job | undefined, err: unknown) => {
    if (!job) return;

    const rawJobId =
      job.id !== undefined && job.id !== null ? String(job.id) : "";

    if (!config.captureReplayFailures && RECOVERY_JOB_ID_PATTERN.test(rawJobId)) {
      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] Skipping failure capture for replay recovery Job #${rawJobId} (tracked by ReplayResultObserver).`
        );
      }
      return;
    }

    const configuredAttempts = job.opts?.attempts || 1;
    const attemptsMade = job.attemptsMade ?? 0;

    // ── Critical: Only capture terminal failures (exhausted retries) ──
    if (attemptsMade < configuredAttempts) {
      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] Intermediate retry failure for Job #${rawJobId || "unknown"} (${attemptsMade}/${configuredAttempts}). Skipping capture.`
        );
      }
      return;
    }

    const safeJobId = rawJobId || `${Date.now()}`;
    const errorMessage =
      err instanceof Error
        ? err.message || String(err)
        : typeof err === "string"
        ? err
        : String(err ?? "Unknown error");
    const stackTrace = err instanceof Error ? err.stack : undefined;

    try {
      const sanitizedPayload = redactPayload(job.data, config.redactFields);
      const idempotencyKey = `${worker.name}:${safeJobId}:${attemptsMade}`;

      const snapshot: IncidentSnapshot = {
        idempotencyKey,
        source: config.sourceId,
        queueName: worker.name,
        jobId: safeJobId,
        jobName: job.name,
        payloadSnapshot: sanitizedPayload,
        expectedJsonSchema: config.expectedJsonSchema,
        errorMessage,
        stackTrace,
        attemptsMade,
        configuredAttempts,
        occurredAt: new Date().toISOString(),
      };

      if (config.enableLogging) {
        console.warn(
          `[DLQ-Healer SDK] 🚨 Terminal failure detected! Publishing Job #${safeJobId} to Smart DLQ [${config.intakeQueueName}]...`
        );
      }

      await publisher.publish(snapshot);

      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] ✅ Snapshot published successfully (Key: ${idempotencyKey})`
        );
      }
    } catch (publishErr: unknown) {
      const publishMsg =
        publishErr instanceof Error ? publishErr.message : String(publishErr);
      console.error(
        `[DLQ-Healer SDK] ❌ Failed to publish terminal failure for Job #${safeJobId}:`,
        publishMsg
      );
    }
  };

  worker.on("failed", failureHandler);

  const detach = () => {
    worker.off("failed", failureHandler);
  };

  return {
    attached: true,
    workerName: worker.name,
    publisher,
    detach,
    close: async () => {
      detach();
      await publisher.close();
    },
  };
}
