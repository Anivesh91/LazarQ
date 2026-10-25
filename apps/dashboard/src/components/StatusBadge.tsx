import React from "react";
import { IncidentStatus } from "../lib/types";

interface StatusBadgeProps {
  status: IncidentStatus;
  size?: "sm" | "md";
}

const statusConfig: Record<
  IncidentStatus,
  { label: string; bg: string; text: string; border: string; dot: string }
> = {
  INGESTED: {
    label: "Ingested",
    bg: "bg-slate-800/80",
    text: "text-slate-300",
    border: "border-slate-700",
    dot: "bg-slate-400",
  },
  ANALYZING: {
    label: "Analyzing (RAG/AI)",
    bg: "bg-blue-950/80",
    text: "text-blue-300",
    border: "border-blue-800",
    dot: "bg-blue-400 animate-pulse",
  },
  RAG_MATCHED: {
    label: "Runbook Matched",
    bg: "bg-cyan-950/80",
    text: "text-cyan-300",
    border: "border-cyan-800",
    dot: "bg-cyan-400",
  },
  PROPOSAL_READY: {
    label: "Proposal Ready",
    bg: "bg-indigo-950/80",
    text: "text-indigo-300",
    border: "border-indigo-800",
    dot: "bg-indigo-400",
  },
  AWAITING_APPROVAL: {
    label: "Awaiting Approval",
    bg: "bg-amber-950/80",
    text: "text-amber-300",
    border: "border-amber-700/60",
    dot: "bg-amber-400 animate-ping",
  },
  REPLAY_QUEUED: {
    label: "Replay Queued",
    bg: "bg-purple-950/80",
    text: "text-purple-300",
    border: "border-purple-800",
    dot: "bg-purple-400",
  },
  REPLAYING: {
    label: "Replaying in Worker",
    bg: "bg-teal-950/80",
    text: "text-teal-300",
    border: "border-teal-800",
    dot: "bg-teal-400 animate-pulse",
  },
  RESOLVED: {
    label: "Healed & Resolved",
    bg: "bg-emerald-950/80",
    text: "text-emerald-300",
    border: "border-emerald-700/60",
    dot: "bg-emerald-400",
  },
  QUARANTINED: {
    label: "Quarantined (Unsafe)",
    bg: "bg-rose-950/80",
    text: "text-rose-300",
    border: "border-rose-800",
    dot: "bg-rose-400",
  },
  SANDBOX_FAILED: {
    label: "Sandbox Rejected",
    bg: "bg-red-950/80",
    text: "text-red-300",
    border: "border-red-800",
    dot: "bg-red-400",
  },
  REPLAY_FAILED: {
    label: "Replay Failed",
    bg: "bg-orange-950/80",
    text: "text-orange-300",
    border: "border-orange-800",
    dot: "bg-orange-400",
  },
  ANALYSIS_FAILED: {
    label: "Analysis Failed",
    bg: "bg-zinc-800/80",
    text: "text-zinc-400",
    border: "border-zinc-700",
    dot: "bg-zinc-500",
  },
};

export function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  const config = statusConfig[status] || {
    label: status,
    bg: "bg-slate-800",
    text: "text-slate-300",
    border: "border-slate-700",
    dot: "bg-slate-400",
  };

  const sizeClasses =
    size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs font-medium";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${config.bg} ${config.text} ${config.border} ${sizeClasses} shadow-sm backdrop-blur-sm`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      <span>{config.label}</span>
    </span>
  );
}
