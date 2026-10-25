import { Router, Request, Response, NextFunction } from "express";
import { metricsService } from "../services/metrics.service";

export const metricsRouter: Router = Router();

/**
 * GET /api/metrics
 * Returns real, unmanipulated operational metrics directly calculated from PostgreSQL.
 */
metricsRouter.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const metrics = await metricsService.getOperationalMetrics();
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});
