import {
  DEFAULT_REDACT_FIELDS,
  IncidentSnapshot,
  collectSensitiveValues,
  decryptReplayPayload,
  encryptReplayPayload,
  hasRedactedPlaceholder,
  redactErrorText,
  redactPayload,
  validateJsonSchemaDefinition,
} from "@dlq-healer/sdk";
import { AppError } from "../middleware/error-handler";
import { getPayloadEncryptionKey } from "../config/env";
import { queueReinjector } from "../replay/reinjector";
import { checkInvariants } from "../sandbox/invariants";
import {
  applyMutations,
  isPlainObject,
  safeCloneJson,
} from "../sandbox/mutation-safety";
import { RepairProposal } from "./llm.service";

export type ResolvedPayloadResult =
  | {
      ok: true;
      source: "encrypted" | "redis-fallback" | "snapshot";
      payload: Record<string, any>;
    }
  | {
      ok: false;
      reason:
        | "ENCRYPTION_KEY_MISSING"
        | "PAYLOAD_DECRYPTION_FAILED"
        | "REDACTED_PAYLOAD_UNREPLAYABLE";
      error: string;
    };

export function sanitizeIncidentForView<T>(incident: T): T {
  if (!incident || typeof incident !== "object") {
    return incident;
  }
  const { encryptedExecutionPayload: _omitted, ...rest } = incident as Record<
    string,
    any
  >;
  return rest as T;
}

export function sanitizeErrorMessage(
  text: string | null | undefined,
  sensitiveValues: string[] = []
): string {
  if (!text) return "";
  return redactErrorText(text, sensitiveValues);
}

export function prepareIngestSnapshotData(snapshot: IncidentSnapshot): {
  sanitizedPayload: Record<string, any>;
  sanitizedErrorMessage: string;
  sanitizedStackTrace: string | null;
  encryptedExecutionPayload: Record<string, any> | undefined;
} {
  if (
    snapshot.expectedJsonSchema !== undefined &&
    snapshot.expectedJsonSchema !== null
  ) {
    const schemaCheck = validateJsonSchemaDefinition(
      snapshot.expectedJsonSchema
    );
    if (!schemaCheck.valid) {
      throw new AppError(
        `Invalid expectedJsonSchema: ${schemaCheck.error}`,
        400,
        "INVALID_JSON_SCHEMA"
      );
    }
  }

  const rawPayload = isPlainObject(snapshot.payloadSnapshot)
    ? snapshot.payloadSnapshot
    : ((snapshot.payloadSnapshot || {}) as Record<string, any>);

  const sensitiveValues = collectSensitiveValues(
    rawPayload,
    DEFAULT_REDACT_FIELDS
  );

  const sanitizedPayload = redactPayload(rawPayload, DEFAULT_REDACT_FIELDS);
  const sanitizedErrorMessage = redactErrorText(
    snapshot.errorMessage,
    sensitiveValues
  );
  const sanitizedStackTrace = snapshot.stackTrace
    ? redactErrorText(snapshot.stackTrace, sensitiveValues)
    : null;

  let encryptedExecutionPayload: Record<string, any> | undefined;
  if (snapshot.replayEnvelope !== undefined && snapshot.replayEnvelope !== null) {
    const env = snapshot.replayEnvelope as Record<string, any>;
    if (
      env.v !== 1 ||
      env.alg !== "aes-256-gcm" ||
      typeof env.iv !== "string" ||
      typeof env.tag !== "string" ||
      typeof env.ct !== "string"
    ) {
      throw new AppError(
        "Malformed replayEnvelope payload",
        400,
        "INVALID_REPLAY_ENVELOPE"
      );
    }
    encryptedExecutionPayload = {
      v: 1,
      alg: "aes-256-gcm",
      iv: env.iv,
      tag: env.tag,
      ct: env.ct,
    };
  } else if (isPlainObject(rawPayload) && !hasRedactedPlaceholder(rawPayload)) {
    const encryptionKey = getPayloadEncryptionKey();
    if (encryptionKey) {
      encryptedExecutionPayload = encryptReplayPayload(rawPayload, encryptionKey);
    }
  }

  return {
    sanitizedPayload,
    sanitizedErrorMessage,
    sanitizedStackTrace,
    encryptedExecutionPayload,
  };
}

export async function resolveOriginalExecutionPayload(incident: {
  queueName: string;
  jobId: string;
  payloadSnapshot: any;
  encryptedExecutionPayload?: any;
}): Promise<ResolvedPayloadResult> {
  if (incident.encryptedExecutionPayload != null) {
    const key = getPayloadEncryptionKey();
    if (!key) {
      return {
        ok: false,
        reason: "ENCRYPTION_KEY_MISSING",
        error:
          "DLQ_PAYLOAD_ENCRYPTION_KEY is required to decrypt sealed execution payload",
      };
    }

    try {
      const decrypted = decryptReplayPayload(
        incident.encryptedExecutionPayload,
        key
      );
      return {
        ok: true,
        source: "encrypted",
        payload: safeCloneJson(decrypted),
      };
    } catch (err: any) {
      return {
        ok: false,
        reason: "PAYLOAD_DECRYPTION_FAILED",
        error: `Failed to decrypt sealed execution payload: ${err?.message || "Invalid key or corrupted envelope"}`,
      };
    }
  }

  if (process.env.NODE_ENV !== "production") {
    try {
      const sourceQueue = queueReinjector.getQueue(incident.queueName);
      const sourceJob = await sourceQueue.getJob(incident.jobId);
      if (
        sourceJob &&
        isPlainObject(sourceJob.data) &&
        !hasRedactedPlaceholder(sourceJob.data)
      ) {
        return {
          ok: true,
          source: "redis-fallback",
          payload: safeCloneJson(sourceJob.data),
        };
      }
    } catch {
      // Redis fallback is best-effort in non-production environments
    }
  }

  const snapshot = isPlainObject(incident.payloadSnapshot)
    ? incident.payloadSnapshot
    : {};

  if (!hasRedactedPlaceholder(snapshot)) {
    return {
      ok: true,
      source: "snapshot",
      payload: safeCloneJson(snapshot),
    };
  }

  return {
    ok: false,
    reason: "REDACTED_PAYLOAD_UNREPLAYABLE",
    error:
      "Cannot replay incident because sensitive payload fields are redacted and no encrypted execution payload or unredacted source job is available.",
  };
}

export async function buildExecutionReplayPayload(params: {
  incident: {
    id: string;
    queueName: string;
    jobId: string;
    payloadSnapshot: any;
    encryptedExecutionPayload?: any;
  };
  proposal?: RepairProposal | null;
  fallbackProposedPayload: Record<string, any>;
}): Promise<Record<string, any>> {
  const { incident, proposal, fallbackProposedPayload } = params;

  // Non-redacted incidents without an encrypted envelope already carry their
  // invariant-verified execution payload inside fallbackProposedPayload.
  if (
    incident.encryptedExecutionPayload == null &&
    !hasRedactedPlaceholder(fallbackProposedPayload)
  ) {
    return safeCloneJson(fallbackProposedPayload);
  }

  const baseResolution = await resolveOriginalExecutionPayload(incident);
  if (!baseResolution.ok) {
    throw new AppError(baseResolution.error, 409, baseResolution.reason);
  }

  const basePayload = baseResolution.payload;
  const execPayload =
    proposal?.action === "MUTATE_AND_RETRY"
      ? applyMutations(basePayload, proposal.mutations || [])
      : safeCloneJson(basePayload);

  if (hasRedactedPlaceholder(execPayload)) {
    throw new AppError(
      "Reconstructed execution payload still contains [REDACTED] placeholders; aborting replay.",
      409,
      "REDACTED_PAYLOAD_UNREPLAYABLE"
    );
  }

  const invariantCheck = checkInvariants(
    basePayload,
    execPayload,
    incident.queueName
  );
  if (!invariantCheck.passed) {
    throw new AppError(
      `Replay rejected by safety invariant guard: ${invariantCheck.violations.join(", ")}`,
      422,
      "INVARIANT_VIOLATION"
    );
  }

  return execPayload;
}
