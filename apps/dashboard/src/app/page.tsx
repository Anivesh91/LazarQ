"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Flame,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Sidebar } from "../components/Sidebar";
import { Header } from "../components/Header";
import { StatCard } from "../components/StatCard";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { useSSE } from "../lib/use-sse";
import { Incident, SSEEvent } from "../lib/types";

export default function OverviewPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [stats, setStats] = useState({
    total: 0,
    awaitingApproval: 0,
    resolved: 0,
    quarantined: 0,
  });

  const loadData = useCallback(async () => {
    try {
      const incidentsRequest = api
        .getIncidents({ limit: 15 })
        .then((data) => {
          const list = data?.incidents || [];
          setIncidents(list);
          setStats((current) => ({
            ...current,
            total: data?.pagination?.total ?? list.length,
          }));
        })
        .catch((err) => {
          console.error("Failed to load incidents:", err);
        });
      const metricsRequest = api
        .getMetrics()
        .then((metrics) => {
          setStats((current) => ({
            ...current,
            awaitingApproval: metrics.statusCounts["AWAITING_APPROVAL"] || 0,
            resolved: metrics.statusCounts["RESOLVED"] || 0,
            quarantined:
              (metrics.statusCounts["QUARANTINED"] || 0) +
              (metrics.statusCounts["SANDBOX_FAILED"] || 0) +
              (metrics.statusCounts["REPLAY_FAILED"] || 0),
          }));
        })
        .catch((err) => {
          console.error("Failed to load incident metrics:", err);
        });
      await Promise.all([incidentsRequest, metricsRequest]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Listen to live SSE broadcasts from Engine
  const { status: sseStatus, eventHistory } = useSSE(
    useCallback(
      (event: SSEEvent) => {
        // Whenever a new incident lifecycle event arrives, refresh the list
        if (
          event.type.startsWith("incident:") ||
          event.type === "incident:new" ||
          event.type === "incident:resolved"
        ) {
          loadData();
        }
      },
      [loadData]
    )
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleManualRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const liveSyncLabel =
    sseStatus === "connected"
      ? "Live Sync Active"
      : sseStatus === "connecting"
      ? "Connecting to Live Sync"
      : "Live Sync Disconnected";

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar
        sseStatus={sseStatus}
        pendingApprovalsCount={stats.awaitingApproval}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title="Autonomous Recovery Cockpit"
          description="Live dead-letter queue monitoring, RAG diagnosis, and controlled replay gate"
          onRefresh={handleManualRefresh}
          isRefreshing={refreshing}
        />

        <main className="p-8 space-y-8 flex-1">
          {/* Top 4 Stat Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <StatCard
              label="Terminal Failures Captured"
              value={stats.total}
              subtext="Exhausted BullMQ worker retries"
              icon={Flame}
              variant="default"
            />
            <StatCard
              label="Awaiting Human Approval"
              value={stats.awaitingApproval}
              subtext="Passed 5-Stage Sandbox Gate"
              icon={Clock}
              variant="amber"
            />
            <StatCard
              label="Successfully Healed"
              value={stats.resolved}
              subtext="Re-injected & verified in worker"
              icon={CheckCircle2}
              variant="emerald"
            />
            <StatCard
              label="Quarantined / Unsafe"
              value={stats.quarantined}
              subtext="Blocked by invariants or no SOP"
              icon={ShieldAlert}
              variant="rose"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Recent Incidents Table (2 Cols) */}
            <div className="lg:col-span-2 rounded-xl border border-slate-900 bg-slate-950/60 backdrop-blur-md overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-900 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    Live Incident Vault
                  </h2>
                  <p className="text-xs text-slate-400">
                    Real-time failure intake and AI repair pipeline
                  </p>
                </div>
                <Link
                  href="/incidents"
                  className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors"
                >
                  <span>View All Incidents</span>
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-900/40 text-xs uppercase font-medium text-slate-400 border-b border-slate-900">
                    <tr>
                      <th className="px-6 py-3">Status</th>
                      <th className="px-6 py-3">Queue / Job</th>
                      <th className="px-6 py-3">Error Diagnosis</th>
                      <th className="px-6 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/60">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-6 py-8 text-center text-slate-500"
                        >
                          <div className="flex items-center justify-center gap-2">
                            <RotateCcw className="h-4 w-4 animate-spin text-slate-400" />
                            <span>Loading incidents...</span>
                          </div>
                        </td>
                      </tr>
                    ) : (incidents || []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-6 py-12 text-center text-slate-500"
                        >
                          <Sparkles className="h-8 w-8 mx-auto text-slate-600 mb-2" />
                          <p className="text-sm font-medium text-slate-400">
                            Zero Failures Ingested
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            Your BullMQ workers are healthy, or run the playground to simulate failures.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      incidents.slice(0, 7).map((incident) => (
                        <tr
                          key={incident.id}
                          className="hover:bg-slate-900/30 transition-colors"
                        >
                          <td className="px-6 py-3.5 whitespace-nowrap">
                            <StatusBadge status={incident.status} size="sm" />
                          </td>
                          <td className="px-6 py-3.5 whitespace-nowrap">
                            <div className="font-medium text-slate-200">
                              {incident.jobName}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">
                              {incident.queueName}
                            </div>
                          </td>
                          <td className="px-6 py-3.5 max-w-xs truncate">
                            <span className="text-slate-300 text-xs">
                              {incident.aiDiagnosis?.rootCause ||
                                incident.errorMessage}
                            </span>
                            {incident.aiDiagnosis?.action && (
                              <div className="text-[11px] text-cyan-400 font-medium mt-0.5">
                                AI: {incident.aiDiagnosis.action}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-3.5 whitespace-nowrap text-right">
                            <Link
                              href={`/incidents/${incident.id}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 text-xs font-medium text-cyan-400 hover:text-cyan-300 border border-slate-800 transition-colors"
                            >
                              Inspect
                            </Link>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Live SSE Activity Stream (1 Col) */}
            <div className="rounded-xl border border-slate-900 bg-slate-950/60 backdrop-blur-md p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b border-slate-900 pb-4">
                  <div className="flex items-center gap-2">
                    <Radio className="h-4 w-4 text-emerald-400 animate-pulse" />
                    <h2 className="text-base font-semibold text-white">
                      Live Event Stream
                    </h2>
                  </div>
                  <span className="text-[11px] font-mono text-slate-500">
                    SSE 25s Ping
                  </span>
                </div>

                <div className="mt-4 space-y-3 max-h-[460px] overflow-y-auto pr-1">
                  {eventHistory.length === 0 ? (
                    <div className="py-12 text-center text-slate-500">
                      <p className="text-xs">Listening for Engine events...</p>
                    </div>
                  ) : (
                    eventHistory.slice(0, 10).map((ev, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-lg bg-slate-900/50 border border-slate-800/80 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between text-slate-400">
                          <span className="font-semibold text-cyan-400 uppercase tracking-wider text-[10px]">
                            {ev.type}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {new Date(ev.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="text-slate-300 font-mono text-[11px] truncate">
                          {ev.data?.incidentId ? `ID: ${ev.data.incidentId}` : ""}
                          {ev.data?.queueName ? ` [${ev.data.queueName}]` : ""}
                          {ev.data?.status ? ` ➔ ${ev.data.status}` : ""}
                          {ev.data?.message ? ` ${ev.data.message}` : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-900 mt-4 text-[11px] text-slate-500 flex items-center justify-between">
                <span>LazarQ Engine v1.0</span>
                <span
                  className={`font-medium flex items-center gap-1 ${
                    sseStatus === "connected"
                      ? "text-emerald-400"
                      : sseStatus === "connecting"
                      ? "text-amber-400"
                      : "text-rose-400"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full inline-block ${
                      sseStatus === "connected"
                        ? "bg-emerald-400"
                        : sseStatus === "connecting"
                        ? "bg-amber-400"
                        : "bg-rose-400"
                    }`}
                  />
                  {liveSyncLabel}
                </span>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
