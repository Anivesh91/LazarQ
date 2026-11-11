export type IncidentStatus =
  | "INGESTED"
  | "ANALYZING"
  | "RAG_MATCHED"
  | "PROPOSAL_READY"
  | "AWAITING_APPROVAL"
  | "REPLAY_QUEUED"
  | "REPLAYING"
  | "RESOLVED"
  | "QUARANTINED"
  | "SANDBOX_FAILED"
  | "REPLAY_FAILED"
  | "ANALYSIS_FAILED";

export type RecoveryStatus =
  | "PENDING"
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED";

export interface RepairMutation {
  field: string;
  from: unknown;
  to: unknown;
  reason?: string;
}

export interface AiDiagnosis {
  action: "RETRY" | "MUTATE_AND_RETRY" | "QUARANTINE";
  classification: "TRANSIENT" | "INVALID_PAYLOAD" | "DEPENDENCY_FAILURE" | "UNKNOWN";
  confidence: number;
  delaySeconds?: number;
  rootCause: string;
  reasoning: string;
  mutations?: RepairMutation[];
}

export interface ValidationStage {
  stage: number;
  name: string;
  passed: boolean;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  passed: boolean;
  failedStage?: number;
  rejectionReason?: string;
  stages: ValidationStage[];
  failureReason?: string;
}

export interface Incident {
  id: string;
  sourceId: string;
  queueName: string;
  jobId: string;
  jobName: string;
  payloadSnapshot: Record<string, unknown>;
  expectedJsonSchema?: Record<string, unknown> | null;
  errorMessage: string;
  stackTrace?: string | null;
  attemptsMade: number;
  configuredAttempts: number;
  status: IncidentStatus;
  fingerprint?: string | null;
  matchedRunbookId?: string | null;
  matchedRunbook?: {
    id: string;
    title: string;
    content: string;
    tags: string[];
  } | null;
  aiDiagnosis?: AiDiagnosis | null;
  proposedPayload?: Record<string, unknown> | null;
  validationResult?: ValidationResult | null;
  auditLogs?: AuditLogEntry[];
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  incidentId?: string | null;
  action: string;
  actor: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Runbook {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryAttempt {
  id: string;
  incidentId: string;
  proposedPayload: Record<string, unknown>;
  replayJobId?: string | null;
  status: RecoveryStatus;
  failureReason?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface SystemHealth {
  status: "ok" | "degraded";
  redis: string;
  database: string;
  llmProvider?: string;
  llmModel?: string;
  embeddingModel?: string;
  timestamp: string;
}

export interface SSEEventPayload {
  incidentId?: string;
  queueName?: string;
  status?: string;
  message?: string;
  incident?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SSEEvent {
  type: string;
  data: SSEEventPayload;
  timestamp: string;
}
