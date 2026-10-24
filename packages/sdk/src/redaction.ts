/**
 * Recursively redacts sensitive values from an object or array.
 */
export function redactPayload(
  data: any,
  redactFields: string[] = []
): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactPayload(item, redactFields));
  }

  const normalizedRedactKeys = new Set(
    redactFields.map((f) => f.toLowerCase())
  );

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    const isSensitive = normalizedRedactKeys.has(key.toLowerCase());

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = redactPayload(value, redactFields);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
