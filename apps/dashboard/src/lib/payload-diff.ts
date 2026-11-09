export interface JsonFieldDiff {
  path: string;
  kind: "modified" | "added" | "removed";
  before?: unknown;
  after?: unknown;
}

export interface DiffLine {
  lineNumber: number;
  text: string;
  kind: "unchanged" | "removed" | "added";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, idx) => isDeepEqual(item, b[idx]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && isDeepEqual(a[key], b[key])
    );
  }

  return false;
}

export function collectJsonFieldDiffs(
  original: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown> | null | undefined,
  prefix = ""
): JsonFieldDiff[] {
  if (!original && !proposed) return [];
  const origObj = original ?? {};
  const propObj = proposed ?? {};

  const diffs: JsonFieldDiff[] = [];
  const allKeys = Array.from(new Set([...Object.keys(origObj), ...Object.keys(propObj)]));

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const hasOrig = Object.prototype.hasOwnProperty.call(origObj, key);
    const hasProp = Object.prototype.hasOwnProperty.call(propObj, key);

    if (!hasOrig && hasProp) {
      diffs.push({ path, kind: "added", after: propObj[key] });
      continue;
    }

    if (hasOrig && !hasProp) {
      diffs.push({ path, kind: "removed", before: origObj[key] });
      continue;
    }

    const beforeVal = origObj[key];
    const afterVal = propObj[key];

    if (isPlainObject(beforeVal) && isPlainObject(afterVal)) {
      diffs.push(...collectJsonFieldDiffs(beforeVal, afterVal, path));
      continue;
    }

    if (!isDeepEqual(beforeVal, afterVal)) {
      diffs.push({
        path,
        kind: "modified",
        before: beforeVal,
        after: afterVal,
      });
    }
  }

  return diffs;
}

function formatJsonLines(value: unknown): string[] {
  try {
    return JSON.stringify(value ?? {}, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

export function computeJsonLineDiff(
  original: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown> | null | undefined
): {
  originalLines: DiffLine[];
  proposedLines: DiffLine[];
} {
  const origRaw = formatJsonLines(original ?? {});

  if (!proposed) {
    return {
      originalLines: origRaw.map((text, idx) => ({
        lineNumber: idx + 1,
        text,
        kind: "unchanged",
      })),
      proposedLines: [],
    };
  }

  const propRaw = formatJsonLines(proposed);
  const n = origRaw.length;
  const m = propRaw.length;

  // Guard against quadratic DP allocation for unusually large payloads
  if (n * m > 250_000) {
    return {
      originalLines: origRaw.map((text, idx) => ({
        lineNumber: idx + 1,
        text,
        kind: propRaw[idx] === text ? "unchanged" : "removed",
      })),
      proposedLines: propRaw.map((text, idx) => ({
        lineNumber: idx + 1,
        text,
        kind: origRaw[idx] === text ? "unchanged" : "added",
      })),
    };
  }

  // Standard LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (origRaw[i] === propRaw[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const matchedOrig = new Set<number>();
  const matchedProp = new Set<number>();

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (origRaw[i] === propRaw[j]) {
      matchedOrig.add(i);
      matchedProp.add(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return {
    originalLines: origRaw.map((text, idx) => ({
      lineNumber: idx + 1,
      text,
      kind: matchedOrig.has(idx) ? "unchanged" : "removed",
    })),
    proposedLines: propRaw.map((text, idx) => ({
      lineNumber: idx + 1,
      text,
      kind: matchedProp.has(idx) ? "unchanged" : "added",
    })),
  };
}
