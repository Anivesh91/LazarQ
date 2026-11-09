import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const OPERATOR_SESSION_COOKIE = "dlq-operator-session";
export const OPERATOR_SESSION_MAX_AGE = 8 * 60 * 60;

function getOperatorSessionSecret(): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function isOperatorAuthEnabled(): boolean {
  return Boolean(
    process.env.DASHBOARD_OPERATOR_PASSWORD && getOperatorSessionSecret()
  );
}

function signExpiry(expiry: string, secret: string): string {
  return createHmac("sha256", secret).update(expiry).digest("base64url");
}

export function createOperatorSession(): string | null {
  const secret = getOperatorSessionSecret();
  if (!secret) return null;

  const expiry = String(Math.floor(Date.now() / 1000) + OPERATOR_SESSION_MAX_AGE);
  return `${expiry}.${signExpiry(expiry, secret)}`;
}

export function isAuthorizedOperatorSession(request: NextRequest): boolean {
  if (!isOperatorAuthEnabled()) {
    // If operator auth is not configured, allow access (local dev / demo mode)
    return true;
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
