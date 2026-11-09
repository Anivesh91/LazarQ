import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/redis", () => ({
  redis: {
    status: "ready",
    duplicate: vi.fn(),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
  },
}));

vi.mock("../src/db/prisma", () => ({
  prisma: {},
}));

import { LLMService } from "../src/services/llm.service";
import { ReplayResultObserver } from "../src/workers/replay-result.worker";

describe("Phase 1 Regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("LLMService channel fallback field detection", () => {
    it("mutates 'channel' when payloadSnapshot uses 'channel'", () => {
      const service = new LLMService("your-llm-api-key-here");
      const proposal = service.generateMockProposal({
        jobName: "process-order",
        queueName: "order-fulfillment-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded on SMS gateway",
        payloadSnapshot: {
          orderId: "ORD-101",
          userId: "USR-1",
          amount: 1499,
          channel: "SMS",
          customerEmail: "[REDACTED]",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
      });

      expect(proposal.action).toBe("MUTATE_AND_RETRY");
      expect(proposal.mutations).toHaveLength(1);
      expect(proposal.mutations[0]).toMatchObject({
        field: "channel",
        from: "SMS",
        to: "EMAIL",
      });
    });

    it("mutates 'notificationChannel' when payloadSnapshot uses 'notificationChannel'", () => {
      const service = new LLMService("your-llm-api-key-here");
      const proposal = service.generateMockProposal({
        jobName: "send-order-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-102",
          notificationChannel: "SMS",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
      });

      expect(proposal.action).toBe("MUTATE_AND_RETRY");
      expect(proposal.mutations).toHaveLength(1);
      expect(proposal.mutations[0]).toMatchObject({
        field: "notificationChannel",
        from: "SMS",
        to: "EMAIL",
      });
    });
  });

  describe("ReplayResultObserver retry exhaustion detection", () => {
    it("returns false for intermediate retry failures while attempts remain", async () => {
      const observer = new ReplayResultObserver();
      const mockQueue = {
        getJob: vi.fn().mockResolvedValue({
          attemptsMade: 1,
          opts: { attempts: 3 },
          getState: vi.fn().mockResolvedValue("delayed"),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      (observer as any).inspectionQueues.set("order-queue", mockQueue);

      const isTerminal = await observer.isTerminalFailure("order-queue", "recovery-1");
      expect(isTerminal).toBe(false);

      await observer.closeAll();
    });

    it("returns true once job reaches failed state or exhausts max attempts", async () => {
      const observer = new ReplayResultObserver();
      const mockQueue = {
        getJob: vi.fn().mockResolvedValue({
          attemptsMade: 3,
          opts: { attempts: 3 },
          getState: vi.fn().mockResolvedValue("failed"),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      (observer as any).inspectionQueues.set("order-queue", mockQueue);

      const isTerminal = await observer.isTerminalFailure("order-queue", "recovery-2");
      expect(isTerminal).toBe(true);

      await observer.closeAll();
    });

    it("returns true as a safe fallback if job cannot be found", async () => {
      const observer = new ReplayResultObserver();
      const mockQueue = {
        getJob: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockResolvedValue(undefined),
      };

      (observer as any).inspectionQueues.set("order-queue", mockQueue);

      const isTerminal = await observer.isTerminalFailure("order-queue", "missing-job");
      expect(isTerminal).toBe(true);

      await observer.closeAll();
    });
  });
});
