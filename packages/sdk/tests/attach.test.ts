import { describe, it, expect, vi } from "vitest";
import { attachDLQHealer } from "../src/attach";
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

    expect(snapshot.idempotencyKey).toBe("test-order-queue:102:3");
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

    mockWorker.emit("failed", replayJob, new Error("Replayed job failed"));
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
});
