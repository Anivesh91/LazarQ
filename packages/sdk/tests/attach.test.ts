import { describe, it, expect, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { attachDLQHealer } from "../src/attach";
import { decryptReplayPayload } from "../src/crypto";
import { SmartDLQPublisher, toBullMQJobId } from "../src/publisher";
import { EventEmitter } from "events";

describe("SDK attachDLQHealer hook", () => {
  it("should NOT publish intermediate failure if attempts are not exhausted", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const healer = attachDLQHealer(mockWorker, {
      enableLogging: false,
    });

    const publishSpy = vi
      .spyOn(healer.publisher, "publish")
      .mockResolvedValue("key");

    const mockJob = {
      id: "101",
      name: "process-order",
      data: { orderId: "ORD_1" },
      attemptsMade: 1, // Only attempt 1
      opts: { attempts: 3 }, // Configured attempts 3
    };

    mockWorker.emit("failed", mockJob, new Error("Transient network error"));

    // Wait a tick for async handler
    await new Promise((r) => setTimeout(r, 20));

    expect(publishSpy).not.toHaveBeenCalled();

    healer.detach();
    await healer.publisher.close();
  });

  it("should publish snapshot when all retry attempts are exhausted (terminal failure)", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const healer = attachDLQHealer(mockWorker, {
      sourceId: "custom-sdk",
      enableLogging: false,
    });

    const publishSpy = vi
      .spyOn(healer.publisher, "publish")
      .mockResolvedValue("key");

    const mockJob = {
      id: "102",
      name: "process-order",
      data: { orderId: "ORD_2", password: "secret_value" },
      attemptsMade: 3, // Exhausted!
      opts: { attempts: 3 },
    };

    mockWorker.emit("failed", mockJob, new Error("Twilio Error 20429"));

    await new Promise((r) => setTimeout(r, 20));

    expect(publishSpy).toHaveBeenCalledOnce();
    const snapshot = publishSpy.mock.calls[0][0];

    expect(snapshot.idempotencyKey).toBe("custom-sdk:test-order-queue:102:3");
    expect(snapshot.source).toBe("custom-sdk");
    expect(snapshot.queueName).toBe("test-order-queue");
    expect(snapshot.jobId).toBe("102");
    expect(snapshot.errorMessage).toBe("Twilio Error 20429");
    expect(snapshot.attemptsMade).toBe(3);
    expect(snapshot.configuredAttempts).toBe(3);
    // Verified redaction worked in snapshot:
    expect(snapshot.payloadSnapshot.password).toBe("[REDACTED]");
    expect(snapshot.payloadSnapshot.orderId).toBe("ORD_2");

    healer.detach();
    await healer.publisher.close();
  });

  it("should close cleanly without throwing when closed before Redis connects", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-unreachable-queue";

    const healer = attachDLQHealer(mockWorker, {
      redisUrl: "redis://127.0.0.1:6399",
      enableLogging: false,
    });

    healer.detach();
    await healer.publisher.close();
  });

  it("should handle missing job.opts and non-Error throwables gracefully", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const healer = attachDLQHealer(mockWorker, {
      enableLogging: false,
    });

    const publishSpy = vi
      .spyOn(healer.publisher, "publish")
      .mockResolvedValue("key");

    const mockJob = {
      id: "103",
      name: "process-order",
      data: {
        orderId: "ORD_3",
        secretApiKey: "sk_live_abc123",
      },
      attemptsMade: 1,
      opts: undefined,
    };

    mockWorker.emit("failed", mockJob, "Plain string rejection");

    await new Promise((r) => setTimeout(r, 20));

    expect(publishSpy).toHaveBeenCalledOnce();
    const snapshot = publishSpy.mock.calls[0][0];
    expect(snapshot.configuredAttempts).toBe(1);
    expect(snapshot.errorMessage).toBe("Plain string rejection");
    expect(snapshot.stackTrace).toBeUndefined();
    expect(snapshot.payloadSnapshot.secretApiKey).toBe("[REDACTED]");

    await healer.close();
  });

  it("should skip capturing recovery replay jobs by default and allow opt-in via captureReplayFailures", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const defaultHealer = attachDLQHealer(mockWorker, {
      enableLogging: false,
    });
    const defaultPublishSpy = vi
      .spyOn(defaultHealer.publisher, "publish")
      .mockResolvedValue("key");

    const replayJob = {
      id: "recovery-123e4567-e89b-12d3-a456-426614174000-1700000000000",
      name: "process-order",
      data: { orderId: "ORD_4" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    const deterministicReplayJob = {
      id: "recovery-123e4567-e89b-12d3-a456-426614174000",
      name: "process-order",
      data: { orderId: "ORD_5" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    mockWorker.emit("failed", replayJob, new Error("Replayed job failed"));
    mockWorker.emit("failed", deterministicReplayJob, new Error("Deterministic replay failed"));
    await new Promise((r) => setTimeout(r, 20));

    expect(defaultPublishSpy).not.toHaveBeenCalled();
    await defaultHealer.close();

    const optInHealer = attachDLQHealer(mockWorker, {
      enableLogging: false,
      captureReplayFailures: true,
    });
    const optInPublishSpy = vi
      .spyOn(optInHealer.publisher, "publish")
      .mockResolvedValue("key");

    mockWorker.emit("failed", replayJob, new Error("Replayed job failed"));
    await new Promise((r) => setTimeout(r, 20));

    expect(optInPublishSpy).toHaveBeenCalledOnce();
    await optInHealer.close();
  });

  it("B05: skips jobs with dlqLineage by default and forwards lineage metadata when captureReplayFailures is true", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const dlqLineage = {
      lineageRootId: "root-inc-1",
      parentIncidentId: "parent-inc-2",
      replayDepth: 2,
    };

    const defaultHealer = attachDLQHealer(mockWorker, {
      enableLogging: false,
    });
    const defaultSpy = vi
      .spyOn(defaultHealer.publisher, "publish")
      .mockResolvedValue("key");

    mockWorker.emit(
      "failed",
      {
        id: "custom-replayed-job-id",
        name: "process-order",
        data: { orderId: "ORD_LINEAGE" },
        attemptsMade: 1,
        opts: { attempts: 1, dlqLineage },
      },
      new Error("Replay failed again")
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(defaultSpy).not.toHaveBeenCalled();
    await defaultHealer.close();

    const optInHealer = attachDLQHealer(mockWorker, {
      enableLogging: false,
      captureReplayFailures: true,
    });
    const optInSpy = vi
      .spyOn(optInHealer.publisher, "publish")
      .mockResolvedValue("key");

    mockWorker.emit(
      "failed",
      {
        id: "custom-replayed-job-id",
        name: "process-order",
        data: { orderId: "ORD_LINEAGE" },
        attemptsMade: 1,
        opts: { attempts: 1, dlqLineage },
      },
      new Error("Replay failed again")
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(optInSpy).toHaveBeenCalledOnce();
    expect(optInSpy.mock.calls[0][0].lineage).toEqual(dlqLineage);
    await optInHealer.close();
  });

  it("B11 & B12: redacts errorText & seals unredacted payload in AES-256-GCM replayEnvelope", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const healer = attachDLQHealer(mockWorker, {
      sourceId: "billing-svc",
      payloadEncryptionKey: key,
      enableLogging: false,
    });

    const publishSpy = vi
      .spyOn(healer.publisher, "publish")
      .mockResolvedValue("key");

    const originalData = {
      orderId: "ORD-ENC-1",
      channel: "SMS",
      customerEmail: "sarah@cyberdyne.org",
      secretApiKey: "sk_live_confidential_998877",
    };

    const err = new Error(
      "Gateway failed for sarah@cyberdyne.org using sk_live_confidential_998877 Bearer jwt_token_secret"
    );
    err.stack = `Error: Gateway failed for sarah@cyberdyne.org using sk_live_confidential_998877\n    at worker.ts:42`;

    mockWorker.emit(
      "failed",
      {
        id: "enc-1",
        name: "send-order",
        data: originalData,
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      err
    );

    await healer.flush();

    expect(publishSpy).toHaveBeenCalledOnce();
    const snapshot = publishSpy.mock.calls[0][0];

    expect(snapshot.payloadSnapshot.customerEmail).toBe("[REDACTED]");
    expect(snapshot.payloadSnapshot.secretApiKey).toBe("[REDACTED]");
    expect(snapshot.errorMessage).not.toContain("sarah@cyberdyne.org");
    expect(snapshot.errorMessage).not.toContain("sk_live_confidential_998877");
    expect(snapshot.errorMessage).toContain("Bearer [REDACTED]");
    expect(snapshot.stackTrace).not.toContain("sarah@cyberdyne.org");
    expect(snapshot.replayEnvelope).toBeDefined();

    const decrypted = decryptReplayPayload(snapshot.replayEnvelope, key);
    expect(decrypted).toEqual(originalData);

    await healer.close();
  });

  it("B13: captures early terminal failures on UnrecoverableError, discarded jobs, and finishedOn timestamps", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const healer = attachDLQHealer(mockWorker, {
      sourceId: "early-fail-app",
      enableLogging: false,
    });

    const publishSpy = vi
      .spyOn(healer.publisher, "publish")
      .mockResolvedValue("key");

    mockWorker.emit(
      "failed",
      {
        id: "early-1",
        name: "process-order",
        data: { orderId: "ORD-U1" },
        attemptsMade: 1,
        opts: { attempts: 5 },
      },
      new UnrecoverableError("Invalid customer schema")
    );

    mockWorker.emit(
      "failed",
      {
        id: "early-2",
        name: "process-order",
        data: { orderId: "ORD-D1" },
        attemptsMade: 1,
        discarded: true,
        opts: { attempts: 5 },
      },
      new Error("Job discarded manually")
    );

    mockWorker.emit(
      "failed",
      {
        id: "early-3",
        name: "process-order",
        data: { orderId: "ORD-F1" },
        attemptsMade: 2,
        finishedOn: Date.now(),
        opts: { attempts: 5 },
      },
      new Error("Backoff strategy aborted (-1)")
    );

    await healer.flush();

    expect(publishSpy).toHaveBeenCalledTimes(3);
    expect(publishSpy.mock.calls.map((c) => c[0].jobId)).toEqual([
      "early-1",
      "early-2",
      "early-3",
    ]);

    await healer.close();
  });

  it("B14: healer.close() waits for in-flight publish calls to finish before closing publisher", async () => {
    const mockWorker = new EventEmitter() as any;
    mockWorker.name = "test-order-queue";

    const healer = attachDLQHealer(mockWorker, {
      enableLogging: false,
    });

    const events: string[] = [];
    vi.spyOn(healer.publisher, "publish").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      events.push("publish-finished");
      return "done";
    });
    const originalClose = healer.publisher.close.bind(healer.publisher);
    vi.spyOn(healer.publisher, "close").mockImplementation(async () => {
      events.push("publisher-close");
      await originalClose();
    });

    mockWorker.emit(
      "failed",
      {
        id: "flush-1",
        name: "process-order",
        data: { orderId: "ORD-FLUSH" },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("Shutdown race test")
    );

    await healer.close();
    expect(events).toEqual(["publish-finished", "publisher-close"]);
  });

  it("B14 & B15: SmartDLQPublisher hashes 4-part idempotencyKey without colons, retries transient queue errors, and supports HTTP fallback & onPublishFailed", async () => {
    const key = "app-a:orders:job-1:3";
    const bullId = toBullMQJobId(key);
    expect(bullId).toMatch(/^dlq_[0-9a-f]{64}$/);
    expect(bullId).not.toContain(":");

    const publisher = new SmartDLQPublisher("dlq-healer-intake", "redis://127.0.0.1:6399", {
      publishMaxAttempts: 2,
      publishRetryDelayMs: 10,
      fallbackHttpUrl: "http://127.0.0.1:5999",
    });

    const addMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Redis connection hiccup"))
      .mockResolvedValueOnce({ id: bullId });
    (publisher as any).intakeQueue = {
      add: addMock,
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const snapshot = {
      idempotencyKey: key,
      source: "app-a",
      queueName: "orders",
      jobId: "job-1",
      jobName: "create",
      payloadSnapshot: { orderId: "ORD-1" },
      errorMessage: "Failed",
      attemptsMade: 3,
      configuredAttempts: 3,
      occurredAt: new Date().toISOString(),
    };

    const publishedId = await publisher.publish(snapshot);
    expect(publishedId).toBe(bullId);
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenLastCalledWith("incident", snapshot, { jobId: bullId });

    // Distinct sourceId produces distinct idempotencyKey & BullMQ jobId
    expect(toBullMQJobId("app-b:orders:job-1:3")).not.toBe(bullId);

    // HTTP fallback + onPublishFailed invocation when Redis consistently fails
    const onPublishFailed = vi.fn();
    const fallbackPublisher = new SmartDLQPublisher(
      "dlq-healer-intake",
      "redis://127.0.0.1:6399",
      {
        publishMaxAttempts: 1,
        fallbackHttpUrl: "http://127.0.0.1:5999",
        engineApiKey: "secret-key",
        onPublishFailed,
      }
    );
    (fallbackPublisher as any).intakeQueue = {
      add: vi.fn().mockRejectedValue(new Error("Redis down")),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ received: true, incidentId: "inc-http-fallback" }),
    }) as any;

    try {
      const httpId = await fallbackPublisher.publish(snapshot);
      expect(httpId).toBe("inc-http-fallback");
      expect(onPublishFailed).not.toHaveBeenCalled();

      // If HTTP fallback also fails, onPublishFailed fires and error propagates
      (global.fetch as any).mockRejectedValueOnce(new Error("Engine HTTP down"));
      await expect(fallbackPublisher.publish(snapshot)).rejects.toThrow(/Engine HTTP down/);
      expect(onPublishFailed).toHaveBeenCalledOnce();
    } finally {
      global.fetch = originalFetch;
      await publisher.close();
      await fallbackPublisher.close();
    }
  });
});
