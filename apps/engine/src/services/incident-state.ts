import { IncidentStatus, Prisma } from "@prisma/client";
import { AppError } from "../middleware/error-handler";

export const ALLOWED_INCIDENT_TRANSITIONS: Record<
  IncidentStatus,
  readonly IncidentStatus[]
> = {
  INGESTED: ["ANALYZING", "QUARANTINED", "ANALYSIS_FAILED"],
  ANALYZING: ["RAG_MATCHED", "PROPOSAL_READY", "QUARANTINED", "ANALYSIS_FAILED"],
  RAG_MATCHED: ["PROPOSAL_READY", "QUARANTINED", "ANALYSIS_FAILED"],
  PROPOSAL_READY: [
    "AWAITING_APPROVAL",
    "SANDBOX_FAILED",
    "QUARANTINED",
    "ANALYSIS_FAILED",
  ],
  AWAITING_APPROVAL: ["REPLAY_QUEUED", "QUARANTINED"],
  REPLAY_QUEUED: ["REPLAYING", "QUARANTINED"],
  REPLAYING: ["RESOLVED", "REPLAY_FAILED", "REPLAY_QUEUED"],
  RESOLVED: [],
  QUARANTINED: [],
  SANDBOX_FAILED: [],
  REPLAY_FAILED: [],
  ANALYSIS_FAILED: [],
};

export const TERMINAL_OR_SETTLED_INCIDENT_STATUSES = new Set<IncidentStatus>([
  "AWAITING_APPROVAL",
  "REPLAY_QUEUED",
  "REPLAYING",
  "RESOLVED",
  "QUARANTINED",
  "SANDBOX_FAILED",
  "REPLAY_FAILED",
  "ANALYSIS_FAILED",
]);

export const RESUMABLE_INTAKE_STATUSES = new Set<IncidentStatus>([
  "INGESTED",
  "ANALYZING",
  "RAG_MATCHED",
  "PROPOSAL_READY",
]);

export function canTransitionIncident(
  from: IncidentStatus,
  to: IncidentStatus
): boolean {
  return (ALLOWED_INCIDENT_TRANSITIONS[from] || []).includes(to);
}

export function assertValidTransition(
  incidentId: string,
  from: IncidentStatus,
  to: IncidentStatus,
  actionName?: string
): void {
  if (!canTransitionIncident(from, to)) {
    throw new AppError(
      `Invalid state transition for incident ${incidentId}${
        actionName ? ` during ${actionName}` : ""
      }: cannot transition from "${from}" to "${to}"`,
      409,
      "INVALID_STATE_TRANSITION"
    );
  }
}

export async function transitionIncidentConditional(
  tx: Prisma.TransactionClient,
  params: {
    incidentId: string;
    allowedFrom: IncidentStatus[];
    toStatus: IncidentStatus;
    data?: Omit<Prisma.IncidentUncheckedUpdateManyInput, "status">;
    actionName?: string;
  }
): Promise<boolean> {
  const validSources = params.allowedFrom.filter((s) =>
    canTransitionIncident(s, params.toStatus)
  );
  if (validSources.length === 0) {
    return false;
  }

  const updated = await tx.incident.updateMany({
    where: {
      id: params.incidentId,
      status: { in: validSources },
    },
    data: {
      ...(params.data || {}),
      status: params.toStatus,
    },
  });

  return updated.count === 1;
}

export async function assertAndTransitionIncident(
  tx: Prisma.TransactionClient,
  params: {
    incidentId: string;
    allowedFrom: IncidentStatus[];
    toStatus: IncidentStatus;
    data?: Omit<Prisma.IncidentUncheckedUpdateManyInput, "status">;
    actionName?: string;
  }
): Promise<void> {
  const succeeded = await transitionIncidentConditional(tx, params);
  if (!succeeded) {
    throw new AppError(
      `Incident ${params.incidentId} state does not allow transition to "${params.toStatus}"${
        params.actionName ? ` (${params.actionName})` : ""
      } or changed concurrently`,
      409,
      "INVALID_STATE_TRANSITION"
    );
  }
}

export async function countLineageReplayAttempts(
  db: Pick<Prisma.TransactionClient, "recoveryAttempt">,
  lineageRootId: string,
  excludeAttemptId?: string
): Promise<number> {
  return db.recoveryAttempt.count({
    where: {
      ...(excludeAttemptId ? { id: { not: excludeAttemptId } } : {}),
      incident: {
        OR: [{ id: lineageRootId }, { lineageRootId }],
      },
      OR: [
        { status: { in: ["QUEUED", "IN_PROGRESS", "COMPLETED"] } },
        { status: "FAILED", replayJobId: { not: null } },
      ],
    },
  });
}
