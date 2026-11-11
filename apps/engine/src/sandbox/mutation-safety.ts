import { createHash } from "crypto";
import { AppError } from "../middleware/error-handler";

export const DISALLOWED_MUTATION_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

export function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertSafeMutationPath(field: string): string[] {
  if (!field || typeof field !== "string") {
    throw new AppError(
      `Unsafe mutation field path rejected: "${String(field)}"`,
      400,
      "UNSAFE_MUTATION_PATH"
    );
  }

  const parts = field.split(".");
  for (const part of parts) {
    if (
      !part ||
      part.trim() !== part ||
      DISALLOWED_MUTATION_SEGMENTS.has(part)
    ) {
      throw new AppError(
        `Unsafe mutation field path rejected: "${field}"`,
        400,
        "UNSAFE_MUTATION_PATH"
      );
    }
  }

  return parts;
}

export function findUnsafeObjectKey(
  value: unknown,
  currentPath = "",
  seen: WeakSet<object> = new WeakSet()
): string | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const ownProps = Object.getOwnPropertyNames(value);
      for (const prop of ownProps) {
        if (prop === "length") continue;
        if (DISALLOWED_MUTATION_SEGMENTS.has(prop)) {
          return currentPath ? `${currentPath}.${prop}` : prop;
        }
      }
      for (let i = 0; i < value.length; i++) {
        const nested = findUnsafeObjectKey(
          value[i],
          `${currentPath}[${i}]`,
          seen
        );
        if (nested) return nested;
      }
      return null;
    }

    if (!isPlainObject(value)) {
      if (value instanceof Date) {
        return null;
      }
      return currentPath || "<non-plain-object>";
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      if (DISALLOWED_MUTATION_SEGMENTS.has(key)) {
        return nextPath;
      }
      const nested = findUnsafeObjectKey(
        (value as Record<string, unknown>)[key],
        nextPath,
        seen
      );
      if (nested) return nested;
    }

    return null;
  } finally {
    seen.delete(value);
  }
}

export function assertSafeJsonValue(value: unknown, label = "value"): void {
  const unsafePath = findUnsafeObjectKey(value);
  if (unsafePath) {
    throw new AppError(
      `Unsafe mutation key rejected in ${label}: "${unsafePath}"`,
      400,
      "UNSAFE_MUTATION_PATH"
    );
  }
}

export function safeCloneJson<T>(
  value: T,
  seen: WeakSet<object> = new WeakSet()
): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }

  if (seen.has(value as object)) {
    throw new AppError(
      "Circular reference detected in JSON payload",
      400,
      "UNSAFE_MUTATION_PATH"
    );
  }

  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => safeCloneJson(item, seen)) as unknown as T;
    }

    if (!isPlainObject(value)) {
      throw new AppError(
        "Non-plain object encountered while cloning payload",
        400,
        "UNSAFE_MUTATION_PATH"
      );
    }

    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (DISALLOWED_MUTATION_SEGMENTS.has(key)) {
        throw new AppError(
          `Unsafe mutation key rejected: "${key}"`,
          400,
          "UNSAFE_MUTATION_PATH"
        );
      }
      Object.defineProperty(cloned, key, {
        value: safeCloneJson((value as Record<string, unknown>)[key], seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return cloned as T;
  } finally {
    seen.delete(value as object);
  }
}

export function applyMutation(
  payload: Record<string, any>,
  field: string,
  to: any
): void {
  if (field === "") return;

  if (!isPlainObject(payload)) {
    throw new AppError(
      "Unsafe mutation target: payload must be a plain object",
      400,
      "UNSAFE_MUTATION_PATH"
    );
  }

  const parts = assertSafeMutationPath(field);
  assertSafeJsonValue(to, `mutation("${field}")`);

  let curr: Record<string, any> = payload;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const hasOwn = Object.prototype.hasOwnProperty.call(curr, key);
    const existing = hasOwn ? curr[key] : undefined;

    if (!hasOwn || existing === null || typeof existing !== "object") {
      const fresh: Record<string, any> = {};
      Object.defineProperty(curr, key, {
        value: fresh,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      curr = fresh;
      continue;
    }

    if (!isPlainObject(existing)) {
      throw new AppError(
        `Unsafe mutation field path rejected: "${field}"`,
        400,
        "UNSAFE_MUTATION_PATH"
      );
    }

    curr = existing;
  }

  const lastKey = parts[parts.length - 1];
  const clonedValue = safeCloneJson(to);
  Object.defineProperty(curr, lastKey, {
    value: clonedValue,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function applyMutations(
  basePayload: Record<string, any>,
  mutations: Array<{ field?: string; to?: any }>
): Record<string, any> {
  const safeBase = safeCloneJson(basePayload);

  // Validate all mutation paths and values up front before applying any change
  for (const mut of mutations || []) {
    if (mut.field !== undefined && mut.field !== "") {
      assertSafeMutationPath(mut.field);
    }
    assertSafeJsonValue(mut.to, `mutation("${mut.field || ""}")`);
  }

  for (const mut of mutations || []) {
    if (mut.field) {
      applyMutation(safeBase, mut.field, mut.to);
    }
  }

  return safeBase;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonicalizeValue(record[key]);
  }
  return sorted;
}

export function computeProposalHash(payload: unknown): string {
  const canonical = JSON.stringify(canonicalizeValue(payload ?? null));
  return createHash("sha256").update(canonical).digest("hex");
}
