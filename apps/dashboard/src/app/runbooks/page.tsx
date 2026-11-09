"use client";

import React, { useEffect, useState } from "react";
import {
  Database,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Sidebar } from "../../components/Sidebar";
import { Header } from "../../components/Header";
import { api } from "../../lib/api";
import { Runbook } from "../../lib/types";

export default function RunbooksPage() {
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedRunbook, setSelectedRunbook] = useState<Runbook | null>(null);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);

  // Form State
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");

  const loadRunbooks = async () => {
    try {
      setLoading(true);
      const data = await api.getRunbooks();
      setRunbooks(data);
      setSelectedRunbook((current) =>
        data.find((runbook) => runbook.id === current?.id) ?? data[0] ?? null
      );
    } catch (err) {
      console.error("Failed to load runbooks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRunbooks();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      alert("Title and content are required");
      return;
    }

    try {
      setSaving(true);
      const tagsArray = newTags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      const res = await api.createRunbook({
        title: newTitle.trim(),
        content: newContent.trim(),
        tags: tagsArray,
      });

      alert("Runbook created and vectorized with Gemini 768-dim embeddings!");
      setIsCreating(false);
      setNewTitle("");
      setNewContent("");
      setNewTags("");

      await loadRunbooks();
      setSelectedRunbook(res.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to save runbook: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Are you sure you want to delete Runbook: "${title}"?`)) {
      return;
    }

    try {
      await api.deleteRunbook(id);
      setSelectedRunbook(null);
      await loadRunbooks();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Delete failed: ${msg}`);
    }
  };

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
          {/* Header Banner with Create Button */}
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

            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow-md transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Create SOP Runbook</span>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Runbooks List */}
            <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Standard SOP Registry
                </h3>
                <span className="text-xs text-cyan-400 font-mono">
                  {runbooks.length} Docs
                </span>
              </div>

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
                  <div className="border-b border-slate-900 pb-4 flex items-start justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">
                        {selectedRunbook.title}
                      </h2>
                      <div className="flex items-center gap-3 mt-2 text-xs text-slate-400 font-mono">
                        <span>ID: {selectedRunbook.id}</span>
                        <span>•</span>
                        <span>Embed: gemini-embedding-001 (768d)</span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(selectedRunbook.id, selectedRunbook.title)}
                      className="p-2 rounded-lg bg-slate-900 hover:bg-rose-950/60 border border-slate-800 hover:border-rose-900/60 text-slate-400 hover:text-rose-300 transition-colors"
                      title="Delete Runbook"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
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

      {/* Create Runbook Modal */}
      {isCreating && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                <h3 className="text-base font-bold text-white">
                  Add New Troubleshooting SOP Runbook
                </h3>
              </div>
              <button
                onClick={() => setIsCreating(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4 text-xs">
              <div>
                <label htmlFor="runbook-title" className="block text-slate-400 font-medium mb-1">
                  Runbook Title
                </label>
                <input
                  id="runbook-title"
                  type="text"
                  placeholder="e.g., Stripe API 429 Rate Limit Remediation"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label htmlFor="runbook-tags" className="block text-slate-400 font-medium mb-1">
                  Tags (comma separated)
                </label>
                <input
                  id="runbook-tags"
                  type="text"
                  placeholder="e.g., stripe, rate-limit, payment, transient"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label htmlFor="runbook-content" className="block text-slate-400 font-medium mb-1">
                  Remediation SOP Directives (Markdown)
                </label>
                <textarea
                  id="runbook-content"
                  rows={8}
                  placeholder={`### Diagnosis\nExplain what causes this failure...\n\n### Remediation Directive\nPrescribe RETRY with 60s delay or MUTATE_AND_RETRY...`}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  className="w-full p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[11px] text-slate-500">
                  ⚡ Auto-embeds 768-dim vector into pgvector on save
                </span>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold disabled:opacity-50"
                  >
                    {saving ? "Vectorizing..." : "Save Runbook"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
