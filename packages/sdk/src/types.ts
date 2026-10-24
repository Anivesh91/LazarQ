export interface IncidentSnapshot {
  idempotencyKey: string;
  source: string;
  queueName: string;
  jobId: string;
  jobName: string;
  payloadSnapshot: Record<string, any>;
  expectedJsonSchema?: Record<string, any>;
  errorMessage: string;
  stackTrace?: string;
  attemptsMade: number;
  configuredAttempts: number;
  occurredAt: string;
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
   * Whether to log SDK capture events.
   * Default: true
   */
  enableLogging?: boolean;
}
