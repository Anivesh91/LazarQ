import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const OPERATOR_SESSION_COOKIE = "dlq-operator-session";
export const OPERATOR_SESSION_MAX_AGE = 8 * 60 * 60;

export interface OperatorAuthState {
  authRequired: boolean;
  configured: boolean;
  misconfigured: boolean;
  reason?: string;
}

function getOperatorSessionSecret(): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function getOperatorAuthState(): OperatorAuthState {
  const rawPassword = process.env.DASHBOARD_OPERATOR_PASSWORD;
  const rawSecret = process.env.DASHBOARD_SESSION_SECRET;
  const passwordConfigured = Boolean(rawPassword && rawPassword.trim().length > 0);
  const secretValid = Boolean(rawSecret && rawSecret.length >= 32);
  const anyValueProvided = Boolean(
    (rawPassword !== undefined && rawPassword.length > 0) ||
      (rawSecret !== undefined && rawSecret.length > 0)
  );

  if (passwordConfigured && secretValid) {
    return {
      authRequired: true,
      configured: true,
      misconfigured: false,
    };
  }

  if (anyValueProvided) {
    const reasons: string[] = [];
    if (!passwordConfigured) {
      reasons.push("DASHBOARD_OPERATOR_PASSWORD is missing or blank");
    }
    if (!rawSecret || rawSecret.length === 0) {
      reasons.push("DASHBOARD_SESSION_SECRET is missing");
    } else if (rawSecret.length < 32) {
      reasons.push("DASHBOARD_SESSION_SECRET must be at least 32 characters");
    }
    return {
      authRequired: true,
      configured: false,
      misconfigured: true,
      reason: `Incomplete operator auth configuration: ${reasons.join("; ")}`,
    };
  }

  if (process.env.NODE_ENV === "production") {
    return {
      authRequired: true,
      configured: false,
      misconfigured: true,
      reason:
        "DASHBOARD_OPERATOR_PASSWORD and DASHBOARD_SESSION_SECRET (min 32 chars) must be set when NODE_ENV=production",
    };
  }

  return {
    authRequired: false,
    configured: false,
    misconfigured: false,
  };
}

export function isOperatorAuthEnabled(): boolean {
  return getOperatorAuthState().authRequired;
}

function signExpiry(expiry: string, secret: string): string {
  return createHmac("sha256", secret).update(expiry).digest("base64url");
}

export function createOperatorSession(): string | null {
  const authState = getOperatorAuthState();
  if (!authState.configured) return null;

  const secret = getOperatorSessionSecret();
  if (!secret) return null;

  const expiry = String(Math.floor(Date.now() / 1000) + OPERATOR_SESSION_MAX_AGE);
  return `${expiry}.${signExpiry(expiry, secret)}`;
}

export function isAuthorizedOperatorSession(request: NextRequest): boolean {
  const authState = getOperatorAuthState();
  if (!authState.authRequired) {
    // Only when NODE_ENV !== "production" and no auth env vars are set
    return true;
  }
  if (!authState.configured || authState.misconfigured) {
    // Fail closed on partial/invalid config or unconfigured production
    return false;
  }

  const secret = getOperatorSessionSecret();
  const token = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  if (!secret || !token) return false;

  const [expiry, signature, extra] = token.split(".");
  if (!expiry || !signature || extra !== undefined) return false;

  const expirySeconds = Number(expiry);
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= Date.now() / 1000) {
    return false;
  }

  const expected = Buffer.from(signExpiry(expiry, secret));
  const provided = Buffer.from(signature);
  return (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  );
}

export function isValidOperatorPassword(password: string): boolean {
  const configuredPassword = process.env.DASHBOARD_OPERATOR_PASSWORD;
  if (!configuredPassword) return false;

  const expected = createHash("sha256").update(configuredPassword).digest();
  const provided = createHash("sha256").update(password).digest();
  return timingSafeEqual(expected, provided);
}
