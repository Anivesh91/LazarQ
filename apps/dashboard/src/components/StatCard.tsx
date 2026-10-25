import React from "react";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: number | string;
  subtext?: string;
  icon: LucideIcon;
  variant?: "default" | "amber" | "emerald" | "rose" | "cyan";
}

const variantStyles = {
  default: {
    border: "border-slate-800",
    bg: "bg-slate-900/60",
    iconBg: "bg-slate-800 text-slate-300",
    valueColor: "text-white",
  },
  amber: {
    border: "border-amber-900/40 hover:border-amber-700/60",
    bg: "bg-amber-950/20",
    iconBg: "bg-amber-900/30 text-amber-400",
    valueColor: "text-amber-200",
  },
  emerald: {
    border: "border-emerald-900/40 hover:border-emerald-700/60",
    bg: "bg-emerald-950/20",
    iconBg: "bg-emerald-900/30 text-emerald-400",
    valueColor: "text-emerald-200",
  },
  rose: {
    border: "border-rose-900/40 hover:border-rose-700/60",
    bg: "bg-rose-950/20",
    iconBg: "bg-rose-900/30 text-rose-400",
    valueColor: "text-rose-200",
  },
  cyan: {
    border: "border-cyan-900/40 hover:border-cyan-700/60",
    bg: "bg-cyan-950/20",
    iconBg: "bg-cyan-900/30 text-cyan-400",
    valueColor: "text-cyan-200",
  },
};

export function StatCard({
  label,
  value,
  subtext,
  icon: Icon,
  variant = "default",
}: StatCardProps) {
  const styles = variantStyles[variant];

  return (
    <div
      className={`relative overflow-hidden rounded-xl border ${styles.border} ${styles.bg} p-5 backdrop-blur-md transition-all duration-200 hover:shadow-lg`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wider uppercase text-slate-400">
          {label}
        </span>
        <div className={`rounded-lg p-2 ${styles.iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className={`text-3xl font-extrabold tracking-tight ${styles.valueColor}`}>
          {value}
        </span>
      </div>
      {subtext && (
        <p className="mt-1 text-xs text-slate-400 flex items-center gap-1">
          {subtext}
        </p>
      )}
    </div>
  );
}
