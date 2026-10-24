import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code: string = "INTERNAL_SERVER_ERROR",
    public details?: any
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // ── 1. Zod Validation Errors ──
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: err.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
    return;
  }

  // ── 2. Controlled App Errors ──
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }

  // ── 3. Unhandled Server Errors ──
  logger.error({ err: err.message, stack: err.stack }, "Unhandled server error");

  res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_SERVER_ERROR",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
}
