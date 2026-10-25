"use client";

import React, { useEffect, useState } from "react";
import { BookOpen, Database, Sparkles, Tag, Terminal } from "lucide-react";
import { Sidebar } from "../../components/Sidebar";
import { Header } from "../../components/Header";
import { api } from "../../lib/api";
import { Runbook } from "../../lib/types";

export default function RunbooksPage() {
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedRunbook, setSelectedRunbook] = useState<Runbook | null>(null);

  const loadRunbooks = async () => {
    try {
      setLoading(true);
      const data = await api.getRunbooks();
      setRunbooks(data);
      if (data.length > 0) {
        setSelectedRunbook(data[0]);
      }
    } catch (err) {
      console.error("Failed to load runbooks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRunbooks();
  }, []);

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title="Runbook Knowledge Base & RAG Studio"
          description="Vectorized Standard Operating Procedures (SOPs) matched by pgvector cosine search"
          onRefresh={loadRunbooks}
          isRefreshing={loading}
        />

        <main className="p-8 space-y-6 flex-1 max-w-7xl">
          {/* Header Banner */}
          <div className="p-5 rounded-xl border border-cyan-950/60 bg-gradient-to-r from-cyan-950/30 to-indigo-950/30 flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider">
                  PostgreSQL pgvector Active (768 Dimensions)
                </span>
              </div>
              <p className="text-xs text-slate-300">
                Whenever a failure occurs, the error stack trace is embedded and compared against these SOPs via cosine distance.
              </p>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-cyan-950/60 border border-cyan-800 text-xs font-mono text-cyan-300">
              {runbooks.length} Active Runbooks
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Runbooks List */}
            <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-4 space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-2">
                Standard SOP Registry
              </h3>

              <div className="space-y-2">
                {runbooks.map((rb) => {
                  const isSelected = selectedRunbook?.id === rb.id;
                  return (
                    <button
                      key={rb.id}
                      onClick={() => setSelectedRunbook(rb)}
                      className={`w-full text-left p-3.5 rounded-lg border transition-all ${
                        isSelected
                          ? "bg-slate-900 border-cyan-800/80 shadow-sm"
                          : "bg-slate-900/30 border-slate-900 hover:border-slate-800"
                      }`}
                    >
                      <div className="text-sm font-semibold text-slate-200">
                        {rb.title}
                      </div>
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {rb.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Runbook Markdown Viewer */}
            <div className="lg:col-span-2 rounded-xl border border-slate-900 bg-slate-950/60 p-6 flex flex-col justify-between">
              {selectedRunbook ? (
                <div className="space-y-4">
                  <div className="border-b border-slate-900 pb-4">
                    <h2 className="text-lg font-bold text-white">
                      {selectedRunbook.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-400 font-mono">
                      <span>ID: {selectedRunbook.id}</span>
                      <span>•</span>
                      <span>Embed: gemini-embedding-001 (768d)</span>
                    </div>
                  </div>

                  {/* Content Preview */}
                  <div className="p-5 rounded-lg bg-slate-900/40 border border-slate-900 text-xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap max-h-[500px] overflow-y-auto">
                    {selectedRunbook.content}
                  </div>
                </div>
              ) : (
                <div className="py-20 text-center text-slate-500">
                  Select a runbook from the left to inspect its remediation instructions.
                </div>
              )}

              <div className="pt-4 border-t border-slate-900 text-xs text-slate-500 flex items-center justify-between">
                <span>Vector Dimension: 768</span>
                <span>Threshold: 0.60 Cosine Distance</span>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
