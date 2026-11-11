"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Sidebar } from "../../components/Sidebar";
import { Header } from "../../components/Header";
import { api } from "../../lib/api";
import { Runbook } from "../../lib/types";
import { useSystemHealth } from "../../lib/use-health";

const RUNBOOKS_PAGE_SIZE = 20;

export default function RunbooksPage() {
  const { health } = useSystemHealth();
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedRunbook, setSelectedRunbook] = useState<Runbook | null>(null);
  const [searchInput, setSearchInput] = useState<string>("");
  const [tagInput, setTagInput] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [debouncedTag, setDebouncedTag] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalCount, setTotalCount] = useState<number>(0);

  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingRunbook, setEditingRunbook] = useState<Runbook | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Form State
  const [titleInput, setTitleInput] = useState("");
  const [contentInput, setContentInput] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const requestController = useRef<AbortController | null>(null);
  const lastAppliedFilters = useRef<{ search: string; tag: string }>({
    search: "",
    tag: "",
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      const filtersChanged =
        lastAppliedFilters.current.search !== searchInput ||
        lastAppliedFilters.current.tag !== tagInput;
      if (filtersChanged) {
        lastAppliedFilters.current = { search: searchInput, tag: tagInput };
        setPage(1);
      }
      setDebouncedSearch(searchInput);
      setDebouncedTag(tagInput);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput, tagInput]);

  const loadRunbooks = useCallback(
    async (preferredRunbook?: Runbook | string) => {
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;

      try {
        setLoading(true);
        const res = await api.getRunbooks({
          page,
          limit: RUNBOOKS_PAGE_SIZE,
          search: debouncedSearch || undefined,
          tag: debouncedTag || undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        const data = res.runbooks;
        setRunbooks(data);
        setTotalPages(res.pagination.totalPages);
        setTotalCount(res.pagination.total);

        if (res.pagination.totalPages > 0 && page > res.pagination.totalPages) {
          setPage(res.pagination.totalPages);
        }

        const preferredId =
          typeof preferredRunbook === "string"
            ? preferredRunbook
            : preferredRunbook?.id;
        const preferredObj =
          typeof preferredRunbook === "object" && preferredRunbook !== null
            ? preferredRunbook
            : null;

        setSelectedRunbook((current) => {
          const targetId = preferredId ?? current?.id;
          return (
            data.find((rb) => rb.id === targetId) ??
            preferredObj ??
            data[0] ??
            null
          );
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("Failed to load runbooks:", err);
          setFeedback({
            type: "error",
            message: "Failed to load runbooks from Engine.",
          });
        }
      } finally {
        if (requestController.current === controller) {
          requestController.current = null;
          setLoading(false);
        }
      }
    },
    [page, debouncedSearch, debouncedTag]
  );

  useEffect(() => {
    loadRunbooks();
    return () => requestController.current?.abort();
  }, [loadRunbooks]);

  const openCreateModal = () => {
    setEditingRunbook(null);
    setTitleInput("");
    setContentInput("");
    setTagsInput("");
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (runbook: Runbook) => {
    setEditingRunbook(runbook);
    setTitleInput(runbook.title);
    setContentInput(runbook.content);
    setTagsInput(runbook.tags.join(", "));
    setFormError(null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setIsModalOpen(false);
    setEditingRunbook(null);
    setFormError(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = titleInput.trim();
    const trimmedContent = contentInput.trim();
    if (!trimmedTitle || !trimmedContent) {
      setFormError("Title and remediation SOP content are required.");
      return;
    }

    try {
      setSaving(true);
      setFormError(null);
      const tagsArray = tagsInput
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      if (editingRunbook) {
        const contentChanged =
          trimmedTitle !== editingRunbook.title ||
          trimmedContent !== editingRunbook.content;

        const res = await api.updateRunbook(editingRunbook.id, {
          title: trimmedTitle,
          content: trimmedContent,
          tags: tagsArray,
        });

        setIsModalOpen(false);
        setEditingRunbook(null);
        await loadRunbooks(res.data);
        setFeedback({
          type: "success",
          message: contentChanged
            ? "Runbook updated and re-vectorized with 768-dim embeddings."
            : "Runbook tags updated cleanly.",
        });
      } else {
        const res = await api.createRunbook({
          title: trimmedTitle,
          content: trimmedContent,
          tags: tagsArray,
        });

        setIsModalOpen(false);
        setTitleInput("");
        setContentInput("");
        setTagsInput("");
        if (page !== 1) {
          setPage(1);
        }
        await loadRunbooks(res.data);
        setFeedback({
          type: "success",
          message: "Runbook created and vectorized with 768-dim embeddings.",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setFormError(`Failed to save runbook: ${msg}`);
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
      setFeedback({
        type: "success",
        message: `Deleted runbook "${title}".`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setFeedback({
        type: "error",
        message: `Delete failed: ${msg}`,
      });
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title="Runbook Knowledge Base & RAG Studio"
          description="Vectorized Standard Operating Procedures (SOPs) matched by pgvector cosine search"
          onRefresh={() => loadRunbooks()}
          isRefreshing={loading}
        />

        <main className="p-8 space-y-6 flex-1 max-w-7xl">
          {feedback && (
            <div
              className={`px-4 py-3 rounded-xl border text-xs flex items-center justify-between ${
                feedback.type === "success"
                  ? "bg-emerald-950/40 border-emerald-800/60 text-emerald-200"
                  : "bg-rose-950/40 border-rose-800/60 text-rose-200"
              }`}
            >
              <span>{feedback.message}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-slate-400 hover:text-white ml-4"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

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
              onClick={openCreateModal}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow-md transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Create SOP Runbook</span>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Runbooks List */}
            <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-4 space-y-3 flex flex-col">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Standard SOP Registry
                </h3>
                <span className="text-xs text-cyan-400 font-mono">
                  {totalCount} {totalCount === 1 ? "Doc" : "Docs"}
                </span>
              </div>

              {/* Search & Tag Filter */}
              <div className="space-y-2">
                <div className="relative">
                  <Search className="h-3.5 w-3.5 absolute left-3 top-2.5 text-slate-500" />
                  <input
                    type="text"
                    aria-label="Search runbooks"
                    placeholder="Search title or SOP text..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  {searchInput && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setSearchInput("")}
                      className="absolute right-2 top-2 text-slate-500 hover:text-slate-300"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Tag className="h-3.5 w-3.5 absolute left-3 top-2.5 text-slate-500" />
                    <input
                      type="text"
                      aria-label="Filter by tag"
                      placeholder="Filter by tag (e.g. twilio)..."
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                  {(searchInput || tagInput) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchInput("");
                        setTagInput("");
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-300"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-2 flex-1 max-h-[540px] overflow-y-auto pr-1">
                {!loading && runbooks.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    No runbooks match the active search or tag filter.
                  </div>
                ) : (
                  runbooks.map((rb) => {
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
                  })
                )}
              </div>

              {totalPages > 1 && (
                <div className="pt-3 border-t border-slate-900 flex items-center justify-between text-xs text-slate-400">
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1 || loading}
                      className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 hover:border-slate-700 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages || loading}
                      className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 hover:border-slate-700 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Runbook Markdown Viewer */}
            <div className="lg:col-span-2 rounded-xl border border-slate-900 bg-slate-950/60 p-6 flex flex-col justify-between">
              {selectedRunbook ? (
                <div className="space-y-4">
                  <div className="border-b border-slate-900 pb-4 flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-bold text-white">
                        {selectedRunbook.title}
                      </h2>
                      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-400 font-mono">
                        <span>ID: {selectedRunbook.id}</span>
                        <span>•</span>
                        <span>
                          Embed:{" "}
                          {selectedRunbook.embeddingProvider
                            ? `${selectedRunbook.embeddingProvider} / `
                            : ""}
                          {selectedRunbook.embeddingModel ||
                            health?.embeddingModel ||
                            "gemini-embedding-001"}{" "}
                          (768d)
                        </span>
                        <span>•</span>
                        <span>
                          Updated:{" "}
                          {new Date(selectedRunbook.updatedAt).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditModal(selectedRunbook)}
                        className="p-2 rounded-lg bg-slate-900 hover:bg-cyan-950/60 border border-slate-800 hover:border-cyan-800/60 text-slate-400 hover:text-cyan-300 transition-colors"
                        title="Edit Runbook"
                        aria-label="Edit Runbook"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(selectedRunbook.id, selectedRunbook.title)}
                        className="p-2 rounded-lg bg-slate-900 hover:bg-rose-950/60 border border-slate-800 hover:border-rose-900/60 text-slate-400 hover:text-rose-300 transition-colors"
                        title="Delete Runbook"
                        aria-label="Delete Runbook"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
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

      {/* Create / Edit Runbook Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                <h3 className="text-base font-bold text-white">
                  {editingRunbook
                    ? "Edit Troubleshooting SOP Runbook"
                    : "Add New Troubleshooting SOP Runbook"}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="text-slate-400 hover:text-white disabled:opacity-50"
                aria-label="Close modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError && (
              <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/70 text-xs text-rose-200">
                {formError}
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div>
                <label htmlFor="runbook-title" className="block text-slate-400 font-medium mb-1">
                  Runbook Title
                </label>
                <input
                  id="runbook-title"
                  type="text"
                  placeholder="e.g., Stripe API 429 Rate Limit Remediation"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
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
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
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
                  value={contentInput}
                  onChange={(e) => setContentInput(e.target.value)}
                  className="w-full p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[11px] text-slate-500">
                  {editingRunbook
                    ? "⚡ Re-embeds 768-dim vector when title or content changes"
                    : "⚡ Auto-embeds 768-dim vector into pgvector on save"}
                </span>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeModal}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold disabled:opacity-50"
                  >
                    {saving
                      ? editingRunbook
                        ? "Updating..."
                        : "Vectorizing..."
                      : editingRunbook
                      ? "Update Runbook"
                      : "Save Runbook"}
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
