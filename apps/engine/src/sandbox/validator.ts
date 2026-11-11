import { compileJsonSchema } from "@dlq-healer/sdk";
import { checkInvariants } from "./invariants";
import { checkAllowedMutations } from "./policies";
import { RepairProposal } from "../services/llm.service";
import { getMaxReplayAttempts } from "../config/env";
import {
  assertSafeJsonValue,
  assertSafeMutationPath,
  findUnsafeObjectKey,
} from "./mutation-safety";

export interface ValidationStageResult {
  stage: number;
  name: string;
  passed: boolean;
  message?: string;
  details?: any;
}

export interface ValidationGateResult {
  passed: boolean;
  failedStage?: number;
  rejectionReason?: string;
  stages: ValidationStageResult[];
  diff: {
    original: Record<string, any>;
    proposed: Record<string, any>;
    mutations: any[];
  };
  validatedAt: string;
}

export interface ValidationContext {
  incident: {
    id: string;
    queueName: string;
    status: string;
    attemptsMade: number;
    configuredAttempts: number;
    payloadSnapshot: any;
    expectedJsonSchema?: any;
    lineageReplayCount?: number;
    replayDepth?: number;
    maxReplayAttempts?: number;
  };
  proposal: RepairProposal;
  proposedPayload: Record<string, any> | null;
  validationTargetPayload?: Record<string, any> | null;
}

export class DeterministicValidator {
  /**
   * Runs the 5-Stage Validation Gate sequentially on the proposed repair.
   * If any stage fails, execution halts and returns a failed result.
   */
  validate(context: ValidationContext): ValidationGateResult {
    const stages: ValidationStageResult[] = [];
    const { incident, proposal, proposedPayload, validationTargetPayload } = context;
    const original = (typeof incident.payloadSnapshot === "object" && incident.payloadSnapshot !== null)
      ? incident.payloadSnapshot
      : {};
    const proposed = proposedPayload || {};
    const schemaTarget =
      validationTargetPayload && typeof validationTargetPayload === "object"
        ? validationTargetPayload
        : proposed;

    // ── STAGE 1: Schema Validation ──
    const stage1 = this.runStage1SchemaValidation(schemaTarget, incident.expectedJsonSchema);
    stages.push(stage1);
    if (!stage1.passed) {
      return this.buildResult(false, 1, stage1.message, stages, original, proposed, proposal.mutations);
    }

    // ── STAGE 2: Invariant Check ──
    const stage2 = this.runStage2InvariantCheck(original, proposed, incident.queueName);
    stages.push(stage2);
    if (!stage2.passed) {
      return this.buildResult(false, 2, stage2.message, stages, original, proposed, proposal.mutations);
    }

    // ── STAGE 3: Allowed Mutations Check ──
    const stage3 = this.runStage3AllowedMutationsCheck(proposal.mutations, incident.queueName);
    stages.push(stage3);
    if (!stage3.passed) {
      return this.buildResult(false, 3, stage3.message, stages, original, proposed, proposal.mutations);
    }

    // ── STAGE 4: Replay Guard & State Check ──
    const stage4 = this.runStage4ReplayGuardCheck(incident, proposal);
    stages.push(stage4);
    if (!stage4.passed) {
      return this.buildResult(false, 4, stage4.message, stages, original, proposed, proposal.mutations);
    }

    // ── STAGE 5: Dry-Run Boundary Check ──
    const stage5 = this.runStage5DryRunBoundaryCheck(proposed, proposal);
    stages.push(stage5);
    if (!stage5.passed) {
      return this.buildResult(false, 5, stage5.message, stages, original, proposed, proposal.mutations);
    }

    // All 5 stages passed!
    return this.buildResult(true, undefined, undefined, stages, original, proposed, proposal.mutations);
  }

  // ── Stage 1 Implementation ──
  public validateSchema(proposed: Record<string, any>, expectedSchema?: any): ValidationStageResult {
    return this.runStage1SchemaValidation(proposed, expectedSchema);
  }

  private runStage1SchemaValidation(proposed: Record<string, any>, expectedSchema?: any): ValidationStageResult {
    if (!expectedSchema || typeof expectedSchema !== "object" || Array.isArray(expectedSchema)) {
      return { stage: 1, name: "Schema Validation", passed: true, message: "No schema constraint defined; passed." };
    }

    let validateFn: ReturnType<typeof compileJsonSchema>;
    try {
      validateFn = compileJsonSchema(expectedSchema);
    } catch (err: any) {
      return {
        stage: 1,
        name: "Schema Validation",
        passed: false,
        message: `Invalid expectedJsonSchema definition: ${err?.message || "Compilation failed"}`,
        details: { invalidSchema: true },
      };
    }

    const valid = validateFn(proposed);
    if (valid) {
      return { stage: 1, name: "Schema Validation", passed: true, message: "Proposed payload adheres to expected schema." };
    }

    const errors = validateFn.errors || [];
    const missingFields: string[] = [];
    const otherMessages: string[] = [];
    const sanitizedErrors: Array<{
      path: string;
      keyword: string;
      message?: string;
    }> = [];

    for (const err of errors) {
      const normalizedPath = err.instancePath
        ? err.instancePath.replace(/^\//, "").replace(/\//g, ".")
        : "";

      if (err.keyword === "required" && typeof err.params?.missingProperty === "string") {
        const missingField = err.params.missingProperty;
        if (!normalizedPath) {
          if (!missingFields.includes(missingField)) {
            missingFields.push(missingField);
          }
          sanitizedErrors.push({
            path: missingField,
            keyword: err.keyword,
            message: err.message,
          });
          continue;
        }
        otherMessages.push(`${normalizedPath}.${missingField} is required`);
        sanitizedErrors.push({
          path: `${normalizedPath}.${missingField}`,
          keyword: err.keyword,
          message: err.message,
        });
        continue;
      }

      const displayPath = normalizedPath || "payload";
      if (err.keyword === "enum" && Array.isArray(err.params?.allowedValues)) {
        otherMessages.push(
          `${displayPath} must be one of [${err.params.allowedValues.join(", ")}]`
        );
      } else {
        otherMessages.push(`${displayPath} ${err.message || "failed validation"}`);
      }

      sanitizedErrors.push({
        path: displayPath,
        keyword: err.keyword,
        message: err.message,
      });
    }

    const parts: string[] = [];
    if (missingFields.length > 0) {
      parts.push(`missing required fields [${missingFields.join(", ")}]`);
    }
    if (otherMessages.length > 0) {
      parts.push(...otherMessages);
    }

    return {
      stage: 1,
      name: "Schema Validation",
      passed: false,
      message: `Proposed payload violates schema: ${parts.join("; ") || "validation failed"}`,
      details: {
        ...(missingFields.length > 0 ? { missingFields } : {}),
        errors: sanitizedErrors,
      },
    };
  }

  // ── Stage 2 Implementation ──
  private runStage2InvariantCheck(original: Record<string, any>, proposed: Record<string, any>, queueName?: string): ValidationStageResult {
    const result = checkInvariants(original, proposed, queueName);
    if (!result.passed) {
      return {
        stage: 2,
        name: "Invariant Check",
        passed: false,
        message: `Immutable invariants violated: ${result.violations.join("; ")}`,
        details: { violations: result.violations },
      };
    }
    return { stage: 2, name: "Invariant Check", passed: true, message: "All immutable business invariants preserved." };
  }

  // ── Stage 3 Implementation ──
  private runStage3AllowedMutationsCheck(mutations: any[], queueName?: string): ValidationStageResult {
    for (const mut of mutations || []) {
      if (mut?.field) {
        try {
          assertSafeMutationPath(mut.field);
        } catch (err: any) {
          return {
            stage: 3,
            name: "Allowed Mutations",
            passed: false,
            message: err?.message || `Unsafe mutation field path rejected: "${mut.field}"`,
            details: { unauthorizedFields: [mut.field] },
          };
        }
      }
      try {
        assertSafeJsonValue(mut?.to, `mutation("${mut?.field || ""}")`);
      } catch (err: any) {
        return {
          stage: 3,
          name: "Allowed Mutations",
          passed: false,
          message: err?.message || `Unsafe mutation value rejected for "${mut?.field || ""}"`,
          details: { unauthorizedFields: mut?.field ? [mut.field] : [] },
        };
      }
    }

    const result = checkAllowedMutations(mutations || [], queueName);
    if (!result.passed) {
      return {
        stage: 3,
        name: "Allowed Mutations",
        passed: false,
        message: `Unauthorized mutation keys detected: [${result.unauthorizedFields.join(", ")}]`,
        details: { unauthorizedFields: result.unauthorizedFields },
      };
    }
    return { stage: 3, name: "Allowed Mutations", passed: true, message: "All proposed mutations are strictly whitelisted." };
  }

  // ── Stage 4 Implementation ──
  private runStage4ReplayGuardCheck(incident: any, proposal: RepairProposal): ValidationStageResult {
    const terminalStatuses = ["RESOLVED", "REPLAYING", "REPLAY_QUEUED"];
    if (terminalStatuses.includes(incident.status)) {
      return {
        stage: 4,
        name: "Replay Guard",
        passed: false,
        message: `Incident is in state "${incident.status}" and cannot accept a new recovery proposal.`,
      };
    }

    if (proposal.action === "QUARANTINE") {
      return {
        stage: 4,
        name: "Replay Guard",
        passed: false,
        message: "Proposal specifies action QUARANTINE; recovery replay is prohibited.",
      };
    }

    const maxBudget = incident.configuredAttempts * 3;
    if (incident.attemptsMade >= maxBudget) {
      return {
        stage: 4,
        name: "Replay Guard",
        passed: false,
        message: `Exceeded total attempt budget (${incident.attemptsMade} attempts >= ceiling ${maxBudget}).`,
      };
    }

    const maxReplayAttempts =
      incident.maxReplayAttempts ?? getMaxReplayAttempts();
    const lineageReplayCount = incident.lineageReplayCount ?? 0;
    const replayDepth = incident.replayDepth ?? 0;

    if (
      lineageReplayCount >= maxReplayAttempts ||
      replayDepth >= maxReplayAttempts
    ) {
      return {
        stage: 4,
        name: "Replay Guard",
        passed: false,
        message: `REPLAY_LIMIT_EXCEEDED: Lineage replay budget exhausted (${lineageReplayCount} replays, depth ${replayDepth}, ceiling ${maxReplayAttempts}).`,
        details: {
          code: "REPLAY_LIMIT_EXCEEDED",
          lineageReplayCount,
          replayDepth,
          maxReplayAttempts,
        },
      };
    }

    return { stage: 4, name: "Replay Guard", passed: true, message: "Incident state and replay budget verified." };
  }

  // ── Stage 5 Implementation ──
  private runStage5DryRunBoundaryCheck(proposed: Record<string, any>, _proposal: RepairProposal): ValidationStageResult {
    if (!proposed || typeof proposed !== "object") {
      return {
        stage: 5,
        name: "Dry-Run Boundary",
        passed: false,
        message: "Proposed payload is not a valid JSON object.",
      };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(proposed);
    } catch (e: any) {
      return {
        stage: 5,
        name: "Dry-Run Boundary",
        passed: false,
        message: `Payload serialization error: ${e.message}`,
      };
    }

    // Size limit check (1MB)
    if (serialized.length > 1024 * 1024) {
      return {
        stage: 5,
        name: "Dry-Run Boundary",
        passed: false,
        message: `Proposed payload exceeds 1MB safety threshold (${serialized.length} bytes).`,
      };
    }

    // Own-key prototype pollution inspection on object structure directly
    const unsafeKeyPath = findUnsafeObjectKey(proposed);
    if (unsafeKeyPath) {
      return {
        stage: 5,
        name: "Dry-Run Boundary",
        passed: false,
        message: `Malicious injection pattern detected in proposed payload: unsafe key "${unsafeKeyPath}".`,
      };
    }

    // Prototype pollution & malicious injection check
    const dangerousPatterns = ["__proto__", "constructor.prototype", "<script", "javascript:"];
    for (const pattern of dangerousPatterns) {
      if (serialized.includes(pattern)) {
        return {
          stage: 5,
          name: "Dry-Run Boundary",
          passed: false,
          message: `Malicious injection pattern detected in proposed payload: "${pattern}".`,
        };
      }
    }

    return { stage: 5, name: "Dry-Run Boundary", passed: true, message: "Dry-run boundary and structural integrity confirmed." };
  }

  private buildResult(
    passed: boolean,
    failedStage: number | undefined,
    rejectionReason: string | undefined,
    stages: ValidationStageResult[],
    original: Record<string, any>,
    proposed: Record<string, any>,
    mutations: any[]
  ): ValidationGateResult {
    return {
      passed,
      failedStage,
      rejectionReason,
      stages,
      diff: {
        original,
        proposed,
        mutations: mutations || [],
      },
      validatedAt: new Date().toISOString(),
    };
  }
}

export const deterministicValidator = new DeterministicValidator();
