export const GLOBAL_ALLOWED_MUTATIONS: readonly string[] = [
  "notificationChannel",
  "channel",
  "retryDelay",
  "delaySeconds",
  "timeout",
  "headers",
  "metadata",
  "callbackUrl",
  "fallbackEmail",
];

export const QUEUE_ALLOWED_MUTATION_REGISTRY: Record<string, string[]> = {
  "order-fulfillment-queue": [
    "notificationChannel",
    "channel",
    "retryDelay",
    "delaySeconds",
    "metadata",
  ],
  "order-queue": [
    "notificationChannel",
    "channel",
    "retryDelay",
    "delaySeconds",
    "metadata",
  ],
  "notification-queue": [
    "notificationChannel",
    "channel",
    "provider",
    "priority",
    "retryDelay",
  ],
};

export interface AllowedMutationsCheckResult {
  passed: boolean;
  unauthorizedFields: string[];
}

/**
 * Validates that all proposed mutations belong to the queue's whitelist of permitted mutations.
 */
export function checkAllowedMutations(
  mutations: Array<{ field: string; from?: any; to?: any }>,
  queueName?: string
): AllowedMutationsCheckResult {
  const unauthorizedFields: string[] = [];
  const queueAllowed = queueName ? QUEUE_ALLOWED_MUTATION_REGISTRY[queueName] || [] : [];
  const allowedFields = new Set([...GLOBAL_ALLOWED_MUTATIONS, ...queueAllowed]);

  for (const mut of mutations) {
    if (!mut.field) continue;

    // Check root path for nested fields (e.g. "metadata.retry" -> "metadata")
    const rootField = mut.field.split(".")[0];

    if (!allowedFields.has(mut.field) && !allowedFields.has(rootField)) {
      unauthorizedFields.push(mut.field);
    }
  }

  return {
    passed: unauthorizedFields.length === 0,
    unauthorizedFields,
  };
}
