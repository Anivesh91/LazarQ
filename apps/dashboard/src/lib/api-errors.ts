interface ErrorDetailItem {
  path?: unknown;
  message?: unknown;
}

/**
 * Formats error responses from both the Next.js proxy (`{ message }`) and
 * the Engine API (`{ error, code, details }` or Zod validation arrays).
 */
export function formatEngineErrorMessage(
  status: number,
  statusText: string,
  errorBody: unknown
): string {
  const fallback = `HTTP Error ${status}: ${statusText}`;
  if (!errorBody || typeof errorBody !== "object") {
    return fallback;
  }

  const record = errorBody as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };

  const baseMessage =
    typeof record.error === "string" && record.error.trim().length > 0
      ? record.error.trim()
      : typeof record.message === "string" && record.message.trim().length > 0
      ? record.message.trim()
      : fallback;

  if (!Array.isArray(record.details) || record.details.length === 0) {
    return baseMessage;
  }

  const formattedDetails = (record.details as ErrorDetailItem[])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const detailMessage =
        typeof item.message === "string" ? item.message.trim() : "";
      if (!detailMessage) return null;
      const detailPath =
        typeof item.path === "string" ? item.path.trim() : "";
      return detailPath ? `${detailPath}: ${detailMessage}` : detailMessage;
    })
    .filter((entry): entry is string => Boolean(entry));

  if (formattedDetails.length === 0) {
    return baseMessage;
  }

  return `${baseMessage} (${formattedDetails.join("; ")})`;
}
