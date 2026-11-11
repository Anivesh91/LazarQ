import {
  AuditLogEntry,
  Incident,
  RecoveryAttempt,
  Runbook,
  SystemHealth,
} from "./types";
import { formatEngineErrorMessage } from "./api-errors";

const ENGINE_BASE_URL = "/api/engine";

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${ENGINE_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    if (
      res.status === 401 &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/login"
    ) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }

    let errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
    try {
      const errorBody = (await res.json()) as unknown;
      errorMsg = formatEngineErrorMessage(res.status, res.statusText, errorBody);
    } catch {
      // ignore non-JSON error responses
    }
    throw new Error(errorMsg);
  }

  return res.json();
}

export const api = {
  /**
   * Health check status of Engine, Redis, and PostgreSQL
   */
  async getHealth(): Promise<SystemHealth> {
    return fetchJSON<SystemHealth>("/health");
  },

  /**
   * List incidents with optional status, queueName, and pagination
   */
  async getIncidents(params: {
    status?: string;
    queueName?: string;
    page?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<{
    incidents: Incident[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const searchParams = new URLSearchParams();
    if (params.status) searchParams.set("status", params.status);
    if (params.queueName) searchParams.set("queueName", params.queueName);
    if (params.page) searchParams.set("page", String(params.page));
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const result = await fetchJSON<{
      items?: Incident[];
      incidents?: Incident[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/incidents${query ? `?${query}` : ""}`, {
      signal: params.signal,
    });

    return {
      incidents: result.incidents || result.items || [],
      pagination: result.pagination || {
        page: 1,
        limit: 20,
        total: (result.incidents || result.items || []).length,
        totalPages: 1,
      },
    };
  },

  /**
   * Get single incident details
   */
  async getIncidentById(id: string): Promise<Incident> {
    return fetchJSON<Incident>(`/incidents/${encodeURIComponent(id)}`);
  },

  /**
   * Get recovery attempts history for an incident
   */
  async getIncidentRecoveries(id: string): Promise<{
    incidentId: string;
    totalAttempts: number;
    recoveries: RecoveryAttempt[];
  }> {
    return fetchJSON(`/incidents/${encodeURIComponent(id)}/recoveries`);
  },

  /**
   * Get chronological audit log events for an incident
   */
  async getIncidentHistory(id: string): Promise<{
    incidentId: string;
    totalEvents: number;
    history: AuditLogEntry[];
  }> {
    return fetchJSON(`/incidents/${encodeURIComponent(id)}/history`);
  },

  /**
   * Approve a proposed repair and trigger replay
   */
  async approveIncident(
    id: string,
    options: { approvedBy?: string; autoReplay?: boolean } = {}
  ): Promise<{
    success: boolean;
    incident: Incident;
    recoveryAttempt: RecoveryAttempt;
  }> {
    return fetchJSON(`/incidents/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  },

  /**
   * Reject a repair proposal and move to QUARANTINED
   */
  async rejectIncident(
    id: string,
    options: { rejectedBy?: string; reason?: string } = {}
  ): Promise<{
    success: boolean;
    incident: Incident;
  }> {
    return fetchJSON(`/incidents/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  },

  /**
   * List all knowledge base Runbooks
   */
  async getRunbooks(): Promise<Runbook[]> {
    const res = await fetchJSON<{ success: boolean; data: Runbook[] }>(
      "/runbooks?limit=100"
    );
    return res.data || [];
  },

  /**
   * Create a new Runbook (automatically triggers 768d Gemini vector embedding)
   */
  async createRunbook(data: {
    title: string;
    content: string;
    tags: string[];
  }): Promise<{ success: boolean; data: Runbook }> {
    return fetchJSON("/runbooks", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /**
   * Update an existing Runbook (re-embeds if title or content changes)
   */
  async updateRunbook(
    id: string,
    data: {
      title?: string;
      content?: string;
      tags?: string[];
    }
  ): Promise<{ success: boolean; data: Runbook }> {
    return fetchJSON(`/runbooks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  /**
   * Delete a Runbook by ID
   */
  async deleteRunbook(id: string): Promise<{ success: boolean; data: unknown }> {
    return fetchJSON(`/runbooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  /**
   * Fetch live unmanipulated operational metrics directly from PostgreSQL
   */
  async getMetrics(): Promise<{
    totalIncidents: number;
    statusCounts: Record<string, number>;
    resolutionRatePercent: number;
    quarantineRatePercent: number;
    runbookMatchRatePercent: number;
    avgResolutionTimeSeconds: number;
    totalRunbooks: number;
  }> {
    return fetchJSON("/metrics");
  },

  /**
   * Get Circuit Breaker status
   */
  async getCircuitBreakerStatus(): Promise<{
    success: boolean;
    totalBreakers: number;
    openBreakers: number;
    breakers: Array<{ state: "CLOSED" | "OPEN" | "HALF_OPEN" }>;
  }> {
    return fetchJSON("/circuit-breaker");
  },
};
