export interface IncidentLineage {
  lineageRootId?: string;
  parentIncidentId: string;
  replayDepth?: number;
}

export interface EncryptedReplayEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ct: string;
}

export interface IncidentSnapshot {
  idempotencyKey: string;
  source: string;
  queueName: string;
  jobId: string;
  jobName: string;
  payloadSnapshot: Record<string, any>;
  replayEnvelope?: EncryptedReplayEnvelope;
  expectedJsonSchema?: Record<string, any>;
  errorMessage: string;
  stackTrace?: string;
  attemptsMade: number;
  configuredAttempts: number;
  occurredAt: string;
  lineage?: IncidentLineage;
}

export interface DLQHealerConfig {
  /**
   * Redis connection URL (e.g. "redis://localhost:6379")
   */
  redisUrl?: string;

  /**
   * Existing ioredis instance or BullMQ connection options
   */
  redisConnection?: any;

  /**
   * Name of the dedicated Smart DLQ intake queue.
   * Default: "dlq-healer-intake"
   */
  intakeQueueName?: string;

  /**
   * Identifier for this application/SDK instance.
   * Default: "sdk-v1"
   */
  sourceId?: string;

  /**
   * Field names to redact from payload before transmission.
   * Merged with default sensitive keys (password, token, apiKey, secret, etc.)
   */
  redactFields?: string[];

  /**
   * Optional JSON Schema representing expected valid payload.
   */
  expectedJsonSchema?: Record<string, any>;

  /**
   * Optional 32-byte encryption key (64 hex chars, 32-byte base64, or >=32 char secret)
   * used to seal the unredacted execution payload with AES-256-GCM inside replayEnvelope.
   * Defaults to process.env.DLQ_PAYLOAD_ENCRYPTION_KEY when present.
   */
  payloadEncryptionKey?: string;

  /**
   * Optional Engine base URL for durable HTTP fallback ingestion if Redis publish fails.
   */
  fallbackHttpUrl?: string;

  /**
   * Optional Engine API key sent on x-api-key when falling back to HTTP ingestion.
   */
  engineApiKey?: string;

  /**
   * Maximum publish retry attempts before falling back/failing.
   * Default: 3
   */
  publishMaxAttempts?: number;

  /**
   * Optional callback invoked if terminal failure publication fails across all transports.
   */
  onPublishFailed?: (snapshot: IncidentSnapshot, error: unknown) => void | Promise<void>;

  /**
   * Whether to log SDK capture events.
   * Default: true
   */
  enableLogging?: boolean;

  /**
   * Whether to capture terminal failures of Engine-reinjected recovery jobs ("recovery-...").
   * Disabled by default to prevent duplicate incident creation on failed replays.
   * Default: false
   */
  captureReplayFailures?: boolean;
}
