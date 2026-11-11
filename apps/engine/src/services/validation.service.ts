import { Prisma } from "@prisma/client";
import { hasRedactedPlaceholder } from "@dlq-healer/sdk";
import { prisma } from "../db/prisma";
import { deterministicValidator, ValidationGateResult } from "../sandbox/validator";
import { applyMutations, safeCloneJson } from "../sandbox/mutation-safety";
import { RepairProposal } from "./llm.service";
import { eventBroadcaster } from "./event-broadcaster.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { getMaxReplayAttempts } from "../config/env";
import {
  assertAndTransitionIncident,
  countLineageReplayAttempts,
} from "./incident-state";
import { resolveOriginalExecutionPayload } from "./execution-payload.service";

export interface ValidateIncidentResult {
  incidentId: string;
  status: "AWAITING_APPROVAL" | "SANDBOX_FAILED";
  validation: ValidationGateResult;
}

export class ValidationService {
  /**
   * Executes the 5-Stage Validation Gate on an incident's proposed repair plan.
   * Updates incident status to AWAITING_APPROVAL on pass, or SANDBOX_FAILED on rejection.
   */
  async validateProposal(incidentId: string): Promise<ValidateIncidentResult> {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    if (!incident) {
      throw new AppError(`Incident with id ${incidentId} not found`, 404, "NOT_FOUND");
    }

    if (incident.status !== "PROPOSAL_READY") {
      throw new AppError(
        `Cannot validate incident ${incidentId} in current status "${incident.status}". Expected "PROPOSAL_READY".`,
        409,
        "INVALID_STATE_TRANSITION"
      );
    }

    if (!incident.aiDiagnosis) {
      throw new AppError(
        `Incident ${incidentId} does not have a generated AI proposal to validate`,
        400,
        "MISSING_PROPOSAL"
      );
    }

    const proposal = incident.aiDiagnosis as unknown as RepairProposal;
    const proposedPayload = incident.proposedPayload as Record<string, any> | null;
    const lineageRootId = incident.lineageRootId || incident.id;
    const lineageReplayCount = await countLineageReplayAttempts(
      prisma,
      lineageRootId
    );
    const maxReplayAttempts = getMaxReplayAttempts();

    logger.info({ incidentId, proposalAction: proposal.action }, "Executing 5-Stage Validation Gate");

    let validationTargetPayload: Record<string, any> | null = null;
    if (
      incident.expectedJsonSchema &&
      (incident.encryptedExecutionPayload != null ||
        hasRedactedPlaceholder(proposedPayload))
    ) {
      const resolvedBase = await resolveOriginalExecutionPayload(incident);
      if (resolvedBase.ok) {
        try {
          validationTargetPayload =
            proposal.action === "MUTATE_AND_RETRY"
              ? applyMutations(resolvedBase.payload, proposal.mutations || [])
              : safeCloneJson(resolvedBase.payload);
        } catch {
          // Safe fallback: let Stage 3 report unsafe mutation path/value cleanly
          validationTargetPayload = null;
        }
      }
    }

    const validation = deterministicValidator.validate({
      incident: {
        id: incident.id,
        queueName: incident.queueName,
        status: incident.status,
        attemptsMade: incident.attemptsMade,
        configuredAttempts: incident.configuredAttempts,
        payloadSnapshot: incident.payloadSnapshot,
        expectedJsonSchema: incident.expectedJsonSchema,
        lineageReplayCount,
        replayDepth: incident.replayDepth ?? 0,
        maxReplayAttempts,
      },
      proposal,
      proposedPayload,
      validationTargetPayload,
    });

    const newStatus = validation.passed ? "AWAITING_APPROVAL" : "SANDBOX_FAILED";
    const shouldPurgeEncryptedPayload =
      newStatus === "SANDBOX_FAILED" && incident.encryptedExecutionPayload != null;

    await prisma.$transaction(async (tx) => {
      await assertAndTransitionIncident(tx, {
        incidentId,
        allowedFrom: ["PROPOSAL_READY"],
        toStatus: newStatus,
        data: {
          validationResult: validation as any,
          ...(shouldPurgeEncryptedPayload
            ? { encryptedExecutionPayload: Prisma.DbNull }
            : {}),
        },
        actionName: "5-stage validation commit",
      });

      await tx.auditLog.create({
        data: {
          incidentId,
          action: newStatus,
          actor: "validation-gate",
          details: {
            passed: validation.passed,
            failedStage: validation.failedStage,
            rejectionReason: validation.rejectionReason,
            totalStages: validation.stages.length,
          },
        },
      });
    });

    logger.info(
      {
        incidentId,
        status: newStatus,
        passed: validation.passed,
        failedStage: validation.failedStage,
      },
      validation.passed
        ? "Deterministic Validation Gate PASSED; incident is now AWAITING_APPROVAL"
        : `Deterministic Validation Gate FAILED at Stage ${validation.failedStage}: ${validation.rejectionReason}`
    );

    eventBroadcaster.broadcast("incident:validated", {
      incidentId,
      status: newStatus,
      passed: validation.passed,
      failedStage: validation.failedStage,
    });

    return {
      incidentId,
      status: newStatus,
      validation,
    };
  }
}

export const validationService = new ValidationService();
