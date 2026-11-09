"use client";

import React from "react";
import { Database, Server, RefreshCw } from "lucide-react";
import { useSystemHealth } from "../lib/use-health";

interface HeaderProps {
  title: string;
  description?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function Header({
  title,
  description,
  onRefresh,
  isRefreshing = false,
}: HeaderProps) {
  const { health } = useSystemHealth();

  return (
    <header className="border-b border-slate-900 bg-slate-950/60 backdrop-blur-md px-8 py-5 flex items-center justify-between sticky top-0 z-10">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          {title}
        </h1>
        {description && (
          <p className="text-xs text-slate-400 mt-0.5">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* System Health Indicators */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs">
          <Database className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-slate-400">pgvector:</span>
          <span
            className={`font-semibold ${
              health?.database === "connected"
                ? "text-emerald-400"
                : "text-rose-400"
            }`}
          >
            {health?.database || "checking..."}
          </span>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs">
          <Server className="h-3.5 w-3.5 text-indigo-400" />
          <span className="text-slate-400">Redis:</span>
          <span
            className={`font-semibold ${
              health?.redis === "connected"
                ? "text-emerald-400"
                : "text-rose-400"
            }`}
          >
            {health?.redis || "checking..."}
          </span>
        </div>

        {/* Manual Refresh Trigger */}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 transition-colors disabled:opacity-50"
            title="Refresh state"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-slate-400 ${
                isRefreshing ? "animate-spin" : ""
              }`}
            />
            <span>Sync</span>
          </button>
        )}
      </div>
    </header>
  );
}
