import { Router, Request, Response, NextFunction } from "express";
import { circuitBreakerService } from "../services/circuit-breaker.service";

export const circuitBreakerRouter: Router = Router();

// GET /api/circuit-breaker
circuitBreakerRouter.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const statuses = circuitBreakerService.getAllStatuses();
      res.status(200).json({
        success: true,
        totalBreakers: statuses.length,
        openBreakers: statuses.filter((s) => s.state === "OPEN").length,
        breakers: statuses,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/circuit-breaker/reset
circuitBreakerRouter.post(
  "/reset",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fingerprint } = req.body || {};
      circuitBreakerService.reset(fingerprint);
      res.status(200).json({
        success: true,
        message: fingerprint
          ? `Circuit breaker for fingerprint "${fingerprint}" has been reset.`
          : "All active circuit breakers have been reset.",
      });
    } catch (err) {
      next(err);
    }
  }
);
