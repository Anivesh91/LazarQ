import { IncidentStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { llmService, RepairProposal } from "./llm.service";
import { ragService } from "./rag.service";
import { eventBroadcaster } from "./event-broadcaster.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { sanitizeErrorMessage } from "./execution-payload.service";
import {
  applyMutation,
  applyMutations,
  safeCloneJson,
} from "../sandbox/mutation-safety";
import {
  assertAndTransitionIncident,
  transitionIncidentConditional,
} from "./incident-state";

export { applyMutation };

export interface DiagnoseIncidentOptions {
  resume?: boolean;
  rethrowErrors?: boolean;
}

export interface TriageResult {
  incidentId: string;
  status: "PROPOSAL_READY" | "QUARANTINED" | "ANALYSIS_FAILED";
  proposal: RepairProposal | null;
  proposedPayload: Record<string, any> | null;
}

export class TriageService {
  /**
   * Diagnoses an incident by retrieving Runbook knowledge and synthesizing a structured LLM proposal.
   */
  async diagnoseIncident(
    incidentId: string,
    options: DiagnoseIncidentOptions = {}
  ): Promise<TriageResult> {
    let incident = await prisma.incident.findUnique({
      where: { id: incidentId },
      include: { matchedRunbook: true },
    });

    if (!incident) {
      throw new AppError(`Incident with id ${incidentId} not found`, 404, "NOT_FOUND");
    }

    const allowedEntryStatuses: IncidentStatus[] = options.resume
      ? ["INGESTED", "ANALYZING", "RAG_MATCHED"]
      : ["INGESTED", "RAG_MATCHED"];

    if (!allowedEntryStatuses.includes(incident.status)) {
      throw new AppError(
        `Cannot diagnose incident ${incidentId} in current status "${incident.status}"`,
        409,
        "INVALID_STATE_TRANSITION"
      );
    }

    let inRagStep = false;

    try {
      // Step 1: If not yet RAG matched (or recovering mid-ANALYZING), run/resume RAG retrieval first
      if (
        incident.status === "INGESTED" ||
        (options.resume &&
          incident.status === "ANALYZING" &&
          !incident.matchedRunbookId)
      ) {
        logger.info({ incidentId, status: incident.status }, "Incident not yet RAG matched; triggering retrieval first");
        inRagStep = true;
        await ragService.matchIncident(incidentId, {
          allowAnalyzingResume: Boolean(options.resume),
          preserveStatusOnError: Boolean(options.rethrowErrors),
        });
        inRagStep = false;

        incident = await prisma.incident.findUnique({
          where: { id: incidentId },
          include: { matchedRunbook: true },
        });

        if (!incident) {
          throw new AppError(`Incident ${incidentId} vanished during triage`, 500);
        }
      }

      // If RAG quarantine occurred (no matching runbook), return early
      if (incident.status === "QUARANTINED") {
        logger.info({ incidentId }, "Incident already quarantined by RAG gate");
        return {
          incidentId,
          status: "QUARANTINED",
          proposal: null,
          proposedPayload: null,
        };
      }

      const allowedPreProposalStatuses: IncidentStatus[] = options.resume
        ? ["RAG_MATCHED", "ANALYZING"]
        : ["RAG_MATCHED"];

      if (!allowedPreProposalStatuses.includes(incident.status)) {
        throw new AppError(
          `Incident ${incidentId} transitioned to incompatible status "${incident.status}" before diagnosis`,
          409,
          "INVALID_STATE_TRANSITION"
        );
      }

      // Step 2: Request structured repair proposal from LLM Doctor
      const proposal = await llmService.generateRepairProposal({
        jobName: incident.jobName,
        queueName: incident.queueName,
        errorMessage: incident.errorMessage,
        stackTrace: incident.stackTrace,
        payloadSnapshot: (incident.payloadSnapshot as Record<string, any>) || {},
        attemptsMade: incident.attemptsMade,
        configuredAttempts: incident.configuredAttempts,
        runbookTitle: incident.matchedRunbook?.title,
        runbookContent: incident.matchedRunbook?.content,
      });

      // Step 3: Compute mutated proposed payload
      let proposedPayload: Record<string, any> | null = null;
      const basePayload =
        typeof incident.payloadSnapshot === "object" && incident.payloadSnapshot !== null
          ? incident.payloadSnapshot
          : {};

      if (proposal.action === "MUTATE_AND_RETRY") {
        proposedPayload = applyMutations(basePayload, proposal.mutations);
      } else if (proposal.action === "RETRY") {
        proposedPayload = safeCloneJson(basePayload);
      } else {
        proposedPayload = null;
      }

      const nextStatus = proposal.action === "QUARANTINE" ? "QUARANTINED" : "PROPOSAL_READY";
      const shouldPurgeEncryptedPayload =
        nextStatus === "QUARANTINED" &&
        incident.encryptedExecutionPayload != null;

      // Step 4: Persist proposal & status atomically in PostgreSQL with conditional source guard
      await prisma.$transaction(async (tx) => {
        await assertAndTransitionIncident(tx, {
          incidentId,
          allowedFrom: allowedPreProposalStatuses,
          toStatus: nextStatus,
          data: {
            aiDiagnosis: proposal as any,
            proposedPayload: proposedPayload as any,
            ...(shouldPurgeEncryptedPayload
              ? { encryptedExecutionPayload: Prisma.DbNull }
              : {}),
          },
          actionName: "AI diagnosis commit",
        });

        await tx.auditLog.create({
          data: {
            incidentId,
            action: nextStatus,
            actor: "ai-doctor",
            details: {
              action: proposal.action,
              classification: proposal.classification,
              confidence: proposal.confidence,
              delaySeconds: proposal.delaySeconds,
              mutationsCount: proposal.mutations.length,
              rootCause: proposal.rootCause,
            },
          },
        });
      });

      logger.info(
        { incidentId, status: nextStatus, action: proposal.action },
        "AI diagnosis and repair proposal generated successfully"
      );

      // Broadcast proposal to live dashboards
      eventBroadcaster.broadcast(
        nextStatus === "QUARANTINED" ? "incident:quarantined" : "incident:proposed",
        {
          incidentId,
          status: nextStatus,
          proposal,
        }
      );

      return {
        incidentId,
        status: nextStatus,
        proposal,
        proposedPayload,
      };
    } catch (llmError: any) {
      if (
        llmError instanceof AppError &&
        (llmError.statusCode === 404 || llmError.statusCode === 409)
      ) {
        throw llmError;
      }

      if (options.rethrowErrors) {
        throw llmError;
      }

      const safeErrMessage = sanitizeErrorMessage(
        llmError?.message || "Unknown analysis error"
      );

      logger.error(
        { incidentId, err: safeErrMessage },
        "Triage/RAG diagnosis failed; transitioning incident to ANALYSIS_FAILED"
      );

      const currentStatus = inRagStep
        ? await prisma.incident
            .findUnique({
              where: { id: incidentId },
              select: { status: true },
            })
            .then((row) => row?.status)
            .catch(() => null)
        : null;

      if (currentStatus !== "ANALYSIS_FAILED") {
        const shouldPurgeOnFail = incident?.encryptedExecutionPayload != null;
        let markedFailed = false;
        await prisma.$transaction(async (tx) => {
          markedFailed = await transitionIncidentConditional(tx, {
            incidentId,
            allowedFrom: ["INGESTED", "ANALYZING", "RAG_MATCHED"],
            toStatus: "ANALYSIS_FAILED",
            ...(shouldPurgeOnFail
              ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
              : {}),
            actionName: "AI diagnosis failure",
          });

          if (markedFailed) {
            await tx.auditLog.create({
              data: {
                incidentId,
                action: "ANALYSIS_FAILED",
                actor: inRagStep ? "system/rag" : "ai-doctor",
                details: { error: safeErrMessage },
              },
            });
          }
        });

        if (markedFailed) {
          eventBroadcaster.broadcast("incident:failed", {
            incidentId,
            status: "ANALYSIS_FAILED",
            error: safeErrMessage,
          });
        }
      }

      return {
        incidentId,
        status: "ANALYSIS_FAILED",
        proposal: null,
        proposedPayload: null,
      };
    }
  }
}

export const triageService = new TriageService();
