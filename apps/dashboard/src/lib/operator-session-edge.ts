export const OPERATOR_SESSION_COOKIE = "dlq-operator-session";

export interface OperatorAuthState {
  authRequired: boolean;
  configured: boolean;
  misconfigured: boolean;
  reason?: string;
}

export function getOperatorSessionSecret(): string | null {
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

export function sanitizeNextPath(nextParam: string | null | undefined): string {
  if (!nextParam) return "/";
  const trimmed = nextParam.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\")
  ) {
    return "/";
  }
  return trimmed;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function signExpiryEdge(
  expiry: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(expiry)
  );
  return bytesToBase64Url(new Uint8Array(sigBuffer));
}

export async function verifyOperatorSessionToken(
  token: string | undefined
): Promise<boolean> {
  const authState = getOperatorAuthState();
  if (!authState.authRequired) {
    return true;
  }
  if (!authState.configured || authState.misconfigured) {
    return false;
  }

  const secret = getOperatorSessionSecret();
  if (!secret || !token) return false;

  const [expiry, signature, extra] = token.split(".");
  if (!expiry || !signature || extra !== undefined) return false;

  const expirySeconds = Number(expiry);
  if (
    !Number.isSafeInteger(expirySeconds) ||
    expirySeconds <= Date.now() / 1000
  ) {
    return false;
  }

  const expectedSignature = await signExpiryEdge(expiry, secret);
  return constantTimeEqualStrings(expectedSignature, signature);
}
