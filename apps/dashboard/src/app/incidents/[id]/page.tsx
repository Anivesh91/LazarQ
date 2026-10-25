"use client";

import React, { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  Code2,
  History,
  RotateCcw,
  Shield,
  ShieldAlert,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { Sidebar } from "../../../components/Sidebar";
import { Header } from "../../../components/Header";
import { StatusBadge } from "../../../components/StatusBadge";
import { api } from "../../../lib/api";
import { Incident, RecoveryAttempt } from "../../../lib/types";
import { useSSE } from "../../../lib/use-sse";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function IncidentDetailPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const incidentId = resolvedParams.id;
  const router = useRouter();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [recoveries, setRecoveries] = useState<RecoveryAttempt[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [acting, setActing] = useState<boolean>(false);

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      const inc = await api.getIncidentById(incidentId);
      setIncident(inc);

      const recData = await api.getIncidentRecoveries(incidentId);
      setRecoveries(recData.recoveries);
    } catch (err: any) {
      console.error("Failed to load incident detail:", err);
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useSSE(
    useCallback(
      (event: any) => {
        const eventIncidentId =
          event.data?.incidentId ?? event.data?.incident?.id;
        if (event.type.startsWith("incident:") && eventIncidentId === incidentId) {
          loadDetail();
        }
      },
      [incidentId, loadDetail]
    )
  );

  const handleApprove = async () => {
    if (!incident) return;
    try {
      setActing(true);
      await api.approveIncident(incident.id, {
        approvedBy: "dashboard-operator",
        autoReplay: true,
      });
      await loadDetail();
    } catch (err: any) {
      alert(`Approval failed: ${err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    if (!incident) return;
    const reason = prompt("Reason for quarantine rejection:", "Manual operator quarantine");
    if (!reason) return;

    try {
      setActing(true);
      await api.rejectIncident(incident.id, {
        rejectedBy: "dashboard-operator",
        reason,
      });
      await loadDetail();
    } catch (err: any) {
      alert(`Rejection failed: ${err.message}`);
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-3 text-slate-400 text-sm">
            <RotateCcw className="h-5 w-5 animate-spin text-cyan-400" />
            <span>Loading incident details...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <div className="flex-1 p-8">
          <p className="text-rose-400">Incident not found: {incidentId}</p>
          <Link href="/incidents" className="text-cyan-400 underline mt-4 inline-block text-sm">
            Return to Incidents Vault
          </Link>
        </div>
      </div>
    );
  }

  const canApprove = incident.status === "AWAITING_APPROVAL";

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title={`Incident: ${incident.jobName}`}
          description={`Queue: ${incident.queueName} | Job ID: ${incident.jobId}`}
          onRefresh={loadDetail}
          isRefreshing={acting}
        />

        <main className="p-8 space-y-6 flex-1 max-w-7xl">
          {/* Top Back & Action Bar */}
          <div className="flex items-center justify-between">
            <Link
              href="/incidents"
              className="inline-flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Incidents</span>
            </Link>

            {/* 1-Click Action Buttons */}
            <div className="flex items-center gap-3">
              {canApprove && (
                <>
                  <button
                    onClick={handleReject}
                    disabled={acting}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-rose-900/40 text-xs font-semibold text-rose-300 transition-colors disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>Quarantine (Reject)</span>
                  </button>

                  <button
                    onClick={handleApprove}
                    disabled={acting}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white shadow-lg shadow-emerald-950 transition-colors disabled:opacity-50"
                  >
                    <Check className="h-4 w-4" />
                    <span>Approve & Replay Now</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Incident Meta & AI Diagnosis Cards Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Meta Info */}
            <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Lifecycle State
                </span>
                <StatusBadge status={incident.status} />
              </div>

              <div className="pt-2 border-t border-slate-900 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Source Queue:</span>
                  <span className="font-mono text-slate-300">{incident.queueName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Original Job ID:</span>
                  <span className="font-mono text-slate-300">{incident.jobId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Retry Exhaustion:</span>
                  <span className="font-mono text-slate-300">
                    {incident.attemptsMade} / {incident.configuredAttempts}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Occurred At:</span>
                  <span className="text-slate-300 font-mono">
                    {new Date(incident.occurredAt).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* AI Diagnosis Details */}
            <div className="lg:col-span-2 rounded-xl border border-indigo-950/60 bg-indigo-950/10 p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-indigo-900/30">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-400" />
                    <span className="text-xs font-bold text-indigo-300 uppercase tracking-wider">
                      AI Doctor Diagnosis & Repair SOP
                    </span>
                  </div>
                  {incident.aiDiagnosis && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800/40">
                      Confidence: {(incident.aiDiagnosis.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>

                {incident.aiDiagnosis ? (
                  <div className="mt-3 space-y-2 text-xs">
                    <p className="text-slate-200 font-medium">
                      <span className="text-slate-400">Root Cause: </span>
                      {incident.aiDiagnosis.rootCause}
                    </p>
                    <p className="text-slate-300 leading-relaxed">
                      <span className="text-slate-400">Clinical Reasoning: </span>
                      {incident.aiDiagnosis.reasoning}
                    </p>
                    <div className="flex items-center gap-4 text-slate-400 pt-1">
                      <span>Prescribed: <strong className="text-cyan-400">{incident.aiDiagnosis.action}</strong></span>
                      {incident.aiDiagnosis.delaySeconds ? (
                        <span>Delay Backoff: <strong className="text-amber-400">{incident.aiDiagnosis.delaySeconds}s</strong></span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 mt-4">
                    No AI diagnosis proposal ready yet. Status: {incident.status}
                  </p>
                )}
              </div>

              {/* 5-Stage Sandbox Status Strip */}
              {incident.validationResult && (
                <div className="mt-4 pt-3 border-t border-indigo-900/30 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                    <Shield className="h-3.5 w-3.5 text-emerald-400" />
                    5-Stage Validation Gate:
                  </span>
                  <div className="flex items-center gap-1">
                    {incident.validationResult.stages.map((stage) => (
                      <span
                        key={stage.stage}
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                          stage.passed
                            ? "bg-emerald-950/60 border-emerald-800 text-emerald-300"
                            : "bg-rose-950/60 border-rose-800 text-rose-300"
                        }`}
                        title={stage.name}
                      >
                        S{stage.stage}: {stage.passed ? "PASS" : "FAIL"}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Matched SOP Runbook Card (RAG Retrieval) */}
          {incident.matchedRunbook && (
            <div className="rounded-xl border border-cyan-950/60 bg-cyan-950/10 p-5 space-y-2.5">
              <div className="flex items-center justify-between pb-2 border-b border-cyan-900/30">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-cyan-400" />
                  <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider">
                    RAG Matched SOP: {incident.matchedRunbook.title}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {incident.matchedRunbook.tags?.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800"
                    >
                      #{tag}
                    </span>
                  ))}
                  <Link
                    href="/runbooks"
                    className="text-[11px] text-cyan-400 hover:underline font-mono ml-2"
                  >
                    View Studio ➔
                  </Link>
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-900 text-xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto">
                {incident.matchedRunbook.content}
              </div>
            </div>
          )}

          {/* Side-by-Side Payload Diff View */}
          <div className="rounded-xl border border-slate-900 bg-slate-950/60 overflow-hidden">
            <div className="px-6 py-3.5 border-b border-slate-900 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-cyan-400" />
                <h3 className="text-sm font-semibold text-white">
                  Payload Mutation Inspector (Original vs AI Proposed)
                </h3>
              </div>
              <span className="text-[11px] text-slate-500 font-mono">
                Immutable Fields (orderId, userId, amount) Protected
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-900">
              {/* Original Payload */}
              <div className="p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider">
                    Original Failed Payload Snapshot
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    Immutable
                  </span>
                </div>
                <pre className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-80">
                  {JSON.stringify(incident.payloadSnapshot, null, 2)}
                </pre>
              </div>

              {/* Proposed Payload */}
              <div className="p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                    Repaired Payload (Validation Passed)
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    Target for Re-injection
                  </span>
                </div>
                <pre className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 text-xs font-mono text-slate-200 overflow-x-auto max-h-80">
                  {incident.proposedPayload
                    ? JSON.stringify(incident.proposedPayload, null, 2)
                    : "// No proposed payload generated (Proposal not yet formed)"}
                </pre>
              </div>
            </div>
          </div>

          {/* Recovery Attempts History */}
          <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-900 pb-3">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-purple-400" />
                <h3 className="text-sm font-semibold text-white">
                  Controlled Replay Execution History
                </h3>
              </div>
              <span className="text-xs text-slate-400 font-mono">
                {recoveries.length} Total Execution Attempts
              </span>
            </div>

            {recoveries.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                No recovery attempts executed for this incident yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400 border-b border-slate-900 pb-2">
                    <tr>
                      <th className="py-2">Status</th>
                      <th className="py-2">Replay Job ID</th>
                      <th className="py-2">Started At</th>
                      <th className="py-2">Completed At</th>
                      <th className="py-2">Outcome / Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/60">
                    {recoveries.map((rec) => (
                      <tr key={rec.id} className="font-mono">
                        <td className="py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              rec.status === "COMPLETED"
                                ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                                : rec.status === "FAILED"
                                ? "bg-rose-950 text-rose-300 border border-rose-800"
                                : "bg-purple-950 text-purple-300 border border-purple-800"
                            }`}
                          >
                            {rec.status}
                          </span>
                        </td>
                        <td className="py-2.5 text-slate-300 truncate max-w-[200px]">
                          {rec.replayJobId || "Pending Injection"}
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {new Date(rec.startedAt).toLocaleTimeString()}
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {rec.completedAt
                            ? new Date(rec.completedAt).toLocaleTimeString()
                            : "—"}
                        </td>
                        <td className="py-2.5 text-slate-300">
                          {rec.failureReason || "Replay in progress or succeeded"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
