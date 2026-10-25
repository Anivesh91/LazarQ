export const GLOBAL_IMMUTABLE_FIELDS: readonly string[] = [
  "id",
  "orderId",
  "userId",
  "customerId",
  "accountId",
  "amount",
  "total",
  "price",
  "currency",
  "tenantId",
  "orgId",
];

export const QUEUE_IMMUTABLE_REGISTRY: Record<string, string[]> = {
  "order-fulfillment-queue": ["orderId", "userId", "amount", "currency", "items"],
  "order-queue": ["orderId", "userId", "amount", "currency"],
  "payment-processing-queue": ["transactionId", "amount", "currency", "accountId"],
};

export interface InvariantCheckResult {
  passed: boolean;
  violations: string[];
}

/**
 * Validates that core immutable invariant fields have not been modified,
 * deleted, or corrupted between the original snapshot and proposed payload.
 */
export function checkInvariants(
  original: Record<string, any>,
  proposed: Record<string, any>,
  queueName?: string
): InvariantCheckResult {
  const violations: string[] = [];
  const queueImmutables = queueName ? QUEUE_IMMUTABLE_REGISTRY[queueName] || [] : [];
  const immutableFields = Array.from(new Set([...GLOBAL_IMMUTABLE_FIELDS, ...queueImmutables]));

  for (const field of immutableFields) {
    // Check if the immutable field was present in the original payload
    if (field in original) {
      if (!(field in proposed)) {
        violations.push(`Immutable field "${field}" was removed from the proposed payload`);
        continue;
      }

      const origVal = JSON.stringify(original[field]);
      const propVal = JSON.stringify(proposed[field]);

      if (origVal !== propVal) {
        violations.push(
          `Immutable field "${field}" was mutated from ${origVal} to ${propVal}`
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
