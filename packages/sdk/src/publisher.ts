import { Queue } from "bullmq";
import { IncidentSnapshot } from "./types";

export class SmartDLQPublisher {
  private intakeQueue: Queue<IncidentSnapshot>;
  private shuttingDown = false;

  constructor(
    queueName: string = "dlq-healer-intake",
    connectionOrUrl?: any
  ) {
    const connection =
      !connectionOrUrl || typeof connectionOrUrl === "string"
        ? {
            url: connectionOrUrl || "redis://localhost:6379",
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          }
        : connectionOrUrl;

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

  /**
   * Publishes a captured terminal failure snapshot into the Smart DLQ intake queue.
   * Uses the idempotencyKey as the BullMQ jobId to prevent duplicate queued items.
   */
  async publish(snapshot: IncidentSnapshot): Promise<string> {
    try {
      const job = await this.intakeQueue.add("incident", snapshot, {
        jobId: snapshot.idempotencyKey,
      });
      return job.id || snapshot.idempotencyKey;
    } catch (err: any) {
      if (err.message?.includes("Job already exists") || err.message?.includes("duplicate")) {
        return snapshot.idempotencyKey;
      }
      throw err;
    }
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
