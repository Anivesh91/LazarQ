import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { incidentService } from "../services/incident.service";
import { ragService } from "../services/rag.service";
import { AppError } from "../middleware/error-handler";
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

const IngestSnapshotSchema = z.object({
  idempotencyKey: z.string().min(1),
  source: z.string().default("sdk-v1"),
  queueName: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().default("unknown"),
  payloadSnapshot: z.record(z.any()),
  expectedJsonSchema: z.record(z.any()).optional(),
  errorMessage: z.string().min(1),
  stackTrace: z.string().optional(),
  attemptsMade: z.number().int().nonnegative(),
  configuredAttempts: z.number().int().positive(),
  occurredAt: z.string().optional(),
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

      res.status(202).json({
        received: true,
        incidentId: result.incident.id,
        isDuplicate: result.isDuplicate,
        status: result.incident.status,
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
