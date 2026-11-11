import { prisma } from "../db/prisma";
import { llmService, RepairProposal } from "./llm.service";
import { ragService } from "./rag.service";
import { eventBroadcaster } from "./event-broadcaster.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

export interface TriageResult {
  incidentId: string;
  status: "PROPOSAL_READY" | "QUARANTINED" | "ANALYSIS_FAILED";
  proposal: RepairProposal | null;
  proposedPayload: Record<string, any> | null;
}

const DISALLOWED_MUTATION_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function applyMutation(payload: Record<string, any>, field: string, to: any): void {
  if (!field) return;
  const parts = field.split(".");
  if (parts.some((part) => !part || DISALLOWED_MUTATION_SEGMENTS.has(part))) {
    throw new AppError(
      `Unsafe mutation field path rejected: "${field}"`,
      400,
      "UNSAFE_MUTATION_PATH"
    );
  }

  let curr = payload;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (
      !Object.prototype.hasOwnProperty.call(curr, key) ||
      typeof curr[key] !== "object" ||
      curr[key] === null
    ) {
      curr[key] = {};
    }
    curr = curr[key];
  }
  curr[parts[parts.length - 1]] = to;
}

export class TriageService {
  /**
   * Diagnoses an incident by retrieving Runbook knowledge and synthesizing a structured LLM proposal.
   */
  async diagnoseIncident(incidentId: string): Promise<TriageResult> {
    let incident = await prisma.incident.findUnique({
      where: { id: incidentId },
      include: { matchedRunbook: true },
    });

    if (!incident) {
      throw new AppError(`Incident with id ${incidentId} not found`, 404);
    }

    let inRagStep = false;

    try {
      // Step 1: If not yet RAG matched, attempt RAG retrieval first
      if (!incident.matchedRunbookId && incident.status === "INGESTED") {
        logger.info({ incidentId }, "Incident not yet RAG matched; triggering retrieval first");
        inRagStep = true;
        await ragService.matchIncident(incidentId);
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
        proposedPayload = JSON.parse(JSON.stringify(basePayload));
        if (proposedPayload) {
          for (const mut of proposal.mutations) {
            if (mut.field) {
              applyMutation(proposedPayload, mut.field, mut.to);
            }
          }
        }
      } else if (proposal.action === "RETRY") {
        proposedPayload = JSON.parse(JSON.stringify(basePayload));
      } else {
        proposedPayload = null;
      }

      const nextStatus = proposal.action === "QUARANTINE" ? "QUARANTINED" : "PROPOSAL_READY";

      // Step 4: Persist proposal & status atomically in PostgreSQL
      await prisma.$transaction([
        prisma.incident.update({
          where: { id: incidentId },
          data: {
            status: nextStatus,
            aiDiagnosis: proposal as any,
            proposedPayload: proposedPayload as any,
          },
        }),
        prisma.auditLog.create({
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
        }),
      ]);

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
      logger.error(
        { incidentId, err: llmError?.message },
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
        await prisma.$transaction([
          prisma.incident.update({
            where: { id: incidentId },
            data: { status: "ANALYSIS_FAILED" },
          }),
          prisma.auditLog.create({
            data: {
              incidentId,
              action: "ANALYSIS_FAILED",
              actor: inRagStep ? "system/rag" : "ai-doctor",
              details: { error: llmError?.message || "Unknown analysis error" },
            },
          }),
        ]);
      }

      eventBroadcaster.broadcast("incident:failed", {
        incidentId,
        status: "ANALYSIS_FAILED",
        error: llmError?.message || "Unknown analysis error",
      });

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
