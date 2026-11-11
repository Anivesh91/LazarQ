import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { queueReinjector } from "../replay/reinjector";
import { replayResultObserver } from "../workers/replay-result.worker";
import { eventBroadcaster } from "./event-broadcaster.service";
import { checkInvariants } from "../sandbox/invariants";
import { computeProposalHash } from "../sandbox/mutation-safety";
import { deterministicValidator } from "../sandbox/validator";
import { getMaxReplayAttempts } from "../config/env";
import {
  canTransitionIncident,
  countLineageReplayAttempts,
} from "./incident-state";
import {
  buildExecutionReplayPayload,
  sanitizeErrorMessage,
  sanitizeIncidentForView,
} from "./execution-payload.service";
import { RepairProposal } from "./llm.service";

export interface ApproveOptions {
  approvedBy?: string;
  autoReplay?: boolean;
}

export interface RejectOptions {
  rejectedBy?: string;
  reason?: string;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

export class ReplayService {
  /**
   * Approves a proposed repair for an incident in AWAITING_APPROVAL status.
   * Atomically claims the incident, creates one QUEUED RecoveryAttempt, and optionally triggers replay.
   */
  public async approveIncident(incidentId: string, options: ApproveOptions = {}) {
    const autoReplay = options.autoReplay ?? true;
    const approvedBy = options.approvedBy || "developer";

    let txResult: {
      updatedIncident: any;
      recoveryAttempt: any;
    };

    try {
      txResult = await prisma.$transaction(async (tx) => {
        const incident = await tx.incident.findUnique({
          where: { id: incidentId },
        });

        if (!incident) {
          throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
        }

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

        if (incident.status === "REPLAY_QUEUED") {
          throw new AppError(
            `Incident ${incidentId} already has an approved recovery queued for replay`,
            409,
            "INCIDENT_ALREADY_QUEUED"
          );
        }

        if (incident.status !== "AWAITING_APPROVAL") {
          throw new AppError(
            `Incident cannot be approved in current status "${incident.status}". It must be "AWAITING_APPROVAL".`,
            409,
            "INVALID_STATUS_FOR_APPROVAL"
          );
        }

        const lineageRootId = incident.lineageRootId || incident.id;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lineageRootId})::bigint)`;

        const maxReplayAttempts = getMaxReplayAttempts();
        const lineageReplayCount = await countLineageReplayAttempts(
          tx,
          lineageRootId
        );
        const replayDepth = incident.replayDepth ?? 0;

        if (
          lineageReplayCount >= maxReplayAttempts ||
          replayDepth >= maxReplayAttempts
        ) {
          throw new AppError(
            `Replay limit exceeded for lineage ${lineageRootId}: ${lineageReplayCount} replay(s) already queued/executed (depth ${replayDepth}, max ${maxReplayAttempts})`,
            409,
            "REPLAY_LIMIT_EXCEEDED",
            { lineageRootId, lineageReplayCount, replayDepth, maxReplayAttempts }
          );
        }

        if (!incident.proposedPayload) {
          throw new AppError(
            `Incident ${incidentId} does not have a proposed repair payload to approve`,
            400,
            "NO_PROPOSED_PAYLOAD"
          );
        }

        const validationResult = incident.validationResult as Record<string, any> | null;
        if (!validationResult || validationResult.passed !== true) {
          throw new AppError(
            `Incident ${incidentId} has not passed deterministic validation`,
            409,
            "VALIDATION_REQUIRED"
          );
        }

        const originalPayload = (incident.payloadSnapshot || {}) as Record<string, any>;
        const proposedPayload = incident.proposedPayload as Record<string, any>;
        const invariantCheck = checkInvariants(
          originalPayload,
          proposedPayload,
          incident.queueName
        );

        if (!invariantCheck.passed) {
          throw new AppError(
            `Approval rejected by safety invariant guard: ${invariantCheck.violations.join(", ")}`,
            422,
            "INVARIANT_VIOLATION"
          );
        }

        const existingActiveAttempt = await tx.recoveryAttempt.findFirst({
          where: {
            incidentId,
            status: { in: ["PENDING", "QUEUED", "IN_PROGRESS"] },
          },
          select: { id: true },
        });

        if (existingActiveAttempt) {
          throw new AppError(
            `Incident ${incidentId} already has an active recovery attempt (${existingActiveAttempt.id})`,
            409,
            "ACTIVE_ATTEMPT_ALREADY_EXISTS"
          );
        }

        const claimed = await tx.incident.updateMany({
          where: {
            id: incidentId,
            status: "AWAITING_APPROVAL",
          },
          data: {
            status: "REPLAY_QUEUED",
          },
        });

        if (claimed.count !== 1) {
          throw new AppError(
            `Incident ${incidentId} was already claimed or transitioned concurrently`,
            409,
            "INCIDENT_CONCURRENCY_CONFLICT"
          );
        }

        const recoveryAttempt = await tx.recoveryAttempt.create({
          data: {
            incidentId,
            proposedPayload: proposedPayload as any,
            validationResult: (incident.validationResult as any) || null,
            status: "QUEUED",
          },
        });

        const proposalHash = computeProposalHash(proposedPayload);

        await tx.auditLog.create({
          data: {
            incidentId,
            action: "RECOVERY_APPROVED",
            actor: approvedBy,
            details: {
              approvedBy,
              autoReplay,
              recoveryAttemptId: recoveryAttempt.id,
              proposalHash,
              proposedPayload,
            },
          },
        });

        const updatedIncident = await tx.incident.findUniqueOrThrow({
          where: { id: incidentId },
        });

        return { updatedIncident, recoveryAttempt };
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AppError(
          `Incident ${incidentId} already has an active recovery attempt`,
          409,
          "ACTIVE_ATTEMPT_ALREADY_EXISTS"
        );
      }
      throw err;
    }

    const { recoveryAttempt, updatedIncident } = txResult;

    logger.info(
      { incidentId, attemptId: recoveryAttempt.id, approvedBy, autoReplay },
      "✅ Incident recovery proposal approved"
    );

    eventBroadcaster.broadcast("incident:approved", {
      incidentId,
      attemptId: recoveryAttempt.id,
      approvedBy,
      autoReplay,
    });

    // If autoReplay is requested, immediately trigger execution
    if (autoReplay) {
      return this.executeReplay(incidentId, recoveryAttempt.id);
    }

    return {
      incident: sanitizeIncidentForView(updatedIncident),
      recoveryAttempt,
    };
  }

  /**
   * Rejects a proposed repair, transitioning the incident into QUARANTINED state.
   */
  public async rejectIncident(incidentId: string, options: RejectOptions = {}) {
    const rejectedBy = options.rejectedBy || "developer";
    const reason = options.reason || "Proposal rejected by developer during review";

    const updatedIncident = await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.findUnique({
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

      if (incident.status === "QUARANTINED") {
        throw new AppError(
          `Incident ${incidentId} is already QUARANTINED`,
          409,
          "INCIDENT_ALREADY_QUARANTINED"
        );
      }

      if (!canTransitionIncident(incident.status, "QUARANTINED")) {
        throw new AppError(
          `Incident ${incidentId} cannot be rejected in current status "${incident.status}"`,
          409,
          "INVALID_STATE_TRANSITION"
        );
      }

      const claimed = await tx.incident.updateMany({
        where: {
          id: incidentId,
          status: incident.status,
        },
        data: {
          status: "QUARANTINED",
          ...(incident.encryptedExecutionPayload != null
            ? { encryptedExecutionPayload: Prisma.DbNull }
            : {}),
        },
      });

      if (claimed.count !== 1) {
        throw new AppError(
          `Incident ${incidentId} changed state concurrently before rejection completed`,
          409,
          "INCIDENT_CONCURRENCY_CONFLICT"
        );
      }

      await tx.recoveryAttempt.updateMany({
        where: {
          incidentId,
          status: { in: ["PENDING", "QUEUED"] },
        },
        data: {
          status: "FAILED",
          failureReason: reason,
          completedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          incidentId,
          action: "RECOVERY_REJECTED",
          actor: rejectedBy,
          details: {
            rejectedBy,
            reason,
          },
        },
      });

      return tx.incident.findUniqueOrThrow({ where: { id: incidentId } });
    });

    logger.warn(
      { incidentId, rejectedBy, reason },
      "⚠️ Incident repair proposal rejected; transitioned to QUARANTINED"
    );

    eventBroadcaster.broadcast("incident:quarantined", {
      incidentId,
      rejectedBy,
      reason,
    });

    return {
      incident: sanitizeIncidentForView(updatedIncident),
    };
  }

  /**
   * Re-injects the approved, validated repair job payload into the source BullMQ queue
   * and attaches the live result observer.
   */
  public async executeReplay(incidentId: string, recoveryAttemptId?: string) {
    const claimed = await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.findUnique({
        where: { id: incidentId },
      });

      if (!incident) {
        throw new AppError(`Incident not found with ID: ${incidentId}`, 404, "NOT_FOUND");
      }

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

      if (incident.status !== "REPLAY_QUEUED") {
        throw new AppError(
          `Incident ${incidentId} must be approved and in "REPLAY_QUEUED" status to trigger replay. Current: "${incident.status}"`,
          409,
          "APPROVAL_REQUIRED"
        );
      }

      if (!incident.proposedPayload) {
        throw new AppError(
          `Incident ${incidentId} does not have an approved proposed payload to replay`,
          409,
          "NO_PROPOSED_PAYLOAD"
        );
      }

      const attempt = recoveryAttemptId
        ? await tx.recoveryAttempt.findFirst({
            where: {
              id: recoveryAttemptId,
              incidentId,
            },
          })
        : await tx.recoveryAttempt.findFirst({
            where: {
              incidentId,
              status: "QUEUED",
            },
            orderBy: { startedAt: "desc" },
          });

      if (!attempt) {
        throw new AppError(
          recoveryAttemptId
            ? `Recovery attempt ${recoveryAttemptId} was not found for incident ${incidentId}`
            : `No queued approved recovery attempt exists for incident ${incidentId}`,
          recoveryAttemptId ? 404 : 409,
          recoveryAttemptId ? "RECOVERY_ATTEMPT_NOT_FOUND" : "APPROVAL_REQUIRED"
        );
      }

      if (attempt.status !== "QUEUED") {
        throw new AppError(
          `Recovery attempt ${attempt.id} is in status "${attempt.status}" and cannot be replayed`,
          409,
          "INVALID_ATTEMPT_STATUS"
        );
      }

      const lineageRootId = incident.lineageRootId || incident.id;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lineageRootId})::bigint)`;

      const maxReplayAttempts = getMaxReplayAttempts();
      const priorLineageReplays = await countLineageReplayAttempts(
        tx,
        lineageRootId,
        attempt.id
      );
      const replayDepth = incident.replayDepth ?? 0;

      if (
        priorLineageReplays >= maxReplayAttempts ||
        replayDepth >= maxReplayAttempts
      ) {
        throw new AppError(
          `Replay limit exceeded for lineage ${lineageRootId}: ${priorLineageReplays} prior replay(s) already recorded (depth ${replayDepth}, max ${maxReplayAttempts})`,
          409,
          "REPLAY_LIMIT_EXCEEDED",
          {
            lineageRootId,
            lineageReplayCount: priorLineageReplays,
            replayDepth,
            maxReplayAttempts,
          }
        );
      }

      const approvalAudit = await tx.auditLog.findFirst({
        where: {
          incidentId,
          action: "RECOVERY_APPROVED",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!approvalAudit) {
        throw new AppError(
          `Incident ${incidentId} lacks a persisted human approval audit record`,
          409,
          "APPROVAL_REQUIRED"
        );
      }

      const auditDetails = (approvalAudit.details || {}) as Record<string, any>;
      if (
        auditDetails.recoveryAttemptId &&
        auditDetails.recoveryAttemptId !== attempt.id
      ) {
        throw new AppError(
          `Recovery attempt ${attempt.id} is not bound to the latest approved proposal`,
          409,
          "ATTEMPT_APPROVAL_MISMATCH"
        );
      }

      const incidentProposalHash = computeProposalHash(incident.proposedPayload);
      const attemptProposalHash = computeProposalHash(attempt.proposedPayload);
      if (incidentProposalHash !== attemptProposalHash) {
        throw new AppError(
          `Recovery attempt ${attempt.id} payload does not match the incident's approved proposal`,
          409,
          "PROPOSAL_MISMATCH"
        );
      }

      if (
        auditDetails.proposalHash &&
        auditDetails.proposalHash !== attemptProposalHash
      ) {
        throw new AppError(
          `Recovery attempt ${attempt.id} payload digest does not match the audited approval`,
          409,
          "PROPOSAL_MISMATCH"
        );
      }

      const originalPayload = (incident.payloadSnapshot || {}) as Record<string, any>;
      const attemptPayload = attempt.proposedPayload as Record<string, any>;
      const invariantCheck = checkInvariants(
        originalPayload,
        attemptPayload,
        incident.queueName
      );
      if (!invariantCheck.passed) {
        throw new AppError(
          `Replay rejected by safety invariant guard: ${invariantCheck.violations.join(", ")}`,
          422,
          "INVARIANT_VIOLATION"
        );
      }

      const replayJobId = `recovery-${attempt.id}`;

      const attemptClaim = await tx.recoveryAttempt.updateMany({
        where: {
          id: attempt.id,
          incidentId,
          status: "QUEUED",
        },
        data: {
          replayJobId,
          status: "IN_PROGRESS",
          startedAt: new Date(),
        },
      });

      if (attemptClaim.count !== 1) {
        throw new AppError(
          `Recovery attempt ${attempt.id} could not be claimed atomically`,
          409,
          "RECOVERY_CLAIM_CONFLICT"
        );
      }

      const incidentClaim = await tx.incident.updateMany({
        where: {
          id: incidentId,
          status: "REPLAY_QUEUED",
        },
        data: {
          status: "REPLAYING",
        },
      });

      if (incidentClaim.count !== 1) {
        throw new AppError(
          `Incident ${incidentId} state changed concurrently before replay could start`,
          409,
          "INCIDENT_CONCURRENCY_CONFLICT"
        );
      }

      const [updatedAttempt, updatedIncident] = await Promise.all([
        tx.recoveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
        tx.incident.findUniqueOrThrow({ where: { id: incidentId } }),
      ]);

      return {
        updatedAttempt,
        updatedIncident,
        previousStartedAt: attempt.startedAt,
        replayJobId,
        lineage: {
          lineageRootId,
          parentIncidentId: updatedIncident.id,
          replayDepth: (updatedIncident.replayDepth ?? 0) + 1,
        },
      };
    });

    const {
      updatedAttempt,
      updatedIncident,
      previousStartedAt,
      replayJobId,
      lineage,
    } = claimed;

    // Extract delay seconds from AI diagnosis if available
    const diagnosis = (updatedIncident.aiDiagnosis as Record<string, any>) || {};
    const delaySeconds = typeof diagnosis.delaySeconds === "number" ? diagnosis.delaySeconds : 0;

    // Reconstruct unredacted execution payload, validate against schema,
    // await QueueEvents observer readiness, & re-inject into BullMQ queue.
    try {
      const executionPayload = await buildExecutionReplayPayload({
        incident: updatedIncident,
        proposal: (updatedIncident.aiDiagnosis as unknown as RepairProposal) || null,
        fallbackProposedPayload: updatedAttempt.proposedPayload as Record<string, any>,
      });

      if (updatedIncident.expectedJsonSchema) {
        const schemaCheck = deterministicValidator.validateSchema(
          executionPayload,
          updatedIncident.expectedJsonSchema
        );
        if (!schemaCheck.passed) {
          throw new AppError(
            schemaCheck.message || "Execution replay payload failed schema validation",
            422,
            "SCHEMA_VALIDATION_FAILED"
          );
        }
      }

      await replayResultObserver.ensureQueueObserverReady(updatedIncident.queueName);

      await queueReinjector.reinjectJob(
        updatedIncident.queueName,
        updatedIncident.jobName,
        executionPayload,
        {
          delayMs: delaySeconds * 1000,
          jobId: replayJobId,
          lineage,
        }
      );
    } catch (enqueueError) {
      try {
        const safeErrorText = sanitizeErrorMessage(
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError)
        );
        await prisma.$transaction(async (tx) => {
          await tx.recoveryAttempt.updateMany({
            where: {
              id: updatedAttempt.id,
              incidentId,
              status: "IN_PROGRESS",
              replayJobId,
            },
            data: {
              replayJobId: null,
              status: "QUEUED",
              failureReason: null,
              startedAt: previousStartedAt,
              completedAt: null,
            },
          });
          await tx.incident.updateMany({
            where: {
              id: incidentId,
              status: "REPLAYING",
            },
            data: { status: "REPLAY_QUEUED" },
          });
          await tx.auditLog.create({
            data: {
              incidentId,
              action: "RECOVERY_REPLAY_FAILED",
              actor: "reinjector",
              details: {
                recoveryAttemptId: updatedAttempt.id,
                replayJobId,
                queueName: updatedIncident.queueName,
                error: safeErrorText,
              },
            },
          });
        });
      } catch (restoreError) {
        logger.error(
          { err: restoreError, incidentId, attemptId: updatedAttempt.id },
          "Failed to restore replay state after enqueue failure"
        );
      }
      throw enqueueError;
    }

    try {
      await prisma.auditLog.create({
        data: {
          incidentId,
          action: "JOB_REPLAYED",
          actor: "reinjector",
          details: {
            recoveryAttemptId: updatedAttempt.id,
            replayJobId,
            queueName: updatedIncident.queueName,
            jobName: updatedIncident.jobName,
            delaySeconds,
          },
        },
      });
    } catch (auditError) {
      logger.error(
        { err: auditError, incidentId, attemptId: updatedAttempt.id, replayJobId },
        "Replay was enqueued, but JOB_REPLAYED audit persistence failed"
      );
    }

    logger.info(
      {
        incidentId,
        attemptId: updatedAttempt.id,
        replayJobId,
        queueName: updatedIncident.queueName,
      },
      "🚀 Job successfully re-injected into original queue; incident marked REPLAYING"
    );

    eventBroadcaster.broadcast("incident:replaying", {
      incidentId,
      attemptId: updatedAttempt.id,
      replayJobId,
      queueName: updatedIncident.queueName,
    });

    return {
      incident: sanitizeIncidentForView(updatedIncident),
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
