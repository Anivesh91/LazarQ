import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const client: any = {
    incident: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    recoveryAttempt: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (ops: any) =>
      typeof ops === "function" ? ops(client) : Promise.all(ops)
    ),
  };
  return { mockPrisma: client };
});

vi.mock("../src/config/redis", () => ({
  redis: {
    status: "ready",
    duplicate: vi.fn(),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
  },
}));

vi.mock("../src/db/prisma", () => ({
  prisma: mockPrisma,
}));

import { LLMService } from "../src/services/llm.service";
import { ReplayResultObserver } from "../src/workers/replay-result.worker";
import { applyMutation, triageService } from "../src/services/triage.service";
import { deterministicValidator } from "../src/sandbox/validator";
import { ragService } from "../src/services/rag.service";
import { circuitBreakerService } from "../src/services/circuit-breaker.service";
import { incidentService } from "../src/services/incident.service";
import { validationService } from "../src/services/validation.service";
import { handleHealerJob } from "../src/workers/healer.worker";
import { apiKeyAuth } from "../src/middleware/auth.middleware";

describe("Phase 1 Regressions", () => {
  const originalTestAuth = process.env.TEST_AUTH_ENABLED;
  const originalApiKey = process.env.ENGINE_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    circuitBreakerService.reset();
    mockPrisma.incident.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.recoveryAttempt.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.recoveryAttempt.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (ops: any) =>
      typeof ops === "function" ? ops(mockPrisma) : Promise.all(ops)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTestAuth === undefined) {
      delete process.env.TEST_AUTH_ENABLED;
    } else {
      process.env.TEST_AUTH_ENABLED = originalTestAuth;
    }
    if (originalApiKey === undefined) {
      delete process.env.ENGINE_API_KEY;
    } else {
      process.env.ENGINE_API_KEY = originalApiKey;
    }
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

    it("mutates 'notificationChannel' when payloadSnapshot uses 'notificationChannel' and email is present", () => {
      const service = new LLMService("your-llm-api-key-here");
      const proposal = service.generateMockProposal({
        jobName: "send-order-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-102",
          notificationChannel: "SMS",
          customerEmail: "[REDACTED]",
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

    it("B24: falls back to RETRY (no EMAIL mutation) when rate-limit job lacks recipient email", () => {
      const service = new LLMService("your-llm-api-key-here");
      const proposal = service.generateMockProposal({
        jobName: "send-order-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-NO-EMAIL",
          notificationChannel: "SMS",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
      });

      expect(proposal.action).toBe("RETRY");
      expect(proposal.mutations).toEqual([]);
      expect(proposal.delaySeconds).toBeGreaterThanOrEqual(60);
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

    it("re-attaches observers on startup and reconciles jobs completed during downtime", async () => {
      const observer = new ReplayResultObserver();
      const ensureSpy = vi
        .spyOn(observer, "ensureQueueObserver")
        .mockImplementation(() => ({ close: vi.fn() } as any));

      const fp = "fp-startup-reconcile";
      (circuitBreakerService as any).breakers.set(fp, {
        state: "HALF_OPEN",
        failureTimestamps: [Date.now()],
        trippedAt: Date.now() - 40_000,
        trialInFlight: true,
      });

      mockPrisma.incident.findMany.mockResolvedValue([
        {
          id: "inc-replay-1",
          queueName: "order-queue",
          status: "REPLAYING",
          fingerprint: fp,
          recoveryAttempts: [
            {
              id: "attempt-1",
              replayJobId: "recovery-attempt-1-1700000000000",
              status: "IN_PROGRESS",
            },
          ],
        },
      ]);

      mockPrisma.recoveryAttempt.findFirst.mockResolvedValue({
        id: "attempt-1",
        incidentId: "inc-replay-1",
        replayJobId: "recovery-attempt-1-1700000000000",
        status: "IN_PROGRESS",
        incident: { id: "inc-replay-1", fingerprint: fp },
      });
      mockPrisma.recoveryAttempt.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.incident.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });

      const mockQueue = {
        getJob: vi.fn().mockResolvedValue({
          attemptsMade: 1,
          opts: { attempts: 3 },
          returnvalue: { ok: true },
          getState: vi.fn().mockResolvedValue("completed"),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (observer as any).inspectionQueues.set("order-queue", mockQueue);

      const count = await observer.recoverActiveReplayObservers();

      expect(count).toBe(1);
      expect(ensureSpy).toHaveBeenCalledWith("order-queue");
      expect(mockPrisma.incident.updateMany).toHaveBeenCalledWith({
        where: { id: "inc-replay-1", status: { in: ["REPLAYING"] } },
        data: { status: "RESOLVED" },
      });
      expect(circuitBreakerService.canProcess(fp).state).toBe("CLOSED");

      await observer.closeAll();
    });
  });

  describe("Mutation Safety & Prototype Pollution Guard", () => {
    it("rejects __proto__, constructor, and prototype mutation paths", () => {
      const payload: Record<string, any> = { orderId: "ORD-1", channel: "SMS" };

      expect(() =>
        applyMutation(payload, "__proto__.polluted", true)
      ).toThrowError(/Unsafe mutation field path rejected/);
      expect(() =>
        applyMutation(payload, "constructor.prototype.polluted", true)
      ).toThrowError(/Unsafe mutation field path rejected/);
      expect(() =>
        applyMutation(payload, "nested..bad", true)
      ).toThrowError(/Unsafe mutation field path rejected/);

      expect(({} as any).polluted).toBeUndefined();

      applyMutation(payload, "meta.channel", "EMAIL");
      expect(payload.meta.channel).toBe("EMAIL");
    });

    it("B04: blocks metadata.__proto__, nested __proto__ own-keys in values, array mutation traversal, and validator bypass", () => {
      const payload: Record<string, any> = {
        orderId: "ORD-1",
        items: [{ sku: "A1" }],
      };

      expect(() =>
        applyMutation(payload, "metadata.__proto__.someFlag", true)
      ).toThrowError(/Unsafe mutation field path rejected/);

      expect(() =>
        applyMutation(payload, "metadata.constructor", { polluted: true })
      ).toThrowError(/Unsafe mutation field path rejected/);

      expect(() =>
        applyMutation(payload, "metadata. prototype", true)
      ).toThrowError(/Unsafe mutation field path rejected/);

      expect(() =>
        applyMutation(payload, "items.push", "bad")
      ).toThrowError(/Unsafe mutation field path rejected/);

      const poisonedTo = JSON.parse('{"__proto__":{"pollutedFromTo":true}}');
      expect(() =>
        applyMutation(payload, "metadata", poisonedTo)
      ).toThrowError(/Unsafe mutation key rejected/);

      expect(({} as any).someFlag).toBeUndefined();
      expect(({} as any).pollutedFromTo).toBeUndefined();

      // Validator Stage 3 must block unsafe mutation paths even before Stage 5 runs
      const stage3Rejected = deterministicValidator.validate({
        incident: {
          id: "inc-b04-s3",
          queueName: "order-queue",
          status: "PROPOSAL_READY",
          attemptsMade: 3,
          configuredAttempts: 3,
          payloadSnapshot: { orderId: "ORD-1" },
        },
        proposal: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.9,
          delaySeconds: 0,
          mutations: [
            { field: "metadata.__proto__.someFlag", from: undefined, to: true },
          ],
          rootCause: "Attack",
          reasoning: "Bypass",
        },
        proposedPayload: { orderId: "ORD-1", metadata: {} },
      });

      expect(stage3Rejected.passed).toBe(false);
      expect(stage3Rejected.failedStage).toBe(3);

      // Validator Stage 5 must block own-key constructor/prototype/__proto__ inside pre-stored proposedPayload
      const stage5Rejected = deterministicValidator.validate({
        incident: {
          id: "inc-b04-s5",
          queueName: "order-queue",
          status: "PROPOSAL_READY",
          attemptsMade: 3,
          configuredAttempts: 3,
          payloadSnapshot: { orderId: "ORD-1" },
        },
        proposal: {
          classification: "TRANSIENT",
          action: "RETRY",
          confidence: 0.9,
          delaySeconds: 0,
          mutations: [],
          rootCause: "Pre-stored object",
          reasoning: "Check own keys",
        },
        proposedPayload: JSON.parse('{"orderId":"ORD-1","metadata":{"constructor":{"pwn":true}}}'),
      });

      expect(stage5Rejected.passed).toBe(false);
      expect(stage5Rejected.failedStage).toBe(5);
    });
  });

  describe("RAG & Triage ANALYSIS_FAILED Transitions", () => {
    it("transitions incident to ANALYSIS_FAILED if RAG embedding lookup throws", async () => {
      mockPrisma.incident.findUnique.mockResolvedValue({
        id: "inc-rag-fail",
        status: "INGESTED",
        errorMessage: "Twilio Error 20429",
        stackTrace: null,
        jobName: "process-order",
        matchedRunbookId: null,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-rag-fail" });
      mockPrisma.auditLog.create.mockResolvedValue({ id: "log-1" });

      vi.spyOn(ragService, "findMatchingRunbooks").mockRejectedValue(
        new Error("Gemini embedding API 503 unavailable")
      );

      await expect(ragService.matchIncident("inc-rag-fail")).rejects.toThrowError(
        /Gemini embedding API 503 unavailable/
      );

      expect(mockPrisma.incident.updateMany).toHaveBeenLastCalledWith({
        where: { id: "inc-rag-fail", status: { in: ["ANALYZING"] } },
        data: { status: "ANALYSIS_FAILED" },
      });
    });

    it("returns ANALYSIS_FAILED cleanly from diagnoseIncident without duplicating RAG audit logs", async () => {
      mockPrisma.incident.findUnique
        .mockResolvedValueOnce({
          id: "inc-triage-rag-fail",
          status: "INGESTED",
          matchedRunbookId: null,
          matchedRunbook: null,
        })
        .mockResolvedValueOnce({
          status: "ANALYSIS_FAILED",
        });

      vi.spyOn(ragService, "matchIncident").mockRejectedValue(
        new Error("Vector query timeout")
      );

      const result = await triageService.diagnoseIncident("inc-triage-rag-fail");

      expect(result.status).toBe("ANALYSIS_FAILED");
      expect(result.proposal).toBeNull();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("Circuit Breaker HALF_OPEN Recovery in Healer Worker", () => {
    const sampleSnapshot = {
      idempotencyKey: "order-queue:job-cb:3",
      source: "test-sdk",
      queueName: "order-queue",
      jobId: "job-cb",
      jobName: "process-order",
      payloadSnapshot: { orderId: "ORD-CB" },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
      occurredAt: new Date().toISOString(),
    };

    it("resets HALF_OPEN breaker to CLOSED when trial triage and validation succeed", async () => {
      const fp = circuitBreakerService.getFingerprint(
        sampleSnapshot.queueName,
        sampleSnapshot.errorMessage
      );
      (circuitBreakerService as any).breakers.set(fp, {
        state: "OPEN",
        failureTimestamps: [Date.now() - 40_000],
        trippedAt: Date.now() - 40_000,
        trialInFlight: false,
      });

      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: false,
        incident: { id: "inc-cb-pass", status: "INGESTED" } as any,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-cb-pass" });
      vi.spyOn(triageService, "diagnoseIncident").mockResolvedValue({
        incidentId: "inc-cb-pass",
        status: "PROPOSAL_READY",
        proposal: {} as any,
        proposedPayload: { orderId: "ORD-CB" },
      });
      vi.spyOn(validationService, "validateProposal").mockResolvedValue({
        incidentId: "inc-cb-pass",
        status: "AWAITING_APPROVAL",
        validation: {} as any,
      });

      const outcome = await handleHealerJob({ id: "intake-1", data: sampleSnapshot });

      expect(outcome.status).toBe("AWAITING_APPROVAL");
      expect(circuitBreakerService.canProcess(fp)).toEqual({
        allowed: true,
        state: "CLOSED",
      });
    });

    it("re-trips HALF_OPEN breaker back to OPEN when trial triage returns ANALYSIS_FAILED", async () => {
      const fp = circuitBreakerService.getFingerprint(
        sampleSnapshot.queueName,
        sampleSnapshot.errorMessage
      );
      (circuitBreakerService as any).breakers.set(fp, {
        state: "OPEN",
        failureTimestamps: [Date.now() - 40_000],
        trippedAt: Date.now() - 40_000,
        trialInFlight: false,
      });

      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: false,
        incident: { id: "inc-cb-fail", status: "INGESTED" } as any,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-cb-fail" });
      vi.spyOn(triageService, "diagnoseIncident").mockResolvedValue({
        incidentId: "inc-cb-fail",
        status: "ANALYSIS_FAILED",
        proposal: null,
        proposedPayload: null,
      });

      const outcome = await handleHealerJob({ id: "intake-2", data: sampleSnapshot });

      expect(outcome.status).toBe("ANALYSIS_FAILED");
      expect(circuitBreakerService.canProcess(fp).state).toBe("OPEN");
    });

    it("marks incident ANALYSIS_FAILED and re-trips HALF_OPEN if validation throws unexpectedly", async () => {
      const fp = circuitBreakerService.getFingerprint(
        sampleSnapshot.queueName,
        sampleSnapshot.errorMessage
      );
      (circuitBreakerService as any).breakers.set(fp, {
        state: "OPEN",
        failureTimestamps: [Date.now() - 40_000],
        trippedAt: Date.now() - 40_000,
        trialInFlight: false,
      });

      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: false,
        incident: { id: "inc-cb-throw", status: "INGESTED" } as any,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-cb-throw" });
      mockPrisma.incident.findUnique.mockResolvedValue({ status: "PROPOSAL_READY" });
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-cb-throw" });
      vi.spyOn(triageService, "diagnoseIncident").mockResolvedValue({
        incidentId: "inc-cb-throw",
        status: "PROPOSAL_READY",
        proposal: {} as any,
        proposedPayload: { orderId: "ORD-CB" },
      });
      vi.spyOn(validationService, "validateProposal").mockRejectedValue(
        new Error("Unexpected validator failure")
      );

      const outcome = await handleHealerJob({ id: "intake-3", data: sampleSnapshot });

      expect(outcome.status).toBe("ANALYSIS_FAILED");
      expect(circuitBreakerService.canProcess(fp).state).toBe("OPEN");
      expect(mockPrisma.incident.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "inc-cb-throw",
          status: {
            in: ["INGESTED", "ANALYZING", "RAG_MATCHED", "PROPOSAL_READY"],
          },
        },
        data: { status: "ANALYSIS_FAILED" },
      });
    });
  });

  describe("apiKeyAuth constant-time header validation", () => {
    it("accepts valid scalar/array x-api-key and Bearer tokens and rejects mismatches", () => {
      process.env.TEST_AUTH_ENABLED = "1";
      process.env.ENGINE_API_KEY = "super_secret_engine_key";
      const next = vi.fn();

      apiKeyAuth(
        { path: "/api/incidents", headers: { "x-api-key": "super_secret_engine_key" } } as any,
        {} as any,
        next
      );
      expect(next).toHaveBeenCalledTimes(1);

      apiKeyAuth(
        {
          path: "/api/incidents",
          headers: { "x-api-key": ["super_secret_engine_key", "ignored"] },
        } as any,
        {} as any,
        next
      );
      expect(next).toHaveBeenCalledTimes(2);

      apiKeyAuth(
        {
          path: "/api/incidents",
          headers: { authorization: "Bearer super_secret_engine_key" },
        } as any,
        {} as any,
        next
      );
      expect(next).toHaveBeenCalledTimes(3);

      expect(() =>
        apiKeyAuth(
          { path: "/api/incidents", headers: { "x-api-key": "wrong" } } as any,
          {} as any,
          next
        )
      ).toThrowError(/Unauthorized/);

      expect(() =>
        apiKeyAuth(
          { path: "/api/incidents", headers: {} } as any,
          {} as any,
          next
        )
      ).toThrowError(/Unauthorized/);

      apiKeyAuth(
        { path: "/health", headers: {} } as any,
        {} as any,
        next
      );
      expect(next).toHaveBeenCalledTimes(4);
    });
  });
});
