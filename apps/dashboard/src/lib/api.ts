import { Incident, Runbook, SystemHealth, RecoveryAttempt } from "./types";

const ENGINE_BASE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL || "http://localhost:4000";

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
    let errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
    try {
      const errorBody = await res.json();
      errorMsg = errorBody.message || errorMsg;
    } catch {
      // ignore
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
    return fetchJSON(`/api/incidents${query ? `?${query}` : ""}`);
  },

  /**
   * Get single incident details
   */
  async getIncidentById(id: string): Promise<Incident> {
    return fetchJSON<Incident>(`/api/incidents/${id}`);
  },

  /**
   * Get recovery attempts history for an incident
   */
  async getIncidentRecoveries(id: string): Promise<{
    incidentId: string;
    totalAttempts: number;
    recoveries: RecoveryAttempt[];
  }> {
    return fetchJSON(`/api/incidents/${id}/recoveries`);
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
    return fetchJSON(`/api/incidents/${id}/approve`, {
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
    return fetchJSON(`/api/incidents/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  },

  /**
   * List all knowledge base Runbooks
   */
  async getRunbooks(): Promise<Runbook[]> {
    return fetchJSON<Runbook[]>("/api/runbooks");
  },

  /**
   * Get Circuit Breaker status
   */
  async getCircuitBreakerStatus(): Promise<{
    status: string;
    metrics: Record<string, any>;
  }> {
    return fetchJSON("/api/circuit-breaker");
  },
};
