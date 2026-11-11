import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { IncidentSnapshot, validateJsonSchemaDefinition } from "@dlq-healer/sdk";
import { incidentService } from "../services/incident.service";
import { ragService } from "../services/rag.service";
import { triageService } from "../services/triage.service";
import { validationService } from "../services/validation.service";
import { replayService } from "../services/replay.service";
import { intakeQueueService } from "../services/intake-queue.service";
import { RESUMABLE_INTAKE_STATUSES } from "../services/incident-state";
import { AppError } from "../middleware/error-handler";
import { logger } from "../config/logger";
import { prisma } from "../db/prisma";

export const incidentRouter: Router = Router();

// ── Validation Schemas ──
const QueryParamsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum([
      "INGESTED",
      "ANALYZING",
      "RAG_MATCHED",
      "PROPOSAL_READY",
      "AWAITING_APPROVAL",
      "REPLAY_QUEUED",
      "REPLAYING",
      "RESOLVED",
      "QUARANTINED",
      "SANDBOX_FAILED",
      "REPLAY_FAILED",
      "ANALYSIS_FAILED",
    ])
    .optional(),
  queueName: z.string().optional(),
});

const ReplayEnvelopeSchema = z.object({
  v: z.literal(1),
  alg: z.literal("aes-256-gcm"),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string().min(1),
});

const IngestSnapshotSchema = z.object({
  idempotencyKey: z.string().min(1),
  source: z.string().default("sdk-v1"),
  queueName: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().default("unknown"),
  payloadSnapshot: z.record(z.any()),
  replayEnvelope: ReplayEnvelopeSchema.optional(),
  expectedJsonSchema: z
    .record(z.any())
    .superRefine((schema, ctx) => {
      const check = validateJsonSchemaDefinition(schema);
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid expectedJsonSchema: ${check.error}`,
        });
      }
    })
    .optional(),
  errorMessage: z.string().min(1),
  stackTrace: z.string().optional(),
  attemptsMade: z.number().int().nonnegative(),
  configuredAttempts: z.number().int().positive(),
  occurredAt: z.string().optional(),
  lineage: z
    .object({
      lineageRootId: z.string().min(1).optional(),
      parentIncidentId: z.string().min(1),
      replayDepth: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const ApproveBodySchema = z.object({
  approvedBy: z.string().optional(),
  autoReplay: z.boolean().default(true),
});

const RejectBodySchema = z.object({
  rejectedBy: z.string().optional(),
  reason: z.string().optional(),
});

const ReplayBodySchema = z.object({
  recoveryAttemptId: z.string().uuid().optional(),
});

function getParamId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : String(raw);
}

// ── 1. HTTP Ingestion Fallback Endpoint ──
// POST /api/incidents/ingest
incidentRouter.post(
  "/ingest",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedSnapshot = IngestSnapshotSchema.parse(req.body);
      const result = await incidentService.ingestSnapshot(validatedSnapshot as any);

      let queued = false;
      if (
        !result.isDuplicate ||
        RESUMABLE_INTAKE_STATUSES.has(result.incident.status)
      ) {
        const queuedSnapshot: IncidentSnapshot = {
          idempotencyKey: validatedSnapshot.idempotencyKey,
          source: result.incident.sourceId,
          queueName: result.incident.queueName,
          jobId: result.incident.jobId,
          jobName: result.incident.jobName,
          payloadSnapshot:
            (result.incident.payloadSnapshot as Record<string, any>) || {},
          ...(validatedSnapshot.replayEnvelope
            ? { replayEnvelope: validatedSnapshot.replayEnvelope }
            : {}),
          ...(validatedSnapshot.expectedJsonSchema
            ? { expectedJsonSchema: validatedSnapshot.expectedJsonSchema }
            : {}),
          errorMessage: result.incident.errorMessage,
          ...(result.incident.stackTrace
            ? { stackTrace: result.incident.stackTrace }
            : {}),
          attemptsMade: result.incident.attemptsMade,
          configuredAttempts: result.incident.configuredAttempts,
          occurredAt: result.incident.occurredAt.toISOString(),
          ...(validatedSnapshot.lineage
            ? { lineage: validatedSnapshot.lineage }
            : {}),
        };

        try {
          await intakeQueueService.enqueueSnapshot(queuedSnapshot);
          queued = true;
        } catch (enqueueErr: any) {
          logger.warn(
            {
              incidentId: result.incident.id,
              idempotencyKey: validatedSnapshot.idempotencyKey,
              err: enqueueErr?.message,
            },
            "[API Ingest] Persisted incident, but BullMQ intake enqueue failed"
          );
        }
      }

      res.status(202).json({
        received: true,
        incidentId: result.incident.id,
        isDuplicate: result.isDuplicate,
        status: result.incident.status,
        queued,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 2. List Incidents (Paginated & Filterable) ──
// GET /api/incidents
incidentRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = QueryParamsSchema.parse(req.query);
      const result = await incidentService.listIncidents(query);

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── 3. Get Incident by ID ──
// GET /api/incidents/:id
incidentRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const incident = await incidentService.getIncidentById(id);

      if (!incident) {
        throw new AppError(`Incident not found with ID: ${id}`, 404, "NOT_FOUND");
      }

      res.json(incident);
    } catch (err) {
      next(err);
    }
  }
);

// ── 4. Get Audit History for an Incident ──
// GET /api/incidents/:id/history
incidentRouter.get(
  "/:id/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);

      // Verify incident exists
      const exists = await prisma.incident.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        throw new AppError(`Incident not found with ID: ${id}`, 404, "NOT_FOUND");
      }

      const history = await prisma.auditLog.findMany({
        where: { incidentId: id },
        orderBy: { createdAt: "asc" },
      });

      res.json({
        incidentId: id,
        totalEvents: history.length,
        history,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 5. Trigger RAG Knowledge Base Matching ──
// POST /api/incidents/:id/match
incidentRouter.post(
  "/:id/match",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const result = await ragService.matchIncident(id);
      res.status(200).json({
        success: true,
        incidentId: id,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 6. Trigger AI Doctor Triage & Repair Proposal ──
// POST /api/incidents/:id/diagnose
incidentRouter.post(
  "/:id/diagnose",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const result = await triageService.diagnoseIncident(id);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 7. Run 5-Stage Deterministic Validation Gate ──
// POST /api/incidents/:id/validate
incidentRouter.post(
  "/:id/validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const result = await validationService.validateProposal(id);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 8. Approve Proposed Repair & Replay ──
// POST /api/incidents/:id/approve
incidentRouter.post(
  "/:id/approve",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const body = ApproveBodySchema.parse(req.body || {});
      const result = await replayService.approveIncident(id, body);
      res.status(200).json({
        success: true,
        incidentId: id,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 9. Reject Proposed Repair & Quarantine ──
// POST /api/incidents/:id/reject
incidentRouter.post(
  "/:id/reject",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const body = RejectBodySchema.parse(req.body || {});
      const result = await replayService.rejectIncident(id, body);
      res.status(200).json({
        success: true,
        incidentId: id,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 10. Trigger Explicit Replay into Source Queue ──
// POST /api/incidents/:id/replay
incidentRouter.post(
  "/:id/replay",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const body = ReplayBodySchema.parse(req.body || {});
      const result = await replayService.executeReplay(id, body.recoveryAttemptId);
      res.status(200).json({
        success: true,
        incidentId: id,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 11. Get Recovery Attempts History for Incident ──
// GET /api/incidents/:id/recoveries
incidentRouter.get(
  "/:id/recoveries",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const recoveries = await replayService.getRecoveryHistory(id);
      res.status(200).json({
        incidentId: id,
        totalAttempts: recoveries.length,
        recoveries,
      });
    } catch (err) {
      next(err);
    }
  }
);
