import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { runbookService } from "../services/runbook.service";

export const runbookRouter: Router = Router();

// ── Validation Schemas ──
const CreateRunbookSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  content: z.string().min(1, "Content is required"),
  tags: z.array(z.string()).default([]),
});

const UpdateRunbookSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

const ListRunbooksQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  tag: z.string().optional(),
  search: z.string().optional(),
});

function getParamId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : String(raw);
}

// ── 1. Create Runbook ──
// POST /api/runbooks
runbookRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = CreateRunbookSchema.parse(req.body);
      const runbook = await runbookService.createRunbook(data);
      res.status(201).json({
        success: true,
        data: runbook,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 2. List Runbooks ──
// GET /api/runbooks
runbookRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = ListRunbooksQuerySchema.parse(req.query);
      const result = await runbookService.listRunbooks(query);
      res.status(200).json({
        success: true,
        data: result.runbooks,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: Math.ceil(result.total / result.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 3. Get Runbook By ID ──
// GET /api/runbooks/:id
runbookRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const runbook = await runbookService.getRunbookById(id);
      res.status(200).json({
        success: true,
        data: runbook,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 4. Update Runbook ──
// PATCH /api/runbooks/:id
runbookRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const data = UpdateRunbookSchema.parse(req.body);
      const runbook = await runbookService.updateRunbook(id, data);
      res.status(200).json({
        success: true,
        data: runbook,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 5. Delete Runbook ──
// DELETE /api/runbooks/:id
runbookRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = getParamId(req);
      const result = await runbookService.deleteRunbook(id);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);
