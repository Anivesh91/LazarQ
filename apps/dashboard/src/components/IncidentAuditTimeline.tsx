"use client";

import React from "react";
import { ScrollText } from "lucide-react";
import { AuditLogEntry } from "../lib/types";

interface IncidentAuditTimelineProps {
  history: AuditLogEntry[];
}

function getActionStyle(action: string): {
  dot: string;
  badge: string;
  label: string;
} {
  switch (action) {
    case "RECOVERY_RESOLVED":
    case "RECOVERY_APPROVED":
    case "AWAITING_APPROVAL":
      return {
        dot: "bg-emerald-400 shadow-[0_0_8px_#34d399]",
        badge: "bg-emerald-950/70 text-emerald-300 border-emerald-800/70",
        label: action,
      };
    case "RAG_MATCHED":
    case "PROPOSAL_READY":
    case "JOB_REPLAYED":
    case "STATUS_TRANSITION":
      return {
        dot: "bg-cyan-400",
        badge: "bg-cyan-950/70 text-cyan-300 border-cyan-800/70",
        label: action,
      };
    case "FAILURE_CAPTURED":
    case "CIRCUIT_BREAKER_TRIPPED":
      return {
        dot: "bg-amber-400",
        badge: "bg-amber-950/70 text-amber-300 border-amber-800/70",
        label: action,
      };
    case "QUARANTINED":
    case "SANDBOX_FAILED":
    case "RECOVERY_REJECTED":
    case "RECOVERY_REPLAY_FAILED":
    case "ANALYSIS_FAILED":
      return {
        dot: "bg-rose-400",
        badge: "bg-rose-950/70 text-rose-300 border-rose-800/70",
        label: action,
      };
    default:
      return {
        dot: "bg-slate-400",
        badge: "bg-slate-900 text-slate-300 border-slate-700",
        label: action,
      };
  }
}

function formatAuditSummary(entry: AuditLogEntry): string | null {
  const details = entry.details;
  if (!details) return null;

  if (typeof details.from === "string" && typeof details.to === "string") {
    return `Transitioned state from ${details.from} to ${details.to}`;
  }
  if (typeof details.runbookTitle === "string") {
    const sim =
      typeof details.similarity === "number"
        ? ` (${(details.similarity * 100).toFixed(1)}% similarity)`
        : "";
    return `Matched Runbook "${details.runbookTitle}"${sim}`;
  }
  if (typeof details.rootCause === "string") {
    return details.rootCause;
  }
  if (typeof details.reason === "string") {
    return details.reason;
  }
  if (typeof details.failedReason === "string") {
    return details.failedReason;
  }
  if (typeof details.error === "string") {
    return details.error;
  }
  if (typeof details.replayJobId === "string") {
    const queue =
      typeof details.queueName === "string" ? ` on ${details.queueName}` : "";
    return `Replay job ${details.replayJobId}${queue}`;
  }
  if (typeof details.errorMessage === "string") {
    return details.errorMessage;
  }
  return null;
}

export function IncidentAuditTimeline({
  history,
}: IncidentAuditTimelineProps) {
  return (
    <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-6 space-y-4">
      <div className="flex items-center justify-between border-b border-slate-900 pb-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">
            Incident Audit Trail Timeline
          </h3>
        </div>
        <span className="text-xs text-slate-400 font-mono">
          {history.length} Recorded {history.length === 1 ? "Event" : "Events"}
        </span>
      </div>

      {history.length === 0 ? (
        <p className="text-xs text-slate-500 py-4 text-center">
          No audit log events recorded for this incident yet.
        </p>
      ) : (
        <div className="relative pl-6 space-y-4">
          <div
            aria-hidden="true"
            className="absolute left-2 top-2 bottom-2 w-px bg-slate-800"
          />

          {history.map((entry) => {
            const style = getActionStyle(entry.action);
            const summary = formatAuditSummary(entry);
            const hasDetails =
              entry.details && Object.keys(entry.details).length > 0;

            return (
              <div key={entry.id} className="relative">
                <span
                  aria-hidden="true"
                  className={`absolute -left-[20px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-slate-950 ${style.dot}`}
                />

                <div className="rounded-lg border border-slate-900 bg-slate-900/40 p-3.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded border ${style.badge}`}
                      >
                        {style.label}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        actor:{" "}
                        <span className="text-slate-200">{entry.actor}</span>
                      </span>
                    </div>

                    <time
                      dateTime={entry.createdAt}
                      className="text-[11px] font-mono text-slate-500"
                    >
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </div>

                  {summary && (
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {summary}
                    </p>
                  )}

                  {hasDetails && (
                    <details className="text-[11px] text-slate-400">
                      <summary className="cursor-pointer font-mono text-slate-500 hover:text-slate-300 select-none">
                        Event metadata
                      </summary>
                      <pre className="mt-2 p-2.5 rounded bg-slate-950 border border-slate-900 text-[11px] font-mono text-slate-300 overflow-x-auto">
                        {JSON.stringify(entry.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
