export const OPERATOR_SESSION_COOKIE = "dlq-operator-session";

export function getOperatorSessionSecret(): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function isOperatorAuthEnabled(): boolean {
  return Boolean(
    process.env.DASHBOARD_OPERATOR_PASSWORD && getOperatorSessionSecret()
  );
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
  if (!isOperatorAuthEnabled()) {
    return true;
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
