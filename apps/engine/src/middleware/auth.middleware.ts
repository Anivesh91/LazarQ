import { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler";

/**
 * Validates incoming API requests against configured ENGINE_API_KEY if present in environment.
 * Allows unrestricted access in development mode when no API_KEY is set.
 */
export function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  // In automated test suite, only enforce when explicitly requested
  if (process.env.NODE_ENV === "test" && !process.env.TEST_AUTH_ENABLED) {
    return next();
  }

  const configuredKey = process.env.ENGINE_API_KEY;

  // If no ENGINE_API_KEY configured, permit access (dev mode)
  if (!configuredKey) {
    return next();
  }

  // Health remains public so infrastructure probes can run without credentials.
  if (req.path === "/health") {
    return next();
  }

  const providedKey =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (!providedKey || providedKey !== configuredKey) {
    throw new AppError(
      "Unauthorized: Invalid or missing API key in x-api-key or Authorization header",
      401,
      "UNAUTHORIZED"
    );
  }

  next();
}
