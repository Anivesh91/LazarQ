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
  from: any;
  to: any;
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
  error?: string;
  details?: Record<string, any>;
}

export interface ValidationResult {
  passed: boolean;
  stages: ValidationStage[];
  failureReason?: string;
}

export interface Incident {
  id: string;
  sourceId: string;
  queueName: string;
  jobId: string;
  jobName: string;
  payloadSnapshot: Record<string, any>;
  expectedJsonSchema?: Record<string, any> | null;
  errorMessage: string;
  stackTrace?: string | null;
  attemptsMade: number;
  configuredAttempts: number;
  status: IncidentStatus;
  fingerprint?: string | null;
  matchedRunbookId?: string | null;
  aiDiagnosis?: AiDiagnosis | null;
  proposedPayload?: Record<string, any> | null;
  validationResult?: ValidationResult | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
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
  proposedPayload: Record<string, any>;
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
  timestamp: string;
}

export interface SSEEvent {
  type: string;
  data: any;
  timestamp: string;
}
