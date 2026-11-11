import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler";

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

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

  const rawApiKey = req.headers["x-api-key"];
  const rawAuthHeader = req.headers["authorization"];
  const xApiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  const authHeader = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
  const bearerKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const providedKey = xApiKey ?? bearerKey;

  if (
    !providedKey ||
    !timingSafeEqual(hashSecret(providedKey), hashSecret(configuredKey))
  ) {
    throw new AppError(
      "Unauthorized: Invalid or missing API key in x-api-key or Authorization header",
      401,
      "UNAUTHORIZED"
    );
  }

  next();
}
