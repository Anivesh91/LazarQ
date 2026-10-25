import { prisma } from "../db/prisma";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { queueReinjector } from "../replay/reinjector";
import { replayResultObserver } from "../workers/replay-result.worker";
import { checkInvariants } from "../sandbox/invariants";

export interface ApproveOptions {
  approvedBy?: string;
  autoReplay?: boolean;
}

export interface RejectOptions {
  rejectedBy?: string;
  reason?: string;
}

export class ReplayService {
  /**
   * Approves a proposed repair for an incident in AWAITING_APPROVAL status.
   * Creates a RecoveryAttempt record and optionally triggers immediate re-injection.
   */
  public async approveIncident(incidentId: string, options: ApproveOptions = {}) {
    const autoReplay = options.autoReplay ?? true;
    const approvedBy = options.approvedBy || "developer";

    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    if (!incident) {
      throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
    }

    // Guard against re-approving finalized or already replaying incidents
    if (incident.status === "RESOLVED") {
      throw new AppError(
        `Incident ${incidentId} has already been resolved`,
        409,
        "INCIDENT_ALREADY_RESOLVED"
      );
    }

    if (incident.status === "REPLAYING") {
      throw new AppError(
        `Incident ${incidentId} is currently replaying a recovery job`,
        409,
        "INCIDENT_ALREADY_REPLAYING"
      );
    }

    if (incident.status !== "AWAITING_APPROVAL" && incident.status !== "REPLAY_QUEUED") {
      throw new AppError(
        `Incident cannot be approved in current status "${incident.status}". It must be "AWAITING_APPROVAL".`,
        400,
        "INVALID_STATUS_FOR_APPROVAL"
      );
    }

    if (!incident.proposedPayload) {
      throw new AppError(
        `Incident ${incidentId} does not have a proposed repair payload to approve`,
        400,
        "NO_PROPOSED_PAYLOAD"
      );
    }

    // Invariant re-check before approving
    const originalPayload = incident.payloadSnapshot as Record<string, any>;
    const proposedPayload = incident.proposedPayload as Record<string, any>;
    const invariantCheck = checkInvariants(originalPayload, proposedPayload);

    if (!invariantCheck.passed) {
      throw new AppError(
        `Approval rejected by safety invariant guard: ${invariantCheck.violations.join(", ")}`,
        422,
        "INVARIANT_VIOLATION"
      );
    }

    // Create RecoveryAttempt record and transition incident status to REPLAY_QUEUED
    const [recoveryAttempt, updatedIncident] = await prisma.$transaction([
      prisma.recoveryAttempt.create({
        data: {
          incidentId,
          proposedPayload: proposedPayload as any,
          validationResult: (incident.validationResult as any) || null,
          status: "QUEUED",
        },
      }),
      prisma.incident.update({
        where: { id: incidentId },
        data: {
          status: "REPLAY_QUEUED",
        },
      }),
      prisma.auditLog.create({
        data: {
          incidentId,
          action: "RECOVERY_APPROVED",
          actor: approvedBy,
          details: {
            approvedBy,
            autoReplay,
            proposedPayload,
          },
        },
      }),
    ]);

    logger.info(
      { incidentId, attemptId: recoveryAttempt.id, approvedBy, autoReplay },
      "✅ Incident recovery proposal approved"
    );

    // If autoReplay is requested, immediately trigger execution
    if (autoReplay) {
      return this.executeReplay(incidentId, recoveryAttempt.id);
    }

    return {
      incident: updatedIncident,
      recoveryAttempt,
    };
  }

  /**
   * Rejects a proposed repair, transitioning the incident into QUARANTINED state.
   */
  public async rejectIncident(incidentId: string, options: RejectOptions = {}) {
    const rejectedBy = options.rejectedBy || "developer";
    const reason = options.reason || "Proposal rejected by developer during review";

    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    if (!incident) {
      throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
    }

    if (incident.status === "RESOLVED") {
      throw new AppError(
        `Cannot reject already resolved incident ${incidentId}`,
        409,
        "INCIDENT_ALREADY_RESOLVED"
      );
    }

    if (incident.status === "REPLAYING") {
      throw new AppError(
        `Cannot reject incident ${incidentId} while recovery job is actively replaying`,
        409,
        "INCIDENT_ALREADY_REPLAYING"
      );
    }

    const [updatedIncident] = await prisma.$transaction([
      prisma.incident.update({
        where: { id: incidentId },
        data: {
          status: "QUARANTINED",
        },
      }),
      prisma.auditLog.create({
        data: {
          incidentId,
          action: "RECOVERY_REJECTED",
          actor: rejectedBy,
          details: {
            rejectedBy,
            reason,
          },
        },
      }),
    ]);

    logger.warn(
      { incidentId, rejectedBy, reason },
      "⚠️ Incident repair proposal rejected; transitioned to QUARANTINED"
    );

    return {
      incident: updatedIncident,
    };
  }

  /**
   * Re-injects the repaired job payload into the source BullMQ queue
   * and attaches the live result observer.
   */
  public async executeReplay(incidentId: string, recoveryAttemptId?: string) {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
      include: {
        recoveryAttempts: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!incident) {
      throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
    }

    // State validation
    if (incident.status === "RESOLVED") {
      throw new AppError(
        `Incident ${incidentId} is already marked as RESOLVED`,
        409,
        "INCIDENT_ALREADY_RESOLVED"
      );
    }

    if (incident.status === "REPLAYING") {
      throw new AppError(
        `Incident ${incidentId} is currently replaying a recovery job`,
        409,
        "INCIDENT_ALREADY_REPLAYING"
      );
    }

    if (incident.status !== "REPLAY_QUEUED" && incident.status !== "AWAITING_APPROVAL") {
      throw new AppError(
        `Incident must be in "REPLAY_QUEUED" or "AWAITING_APPROVAL" status to trigger replay. Current: "${incident.status}"`,
        400,
        "INVALID_STATUS_FOR_REPLAY"
      );
    }

    // Identify or create RecoveryAttempt
    let attempt = recoveryAttemptId
      ? await prisma.recoveryAttempt.findUnique({ where: { id: recoveryAttemptId } })
      : incident.recoveryAttempts[0];

    if (!attempt || attempt.status === "COMPLETED") {
      const payloadToReplay = (incident.proposedPayload || incident.payloadSnapshot) as Record<string, any>;
      attempt = await prisma.recoveryAttempt.create({
        data: {
          incidentId,
          proposedPayload: payloadToReplay as any,
          validationResult: (incident.validationResult as any) || null,
          status: "QUEUED",
        },
      });
    }

    // Extract delay seconds from AI diagnosis if available
    const diagnosis = (incident.aiDiagnosis as Record<string, any>) || {};
    const delaySeconds = typeof diagnosis.delaySeconds === "number" ? diagnosis.delaySeconds : 0;

    // Generate deterministic yet unique replay job ID
    const replayJobId = `recovery-${attempt.id}-${Date.now()}`;

    // Ensure QueueEvents observer is attached to the queue
    replayResultObserver.ensureQueueObserver(incident.queueName);

    // Re-inject into BullMQ queue
    await queueReinjector.reinjectJob(
      incident.queueName,
      incident.jobName,
      attempt.proposedPayload as Record<string, any>,
      {
        delayMs: delaySeconds * 1000,
        jobId: replayJobId,
      }
    );

    // Update DB: Attempt -> IN_PROGRESS, Incident -> REPLAYING
    const [updatedAttempt, updatedIncident] = await prisma.$transaction([
      prisma.recoveryAttempt.update({
        where: { id: attempt.id },
        data: {
          replayJobId,
          status: "IN_PROGRESS",
          startedAt: new Date(),
        },
      }),
      prisma.incident.update({
        where: { id: incidentId },
        data: {
          status: "REPLAYING",
        },
      }),
      prisma.auditLog.create({
        data: {
          incidentId,
          action: "JOB_REPLAYED",
          actor: "reinjector",
          details: {
            recoveryAttemptId: attempt.id,
            replayJobId,
            queueName: incident.queueName,
            jobName: incident.jobName,
            delaySeconds,
          },
        },
      }),
    ]);

    logger.info(
      {
        incidentId,
        attemptId: updatedAttempt.id,
        replayJobId,
        queueName: incident.queueName,
      },
      "🚀 Job successfully re-injected into original queue; incident marked REPLAYING"
    );

    return {
      incident: updatedIncident,
      recoveryAttempt: updatedAttempt,
    };
  }

  /**
   * Fetches all recovery attempts history for an incident.
   */
  public async getRecoveryHistory(incidentId: string) {
    const exists = await prisma.incident.findUnique({
      where: { id: incidentId },
      select: { id: true },
    });

    if (!exists) {
      throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
    }

    return prisma.recoveryAttempt.findMany({
      where: { incidentId },
      orderBy: { startedAt: "desc" },
    });
  }
}

export const replayService = new ReplayService();
