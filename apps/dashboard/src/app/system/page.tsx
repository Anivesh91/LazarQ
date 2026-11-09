"use client";

import React, { useEffect, useState } from "react";
import {
  Database,
  Server,
  Shield,
  Zap,
} from "lucide-react";
import { Sidebar } from "../../components/Sidebar";
import { Header } from "../../components/Header";
import { api } from "../../lib/api";
import { SystemHealth } from "../../lib/types";

type CircuitBreakerStatus = Awaited<
  ReturnType<typeof api.getCircuitBreakerStatus>
>;

export default function SystemPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [breaker, setBreaker] = useState<CircuitBreakerStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const loadSystem = async () => {
    setLoading(true);
    setBreaker(null);
    const [healthResult, breakerResult] = await Promise.allSettled([
      api.getHealth(),
      api.getCircuitBreakerStatus(),
    ]);
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
    } else {
      setHealth(null);
      console.error("Failed to load system health:", healthResult.reason);
    }
    if (
      breakerResult.status === "fulfilled" &&
      breakerResult.value.success
    ) {
      setBreaker(breakerResult.value);
    } else {
      setBreaker(null);
      if (breakerResult.status === "rejected") {
        console.error(
          "Failed to load circuit breaker status:",
          breakerResult.reason
        );
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    loadSystem();
  }, []);

  const breakerHealthy =
    breaker !== null &&
    breaker.success &&
    breaker.openBreakers === 0 &&
    breaker.breakers.every((item) => item.state === "CLOSED");
  const breakerState = breaker
    ? breaker.openBreakers > 0 ||
      breaker.breakers.some((item) => item.state === "OPEN")
      ? "OPEN"
      : breaker.breakers.some((item) => item.state === "HALF_OPEN")
      ? "HALF_OPEN"
      : "CLOSED (HEALTHY)"
    : loading
    ? "LOADING"
    : "UNAVAILABLE";
  const breakerStatusColor = breakerHealthy
    ? "text-emerald-300 border-emerald-800 bg-emerald-950/60"
    : breakerState === "OPEN"
    ? "text-rose-300 border-rose-800 bg-rose-950/60"
    : "text-amber-300 border-amber-800 bg-amber-950/60";

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title="System Architecture & Circuit Breaker"
          description="Cascading retry storm prevention, rate limits, and infrastructure health"
          onRefresh={loadSystem}
          isRefreshing={loading}
        />

        <main className="p-8 space-y-6 flex-1 max-w-7xl">
          {/* Circuit Breaker Status Banner */}
          <div className="p-6 rounded-xl border border-slate-900 bg-slate-950/60 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-emerald-400" />
                <h2 className="text-base font-bold text-white">
                  Intake Circuit Breaker Protection
                </h2>
              </div>
              <p className="text-xs text-slate-400">
                Monitors error fingerprints within a 60-second sliding window to prevent cascading failure storms.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-2 ${breakerStatusColor}`}>
                <span
                  className={`h-2 w-2 rounded-full ${
                    breakerHealthy
                      ? "bg-emerald-400 animate-pulse"
                      : breakerState === "OPEN"
                      ? "bg-rose-400"
                      : "bg-amber-400"
                  }`}
                />
                STATE: {breakerState}
              </div>
            </div>
          </div>

          {/* Infrastructure Health Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Redis Card */}
            <div className="p-5 rounded-xl border border-slate-900 bg-slate-950/60 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Redis Cluster
                </span>
                <Server className="h-4 w-4 text-cyan-400" />
              </div>
              <div className="text-xl font-bold text-white flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    health?.redis === "connected"
                      ? "bg-emerald-400"
                      : "bg-rose-400"
                  }`}
                />
                <span>{health?.redis === "connected" ? "Operational" : "Disconnected"}</span>
              </div>
              <p className="text-xs text-slate-500 font-mono">
                Port 6379 • BullMQ intake + streams
              </p>
            </div>

            {/* PostgreSQL Card */}
            <div className="p-5 rounded-xl border border-slate-900 bg-slate-950/60 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  PostgreSQL & pgvector
                </span>
                <Database className="h-4 w-4 text-indigo-400" />
              </div>
              <div className="text-xl font-bold text-white flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    health?.database === "connected"
                      ? "bg-emerald-400"
                      : "bg-rose-400"
                  }`}
                />
                <span>{health?.database === "connected" ? "Operational" : "Disconnected"}</span>
              </div>
              <p className="text-xs text-slate-500 font-mono">
                Port 5432 • {health?.embeddingModel || "768-dim vector embeddings"}
              </p>
            </div>

            {/* LLM Provider Card */}
            <div className="p-5 rounded-xl border border-slate-900 bg-slate-950/60 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  AI Doctor Model
                </span>
                <Zap className="h-4 w-4 text-amber-400" />
              </div>
              <div className="text-xl font-bold text-white flex items-center gap-2 truncate">
                <span className="truncate">
                  {health?.llmModel || (loading ? "Loading..." : "Unavailable")}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-mono">
                {health?.llmProvider ? `${health.llmProvider} • ` : ""}
                Structured JSON mode • Bounded backoff
              </p>
            </div>
          </div>

          {/* Safety Thresholds */}
          <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-6 space-y-4">
            <h3 className="text-sm font-semibold text-white">
              Deterministic Safety & Rate Limiting Guardrails
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-900">
                <div className="text-slate-500">Intake Rate Limit</div>
                <div className="text-sm font-bold text-slate-200 mt-1">10 jobs / second</div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-900">
                <div className="text-slate-500">Circuit Trip Threshold</div>
                <div className="text-sm font-bold text-slate-200 mt-1">&gt; 50 / 60 seconds</div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-900">
                <div className="text-slate-500">LLM Max Retries</div>
                <div className="text-sm font-bold text-slate-200 mt-1">3 bounded attempts</div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-900">
                <div className="text-slate-500">Default Replay Mode</div>
                <div className="text-sm font-bold text-amber-300 mt-1">Human Approval Req.</div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
