import { prisma } from "../db/prisma";
import { deterministicValidator, ValidationGateResult } from "../sandbox/validator";
import { RepairProposal } from "./llm.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

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
      throw new AppError(`Incident with id ${incidentId} not found`, 404);
    }

    if (!incident.aiDiagnosis) {
      throw new AppError(
        `Incident ${incidentId} does not have a generated AI proposal to validate`,
        400
      );
    }

    const proposal = incident.aiDiagnosis as unknown as RepairProposal;
    const proposedPayload = incident.proposedPayload as Record<string, any> | null;

    logger.info({ incidentId, proposalAction: proposal.action }, "Executing 5-Stage Validation Gate");

    const validation = deterministicValidator.validate({
      incident: {
        id: incident.id,
        queueName: incident.queueName,
        status: incident.status,
        attemptsMade: incident.attemptsMade,
        configuredAttempts: incident.configuredAttempts,
        payloadSnapshot: incident.payloadSnapshot,
        expectedJsonSchema: incident.expectedJsonSchema,
      },
      proposal,
      proposedPayload,
    });

    const newStatus = validation.passed ? "AWAITING_APPROVAL" : "SANDBOX_FAILED";

    await prisma.$transaction([
      prisma.incident.update({
        where: { id: incidentId },
        data: {
          status: newStatus,
          validationResult: validation as any,
        },
      }),
      prisma.auditLog.create({
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
      }),
    ]);

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

    return {
      incidentId,
      status: newStatus,
      validation,
    };
  }
}

export const validationService = new ValidationService();
