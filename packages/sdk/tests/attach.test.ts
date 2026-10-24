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
});
