const SENSITIVE_LAST_TOKENS = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "secretkey",
  "accesskey",
  "authkey",
  "signingkey",
  "encryptionkey",
  "masterkey",
  "authorization",
  "credentials",
  "cvv",
  "ssn",
  "creditcard",
  "cardnumber",
  "email",
  "phone",
  "phonenumber",
  "mobile",
  "cookie",
  "connectionstring",
  "databaseurl",
]);

const SENSITIVE_TWO_TOKEN_SUFFIXES = new Set([
  "api_key",
  "secret_key",
  "private_key",
  "access_key",
  "auth_key",
  "signing_key",
  "encryption_key",
  "master_key",
  "client_secret",
  "webhook_secret",
  "signing_secret",
  "bearer_token",
  "auth_token",
  "session_token",
  "access_token",
  "refresh_token",
  "id_token",
  "card_number",
  "credit_card",
  "phone_number",
  "connection_string",
  "database_url",
  "set_cookie",
  "email_address",
  "mail_address",
  "password_hash",
]);

function splitIdentifierTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function buildKeyMatcher(redactFields: string[]) {
  const exactLower = new Set<string>();
  const compact = new Set<string>();

  for (const field of redactFields) {
    const trimmed = field.trim().toLowerCase();
    if (!trimmed) continue;
    exactLower.add(trimmed);
    compact.add(trimmed.replace(/[^a-z0-9]/g, ""));
  }

  return function isSensitive(key: string): boolean {
    const lower = key.toLowerCase();
    const stripped = lower.replace(/[^a-z0-9]/g, "");

    if (exactLower.has(lower) || compact.has(stripped)) {
      return true;
    }

    const tokens = splitIdentifierTokens(key);
    if (tokens.length === 0) {
      return false;
    }

    const lastToken = tokens[tokens.length - 1];
    if (SENSITIVE_LAST_TOKENS.has(lastToken)) {
      return true;
    }

    if (tokens.length >= 2) {
      const lastTwoUnderscore = `${tokens[tokens.length - 2]}_${lastToken}`;
      const lastTwoJoined = `${tokens[tokens.length - 2]}${lastToken}`;
      if (
        SENSITIVE_TWO_TOKEN_SUFFIXES.has(lastTwoUnderscore) ||
        SENSITIVE_LAST_TOKENS.has(lastTwoJoined)
      ) {
        return true;
      }
    }

    return false;
  };
}

function redactRecursive(
  data: any,
  isSensitiveKey: (key: string) => boolean,
  seen: WeakSet<object>
): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== "object") {
    return data;
  }

  if (data instanceof Date) {
    return new Date(data.getTime());
  }

  if (data instanceof RegExp) {
    return new RegExp(data.source, data.flags);
  }

  if (seen.has(data)) {
    return "[Circular]";
  }

  seen.add(data);
  try {
    if (Array.isArray(data)) {
      return data.map((item) => redactRecursive(item, isSensitiveKey, seen));
    }

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
      const nextVal = isSensitiveKey(key)
        ? "[REDACTED]"
        : typeof value === "object" && value !== null
        ? redactRecursive(value, isSensitiveKey, seen)
        : value;
      Object.defineProperty(sanitized, key, {
        value: nextVal,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return sanitized;
  } finally {
    seen.delete(data);
  }
}

/**
 * Recursively redacts sensitive values from an object or array.
 */
export function redactPayload(
  data: any,
  redactFields: string[] = []
): any {
  const isSensitiveKey = buildKeyMatcher(redactFields);
  return redactRecursive(data, isSensitiveKey, new WeakSet<object>());
}

/**
 * Extracts primitive string secret values associated with sensitive keys from an object
 * so they can also be stripped from error messages and stack traces.
 */
export function collectSensitiveValues(
  data: any,
  redactFields: string[] = []
): string[] {
  const isSensitiveKey = buildKeyMatcher(redactFields);
  const collected = new Set<string>();
  const seen = new WeakSet<object>();

  function walk(node: any, insideSensitiveKey: boolean): void {
    if (node === null || node === undefined) {
      return;
    }

    if (typeof node === "string") {
      const trimmed = node.trim();
      if (
        insideSensitiveKey &&
        trimmed.length >= 4 &&
        trimmed !== "[REDACTED]" &&
        trimmed !== "[Circular]"
      ) {
        collected.add(trimmed);
      }
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    if (node instanceof Date || node instanceof RegExp || seen.has(node)) {
      return;
    }

    seen.add(node);
    try {
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, insideSensitiveKey);
        }
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        walk(value, insideSensitiveKey || isSensitiveKey(key));
      }
    } finally {
      seen.delete(node);
    }
  }

  walk(data, false);
  return Array.from(collected);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrubs secret values, auth headers, tokens, connection strings, private keys, and emails
 * from error messages and stack traces before persisting or logging.
 */
export function redactErrorText(
  text: string,
  sensitiveValues: string[] = []
): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  let output = text;

  const sortedValues = Array.from(new Set(sensitiveValues))
    .filter((v) => typeof v === "string" && v.length >= 4)
    .sort((a, b) => b.length - a.length);

  for (const secretVal of sortedValues) {
    const matcher = new RegExp(escapeRegExp(secretVal), "g");
    output = output.replace(matcher, "[REDACTED]");
  }

  // PEM private key blocks
  output = output.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );

  // URL credentials: postgres://user:pass@host, redis://:pass@host
  output = output.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]*:)([^@\s]+)(@)/g,
    "$1[REDACTED]$3"
  );

  // Authorization headers and Bearer/Basic schemes
  output = output.replace(
    /(\bauthorization\s*[:=]\s*)(?:Bearer|Basic|Token)\s+[^\s,;'"`}\]]+/gi,
    "$1[REDACTED]"
  );
  output = output.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    "$1 [REDACTED]"
  );

  // Key=value / JSON-like inline secret assignments
  output = output.replace(
    /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|bearer[-_]?token|auth[-_]?token|secret[-_]?key|client[-_]?secret|webhook[-_]?secret|signing[-_]?secret|private[-_]?key|secret|password|passwd|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,&;'"}\]]+)/gi,
    "$1[REDACTED]"
  );

  // Known vendor token formats & JWTs
  output = output.replace(
    /\b(?:sk_(?:live|test)_[0-9A-Za-z]{8,}|rk_(?:live|test)_[0-9A-Za-z]{8,}|whsec_[0-9A-Za-z]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/g,
    "[REDACTED]"
  );

  // Email addresses
  output = output.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    "[REDACTED_EMAIL]"
  );

  return output;
}

export function hasRedactedPlaceholder(data: unknown): boolean {
  const seen = new WeakSet<object>();

  function scan(node: unknown): boolean {
    if (typeof node === "string") {
      return node === "[REDACTED]" || node === "[REDACTED_EMAIL]";
    }
    if (!node || typeof node !== "object") {
      return false;
    }
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      return node.some(scan);
    }
    return Object.values(node).some(scan);
  }

  return scan(data);
}
