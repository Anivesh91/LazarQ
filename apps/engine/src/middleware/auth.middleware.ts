import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { isValidProductionEngineApiKey } from "../config/env";
import { AppError } from "./error-handler";

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Validates incoming API requests against configured ENGINE_API_KEY.
 * Fails closed in production if ENGINE_API_KEY is unset, blank, or a known dev default.
 * Allows unrestricted access in local development when no API key is configured.
 */
export function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  // Health remains public so infrastructure probes can run without credentials.
  if (req.path === "/health") {
    return next();
  }

  // In automated test suite, only enforce when explicitly requested
  if (process.env.NODE_ENV === "test" && !process.env.TEST_AUTH_ENABLED) {
    return next();
  }

  const configuredKey = process.env.ENGINE_API_KEY?.trim();

  if (process.env.NODE_ENV === "production") {
    if (!isValidProductionEngineApiKey(configuredKey)) {
      throw new AppError(
        "Unauthorized: ENGINE_API_KEY must be set to a non-default secret in production",
        401,
        "UNAUTHORIZED"
      );
    }
  } else if (!configuredKey) {
    // If no ENGINE_API_KEY configured in non-production, permit access (dev mode)
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
    !configuredKey ||
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
