import { createHash } from "crypto";
import { Queue } from "bullmq";
import { IncidentSnapshot } from "./types";

export interface SmartDLQPublisherOptions {
  publishMaxAttempts?: number;
  publishRetryDelayMs?: number;
  fallbackHttpUrl?: string;
  engineApiKey?: string;
  onPublishFailed?: (snapshot: IncidentSnapshot, error: unknown) => void | Promise<void>;
}

/**
 * Generates a BullMQ-safe deterministic jobId (free of colons & never purely numeric)
 * so BullMQ queue.add() deduplication never rejects 4-part namespaced idempotencyKeys.
 */
export function toBullMQJobId(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `dlq_${digest}`;
}

export class SmartDLQPublisher {
  private intakeQueue: Queue<IncidentSnapshot>;
  private shuttingDown = false;
  private readonly publishMaxAttempts: number;
  private readonly publishRetryDelayMs: number;
  private readonly fallbackHttpUrl?: string;
  private readonly engineApiKey?: string;
  private readonly onPublishFailed?: (
    snapshot: IncidentSnapshot,
    error: unknown
  ) => void | Promise<void>;

  constructor(
    queueName: string = "dlq-healer-intake",
    connectionOrUrl?: any,
    options: SmartDLQPublisherOptions = {}
  ) {
    const connection =
      !connectionOrUrl || typeof connectionOrUrl === "string"
        ? {
            url: connectionOrUrl || "redis://localhost:6379",
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          }
        : connectionOrUrl;

    this.publishMaxAttempts = Math.max(1, options.publishMaxAttempts ?? 3);
    this.publishRetryDelayMs = Math.max(10, options.publishRetryDelayMs ?? 100);
    this.fallbackHttpUrl = options.fallbackHttpUrl?.replace(/\/+$/, "");
    this.engineApiKey = options.engineApiKey;
    this.onPublishFailed = options.onPublishFailed;

    this.intakeQueue = new Queue<IncidentSnapshot>(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    this.intakeQueue.on("error", (err) => {
      if (!this.shuttingDown || !this.isExpectedShutdownError(err)) {
        console.error("[DLQ-Healer SDK] Intake queue error:", err);
      }
    });
  }

  private isExpectedShutdownError(error: Error): boolean {
    return /connection is (already )?closed|ECONNREFUSED|ENOTFOUND/i.test(
      error.message
    );
  }

  private async publishViaHttpFallback(snapshot: IncidentSnapshot): Promise<string> {
    if (!this.fallbackHttpUrl) {
      throw new Error("No HTTP fallback URL configured");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.engineApiKey) {
      headers["x-api-key"] = this.engineApiKey;
    }

    const res = await fetch(`${this.fallbackHttpUrl}/api/incidents/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(snapshot),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(
        `HTTP fallback ingestion failed (${res.status}): ${bodyText || res.statusText}`
      );
    }

    const data = (await res.json().catch(() => ({}))) as { incidentId?: string };
    return data.incidentId || snapshot.idempotencyKey;
  }

  /**
   * Publishes a captured terminal failure snapshot into the Smart DLQ intake queue
   * with bounded retries and optional HTTP fallback ingestion.
   */
  async publish(snapshot: IncidentSnapshot): Promise<string> {
    const bullMqJobId = toBullMQJobId(snapshot.idempotencyKey);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.publishMaxAttempts; attempt++) {
      try {
        const job = await this.intakeQueue.add("incident", snapshot, {
          jobId: bullMqJobId,
        });
        return job?.id || bullMqJobId;
      } catch (err: any) {
        if (
          err?.message?.includes("Job already exists") ||
          err?.message?.includes("duplicate")
        ) {
          return snapshot.idempotencyKey;
        }
        lastErr = err;
        if (attempt < this.publishMaxAttempts && !this.shuttingDown) {
          const delay = this.publishRetryDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (this.fallbackHttpUrl) {
      try {
        return await this.publishViaHttpFallback(snapshot);
      } catch (httpErr) {
        lastErr = httpErr;
      }
    }

    if (this.onPublishFailed) {
      try {
        await this.onPublishFailed(snapshot, lastErr);
      } catch {
        // Never allow error hook to mask original publish failure
      }
    }

    throw lastErr;
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    const internalConnection = (this.intakeQueue as unknown as {
      connection?: {
        initializing?: Promise<unknown>;
        on?: (event: string, listener: (err: Error) => void) => void;
        removeAllListeners?: () => void;
      };
    }).connection;

    // If BullMQ is still mid-handshake, let a healthy connection settle briefly
    // so Queue.close() can issue a clean QUIT rather than aborting in-flight init().
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.intakeQueue.waitUntilReady().catch(() => undefined),
      new Promise<void>((resolve) => {
        readyTimeout = setTimeout(resolve, 150);
        readyTimeout.unref?.();
      }),
    ]);
    if (readyTimeout) clearTimeout(readyTimeout);

    let closeError: unknown;
    try {
      await this.intakeQueue.close();
    } catch (err) {
      if (!(err instanceof Error) || !this.isExpectedShutdownError(err)) {
        closeError = err;
      }
    } finally {
      // BullMQ's RedisConnection.close() clears all event listeners before an
      // aborted init() rejects on the next tick and emits 'error' on itself.
      if (internalConnection?.on) {
        internalConnection.on("error", (err) => {
          if (!this.isExpectedShutdownError(err)) {
            console.error("[DLQ-Healer SDK] Redis shutdown error:", err);
          }
        });
      }
      if (internalConnection?.initializing) {
        let initTimeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          internalConnection.initializing.catch(() => undefined),
          new Promise<void>((resolve) => {
            initTimeout = setTimeout(resolve, 150);
            initTimeout.unref?.();
          }),
        ]);
        if (initTimeout) clearTimeout(initTimeout);
      }
      internalConnection?.removeAllListeners?.();
    }

    if (closeError) throw closeError;
  }
}
