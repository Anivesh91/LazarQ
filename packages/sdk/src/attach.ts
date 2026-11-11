import { Worker, Job, UnrecoverableError } from "bullmq";
import { DLQHealerConfig, IncidentSnapshot } from "./types";
import { resolveConfig } from "./config";
import {
  collectSensitiveValues,
  redactErrorText,
  redactPayload,
} from "./redaction";
import { encryptReplayPayload } from "./crypto";
import { SmartDLQPublisher } from "./publisher";

export interface AttachedDLQHealer {
  attached: boolean;
  workerName: string;
  publisher: SmartDLQPublisher;
  detach: () => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

const RECOVERY_JOB_ID_PATTERN =
  /^recovery-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?|\d+)$/i;

function isUnrecoverableErrorInstance(err: unknown): boolean {
  if (err instanceof UnrecoverableError) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "UnrecoverableError"
  );
}

async function isTerminalJobFailure(
  job: Job,
  err: unknown,
  configuredAttempts: number,
  attemptsMade: number
): Promise<boolean> {
  if (isUnrecoverableErrorInstance(err)) {
    return true;
  }

  const jobMeta = job as unknown as {
    discarded?: unknown;
    finishedOn?: unknown;
    isFailed?: () => Promise<boolean>;
  };

  if (Boolean(jobMeta.discarded)) {
    return true;
  }

  // BullMQ sets finishedOn ONLY when moving a job to terminal completion/failure
  // (covers custom backoff strategies returning -1).
  if (typeof jobMeta.finishedOn === "number") {
    return true;
  }

  if (attemptsMade >= configuredAttempts) {
    return true;
  }

  if (typeof jobMeta.isFailed === "function") {
    try {
      if (await jobMeta.isFailed()) {
        return true;
      }
    } catch {
      // Fall back to false if Redis inspection fails on intermediate attempt
    }
  }

  return false;
}

/**
 * Attaches DLQ-Healer failure capture hook to an existing BullMQ Worker.
 * Captures terminal failures (attempt exhaustion, UnrecoverableError, discarded jobs,
 * or terminal backoff stops) and tracks in-flight publishes for clean shutdown.
 */
export function attachDLQHealer(
  worker: Worker,
  userConfig?: DLQHealerConfig
): AttachedDLQHealer {
  const config = resolveConfig(userConfig);
  const publisher = new SmartDLQPublisher(
    config.intakeQueueName,
    config.redisConnection || config.redisUrl,
    {
      publishMaxAttempts: config.publishMaxAttempts,
      fallbackHttpUrl: config.fallbackHttpUrl,
      engineApiKey: config.engineApiKey,
      onPublishFailed: config.onPublishFailed,
    }
  );
  const inFlightPublishes = new Set<Promise<void>>();

  const processFailure = async (job: Job | undefined, err: unknown) => {
    if (!job) return;

    const rawJobId =
      job.id !== undefined && job.id !== null ? String(job.id) : "";
    const rawLineage = (job.opts as any)?.dlqLineage;
    const hasValidLineage =
      Boolean(rawLineage) &&
      typeof rawLineage === "object" &&
      typeof rawLineage.parentIncidentId === "string" &&
      rawLineage.parentIncidentId.trim().length > 0;

    if (
      !config.captureReplayFailures &&
      (RECOVERY_JOB_ID_PATTERN.test(rawJobId) || hasValidLineage)
    ) {
      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] Skipping failure capture for replay recovery Job #${rawJobId} (tracked by ReplayResultObserver).`
        );
      }
      return;
    }

    const configuredAttempts =
      job.opts?.attempts && job.opts.attempts > 0 ? job.opts.attempts : 1;
    const attemptsMade = job.attemptsMade ?? 0;

    // ── Critical: Capture any terminal failure (exhausted retries, UnrecoverableError, discarded, finishedOn, or failed state) ──
    const isTerminal = await isTerminalJobFailure(
      job,
      err,
      configuredAttempts,
      attemptsMade
    );
    if (!isTerminal) {
      if (config.enableLogging) {
        console.log(
          `[DLQ-Healer SDK] Intermediate retry failure for Job #${rawJobId || "unknown"} (${attemptsMade}/${configuredAttempts}). Skipping capture.`
        );
      }
      return;
    }

    const safeJobId = rawJobId || `${Date.now()}`;
    const rawErrorMessage =
      err instanceof Error
        ? err.message || String(err)
        : typeof err === "string"
        ? err
        : String(err ?? "Unknown error");
    const rawStackTrace = err instanceof Error ? err.stack : undefined;

    try {
      const sensitiveValues = collectSensitiveValues(
        job.data,
        config.redactFields
      );
      const sanitizedPayload = redactPayload(job.data, config.redactFields);
      const errorMessage = redactErrorText(rawErrorMessage, sensitiveValues);
      const stackTrace = rawStackTrace
        ? redactErrorText(rawStackTrace, sensitiveValues)
        : undefined;

      const replayEnvelope =
        config.payloadEncryptionKey &&
        job.data &&
        typeof job.data === "object" &&
        !Array.isArray(job.data)
          ? encryptReplayPayload(job.data, config.payloadEncryptionKey)
          : undefined;

      const idempotencyKey = `${config.sourceId}:${worker.name}:${safeJobId}:${attemptsMade}`;

      const lineage = hasValidLineage
        ? {
            ...(typeof rawLineage.lineageRootId === "string" &&
            rawLineage.lineageRootId.trim().length > 0
              ? { lineageRootId: rawLineage.lineageRootId.trim() }
              : {}),
            parentIncidentId: rawLineage.parentIncidentId.trim(),
            ...(typeof rawLineage.replayDepth === "number" &&
            Number.isInteger(rawLineage.replayDepth) &&
            rawLineage.replayDepth >= 0
              ? { replayDepth: rawLineage.replayDepth }
              : {}),
          }
        : undefined;

      const snapshot: IncidentSnapshot = {
        idempotencyKey,
        source: config.sourceId,
        queueName: worker.name,
        jobId: safeJobId,
        jobName: job.name,
        payloadSnapshot: sanitizedPayload,
        ...(replayEnvelope ? { replayEnvelope } : {}),
        expectedJsonSchema: config.expectedJsonSchema,
        errorMessage,
        stackTrace,
        attemptsMade,
        configuredAttempts,
        occurredAt: new Date().toISOString(),
        ...(lineage ? { lineage } : {}),
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
        redactErrorText(publishMsg)
      );
    }
  };

  const failureHandler = (job: Job | undefined, err: unknown) => {
    const tracked = processFailure(job, err).finally(() => {
      inFlightPublishes.delete(tracked);
    });
    inFlightPublishes.add(tracked);
    return tracked;
  };

  worker.on("failed", failureHandler);

  const detach = () => {
    worker.off("failed", failureHandler);
  };

  const flush = async () => {
    while (inFlightPublishes.size > 0) {
      await Promise.allSettled(Array.from(inFlightPublishes));
    }
  };

  return {
    attached: true,
    workerName: worker.name,
    publisher,
    detach,
    flush,
    close: async () => {
      detach();
      await flush();
      await publisher.close();
    },
  };
}
