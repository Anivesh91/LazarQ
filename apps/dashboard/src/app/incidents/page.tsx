"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Check,
  Filter,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { Sidebar } from "../../components/Sidebar";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { useSSE } from "../../lib/use-sse";
import { Incident, SSEEvent } from "../../lib/types";

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [queueSearch, setQueueSearch] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const loadIncidents = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;

    try {
      setLoading(true);
      const data = await api.getIncidents({
        status: statusFilter || undefined,
        queueName: queueSearch || undefined,
        page,
        limit: 15,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const list = data?.incidents || [];
      setIncidents(list);
      setTotalPages(data?.pagination?.totalPages || 1);
      setTotalCount(data?.pagination?.total ?? list.length);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error("Failed to load incidents:", err);
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        setLoading(false);
      }
    }
  }, [statusFilter, queueSearch, page]);

  // Live SSE sync
  const { status: sseStatus } = useSSE(
    useCallback(
      (event: SSEEvent) => {
        if (event.type.startsWith("incident:")) {
          loadIncidents();
        }
      },
      [loadIncidents]
    )
  );

  useEffect(() => {
    loadIncidents();
    return () => requestController.current?.abort();
  }, [loadIncidents]);

  const handleApprove = async (id: string) => {
    try {
      setActionLoadingId(id);
      await api.approveIncident(id, { approvedBy: "dashboard-user", autoReplay: true });
      await loadIncidents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Approval error: ${msg}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt("Enter reason for quarantining this incident:", "Manually rejected by reviewer");
    if (!reason) return;

    try {
      setActionLoadingId(id);
      await api.rejectIncident(id, { rejectedBy: "dashboard-user", reason });
      await loadIncidents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Reject error: ${msg}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const statusOptions: { label: string; value: string }[] = [
    { label: "All Statuses", value: "" },
    { label: "Awaiting Approval", value: "AWAITING_APPROVAL" },
    { label: "Healed (Resolved)", value: "RESOLVED" },
    { label: "Replaying", value: "REPLAYING" },
    { label: "Quarantined", value: "QUARANTINED" },
    { label: "Sandbox Rejected", value: "SANDBOX_FAILED" },
    { label: "Replay Failed", value: "REPLAY_FAILED" },
  ];

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar sseStatus={sseStatus} />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title="Incident Vault & Triage Gate"
          description="Filter, inspect, approve, and execute deterministic job replays"
          onRefresh={loadIncidents}
          isRefreshing={loading}
        />

        <main className="p-8 space-y-6 flex-1">
          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-slate-900 bg-slate-950/60 backdrop-blur-md">
            <div className="flex items-center gap-3 flex-1 min-w-[280px]">
              <div className="relative flex-1 max-w-sm">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-slate-500" />
                <input
                  type="text"
                  placeholder="Filter by queue name..."
                  value={queueSearch}
                  onChange={(e) => {
                    setQueueSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              {/* Status Select */}
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-slate-500" />
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  {statusOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <span className="text-xs text-slate-400 font-mono">
              Total {totalCount} {totalCount === 1 ? "Record" : "Records"}
            </span>
          </div>

          {/* Incidents Table */}
          <div className="rounded-xl border border-slate-900 bg-slate-950/60 backdrop-blur-md overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900/40 text-xs uppercase font-medium text-slate-400 border-b border-slate-900">
                  <tr>
                    <th className="px-6 py-3.5">Status</th>
                    <th className="px-6 py-3.5">Job / Queue</th>
                    <th className="px-6 py-3.5">Attempts</th>
                    <th className="px-6 py-3.5">Error Message</th>
                    <th className="px-6 py-3.5">AI Proposed Action</th>
                    <th className="px-6 py-3.5 text-right">Gate Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/60">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                        <div className="flex items-center justify-center gap-2">
                          <RotateCcw className="h-4 w-4 animate-spin text-slate-400" />
                          <span>Fetching incidents from PostgreSQL...</span>
                        </div>
                      </td>
                    </tr>
                  ) : incidents.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                        No incidents match the active filters.
                      </td>
                    </tr>
                  ) : (
                    incidents.map((inc) => {
                      const isActing = actionLoadingId === inc.id;
                      const canApprove = inc.status === "AWAITING_APPROVAL";

                      return (
                        <tr
                          key={inc.id}
                          className="hover:bg-slate-900/30 transition-colors"
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <StatusBadge status={inc.status} />
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="font-medium text-slate-200">
                              {inc.jobName}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">
                              {inc.queueName}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap font-mono text-xs text-slate-400">
                            {inc.attemptsMade} / {inc.configuredAttempts}
                          </td>
                          <td className="px-6 py-4 max-w-xs truncate text-xs text-slate-300">
                            {inc.errorMessage}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-xs">
                            {inc.aiDiagnosis ? (
                              <span className="font-semibold text-cyan-400">
                                {inc.aiDiagnosis.action}
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right space-x-2">
                            {canApprove && (
                              <button
                                onClick={() => handleApprove(inc.id)}
                                disabled={isActing}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
                              >
                                <Check className="h-3 w-3" />
                                <span>Approve</span>
                              </button>
                            )}

                            {canApprove && (
                              <button
                                onClick={() => handleReject(inc.id)}
                                disabled={isActing}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-rose-400 hover:text-rose-300 border border-rose-900/40 text-xs font-medium transition-colors disabled:opacity-50"
                              >
                                <X className="h-3 w-3" />
                                <span>Quarantine</span>
                              </button>
                            )}

                            <Link
                              href={`/incidents/${inc.id}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 text-xs font-medium transition-colors"
                            >
                              Detail
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-slate-900 flex items-center justify-between text-xs text-slate-400">
                <span>Page {page} of {totalPages}</span>
                <div className="space-x-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
