"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight, Check, Code2, Copy } from "lucide-react";
import { RepairMutation } from "../lib/types";
import {
  collectJsonFieldDiffs,
  computeJsonLineDiff,
  DiffLine,
} from "../lib/payload-diff";

interface PayloadDiffViewerProps {
  payloadSnapshot: Record<string, unknown>;
  proposedPayload?: Record<string, unknown> | null;
  mutations?: RepairMutation[];
}

function formatCompactValue(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 60
      ? `${serialized.slice(0, 57)}...`
      : serialized;
  } catch {
    return String(value);
  }
}

function DiffCodePane({
  lines,
  emptyLabel,
}: {
  lines: DiffLine[];
  emptyLabel?: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 text-xs font-mono text-slate-500 min-h-40 flex items-center justify-center">
        {emptyLabel || "// Empty payload"}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-slate-900/60 border border-slate-800 text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto py-2">
      {lines.map((line) => {
        const isRemoved = line.kind === "removed";
        const isAdded = line.kind === "added";

        const rowClasses = isRemoved
          ? "bg-rose-950/50 border-l-2 border-rose-500 text-rose-200"
          : isAdded
          ? "bg-emerald-950/50 border-l-2 border-emerald-500 text-emerald-200"
          : "border-l-2 border-transparent text-slate-300";

        const symbol = isRemoved ? "-" : isAdded ? "+" : " ";
        const symbolColor = isRemoved
          ? "text-rose-400"
          : isAdded
          ? "text-emerald-400"
          : "text-slate-600";

        return (
          <div
            key={`${line.lineNumber}-${line.kind}`}
            className={`flex items-start px-3 py-0.5 leading-5 ${rowClasses}`}
          >
            <span className="w-7 shrink-0 text-right pr-2 select-none text-slate-600">
              {line.lineNumber}
            </span>
            <span className={`w-4 shrink-0 select-none font-bold ${symbolColor}`}>
              {symbol}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function PayloadDiffViewer({
  payloadSnapshot,
  proposedPayload,
  mutations,
}: PayloadDiffViewerProps) {
  const [copiedPane, setCopiedPane] = useState<"original" | "proposed" | null>(
    null
  );

  const fieldDiffs = useMemo(
    () =>
      proposedPayload
        ? collectJsonFieldDiffs(payloadSnapshot, proposedPayload)
        : [],
    [payloadSnapshot, proposedPayload]
  );

  const { originalLines, proposedLines } = useMemo(
    () => computeJsonLineDiff(payloadSnapshot, proposedPayload ?? null),
    [payloadSnapshot, proposedPayload]
  );

  const handleCopy = async (
    pane: "original" | "proposed",
    data: Record<string, unknown> | null | undefined
  ) => {
    if (!data || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopiedPane(pane);
      setTimeout(() => setCopiedPane(null), 1500);
    } catch {
      // clipboard permission unavailable
    }
  };

  return (
    <div className="rounded-xl border border-slate-900 bg-slate-950/60 overflow-hidden">
      <div className="px-6 py-3.5 border-b border-slate-900 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">
            Payload Mutation Inspector (Original vs AI Proposed)
          </h3>
        </div>

        <div className="flex items-center gap-3">
          {!proposedPayload ? (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
              No Replay Payload
            </span>
          ) : fieldDiffs.length === 0 ? (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-950/70 text-cyan-300 border border-cyan-800/60">
              Untouched Payload (0 Mutations)
            </span>
          ) : (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-800/60">
              {fieldDiffs.length} {fieldDiffs.length === 1 ? "Field" : "Fields"} Mutated
            </span>
          )}
          <span className="text-[11px] text-slate-500 font-mono">
            Immutable Fields (orderId, userId, amount) Protected
          </span>
        </div>
      </div>

      {/* Inline Changed Fields Strip */}
      {fieldDiffs.length > 0 && (
        <div className="px-6 py-3 bg-slate-900/35 border-b border-slate-900 flex flex-wrap gap-2">
          {fieldDiffs.map((diff) => {
            const mutationReason = mutations?.find(
              (m) => m.field === diff.path
            )?.reason;

            return (
              <div
                key={diff.path}
                title={mutationReason || diff.path}
                className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono"
              >
                <span className="text-cyan-400 font-semibold">{diff.path}</span>
                {diff.kind !== "added" && (
                  <span className="px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 line-through">
                    {formatCompactValue(diff.before)}
                  </span>
                )}
                {diff.kind === "modified" && (
                  <ArrowRight className="h-3 w-3 text-slate-500 shrink-0" />
                )}
                {diff.kind !== "removed" && (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 font-semibold">
                    {formatCompactValue(diff.after)}
                  </span>
                )}
                {mutationReason && (
                  <span className="text-[11px] font-sans text-slate-400 hidden sm:inline">
                    ({mutationReason})
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-900">
        {/* Original Payload */}
        <div className="p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider">
              Original Failed Payload Snapshot
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 font-mono">
                Immutable
              </span>
              <button
                type="button"
                onClick={() => handleCopy("original", payloadSnapshot)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
                title="Copy original payload JSON"
              >
                {copiedPane === "original" ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copiedPane === "original" ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>

          <DiffCodePane lines={originalLines} />
        </div>

        {/* Proposed Payload */}
        <div className="p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
              Repaired Payload (Validation Passed)
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 font-mono">
                Target for Re-injection
              </span>
              {proposedPayload && (
                <button
                  type="button"
                  onClick={() => handleCopy("proposed", proposedPayload)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
                  title="Copy repaired payload JSON"
                >
                  {copiedPane === "proposed" ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span>{copiedPane === "proposed" ? "Copied" : "Copy"}</span>
                </button>
              )}
            </div>
          </div>

          <DiffCodePane
            lines={proposedLines}
            emptyLabel="// No proposed payload generated (Quarantined or awaiting AI diagnosis)"
          />
        </div>
      </div>
    </div>
  );
}
