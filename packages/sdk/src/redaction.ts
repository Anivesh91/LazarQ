function redactRecursive(
  data: any,
  normalizedRedactKeys: Set<string>,
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
      return data.map((item) => redactRecursive(item, normalizedRedactKeys, seen));
    }

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
      const isSensitive = normalizedRedactKeys.has(key.toLowerCase());

      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = redactRecursive(value, normalizedRedactKeys, seen);
      } else {
        sanitized[key] = value;
      }
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
  const normalizedRedactKeys = new Set(
    redactFields.map((f) => f.toLowerCase())
  );

  return redactRecursive(data, normalizedRedactKeys, new WeakSet<object>());
}
