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

import { ReplayResultObserver } from "../src/workers/replay-result.worker";
import { handleHealerJob } from "../src/workers/healer.worker";
import { incidentService } from "../src/services/incident.service";
import { ragService } from "../src/services/rag.service";
import { triageService } from "../src/services/triage.service";
import { validationService } from "../src/services/validation.service";
import { circuitBreakerService } from "../src/services/circuit-breaker.service";
import { AppError } from "../src/middleware/error-handler";

describe("Phase 2 Regressions (B06, B07, B08, B09)", () => {
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
  });

  describe("B06: State machine conditional guards", () => {
    it("rejects RAG/Triage/Validation calls on terminal or active states with 409 INVALID_STATE_TRANSITION", async () => {
      mockPrisma.incident.findUnique.mockResolvedValue({
        id: "inc-resolved",
        status: "RESOLVED",
        matchedRunbookId: null,
        matchedRunbook: null,
        aiDiagnosis: {},
      });

      await expect(ragService.matchIncident("inc-resolved")).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_STATE_TRANSITION",
      });
      await expect(
        triageService.diagnoseIncident("inc-resolved")
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_STATE_TRANSITION",
      });
      await expect(
        validationService.validateProposal("inc-resolved")
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_STATE_TRANSITION",
      });

      expect(mockPrisma.incident.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("B07 & B08: Durable DB outcome retries & periodic reconciliation", () => {
    it("B08: retries transient DB errors during handleJobCompleted and commits RESOLVED", async () => {
      const observer = new ReplayResultObserver({
        dbRetryAttempts: 3,
        dbRetryBaseDelayMs: 5,
      });

      mockPrisma.recoveryAttempt.findFirst.mockResolvedValue({
        id: "attempt-retry-1",
        incidentId: "inc-b08-retry",
        replayJobId: "recovery-attempt-retry-1",
        status: "IN_PROGRESS",
        incident: { id: "inc-b08-retry", fingerprint: null },
      });

      let txAttempts = 0;
      mockPrisma.$transaction.mockImplementation(async (ops: any) => {
        txAttempts++;
        if (txAttempts <= 2) {
          throw new Error("ECONNREFUSED PostgreSQL temporarily unreachable");
        }
        return typeof ops === "function" ? ops(mockPrisma) : Promise.all(ops);
      });

      const ok = await observer.handleJobCompleted(
        "order-queue",
        "recovery-attempt-retry-1",
        { done: true }
      );

      expect(ok).toBe(true);
      expect(txAttempts).toBe(3);
      expect(mockPrisma.incident.updateMany).toHaveBeenCalledWith({
        where: { id: "inc-b08-retry", status: { in: ["REPLAYING"] } },
        data: { status: "RESOLVED" },
      });

      await observer.closeAll();
    });

    it("B08: reconciles stuck REPLAYING incident after DB outage ends", async () => {
      const observer = new ReplayResultObserver({
        dbRetryAttempts: 2,
        dbRetryBaseDelayMs: 5,
      });
      vi.spyOn(observer, "ensureQueueObserver").mockImplementation(
        () => ({ waitUntilReady: vi.fn().mockResolvedValue(undefined), close: vi.fn() } as any)
      );

      // Phase 1: DB down during initial completed event -> returns false without throwing
      mockPrisma.recoveryAttempt.findFirst.mockRejectedValueOnce(
        new Error("P1001 Can't reach database server")
      );
      mockPrisma.recoveryAttempt.findFirst.mockRejectedValueOnce(
        new Error("P1001 Can't reach database server")
      );

      const initialResult = await observer.handleJobCompleted(
        "order-queue",
        "recovery-attempt-outage"
      );
      expect(initialResult).toBe(false);

      // Phase 2: DB comes back and reconciler sweeps active REPLAYING rows
      mockPrisma.incident.findMany.mockResolvedValue([
        {
          id: "inc-outage-1",
          queueName: "order-queue",
          status: "REPLAYING",
          fingerprint: null,
          recoveryAttempts: [
            {
              id: "attempt-outage",
              replayJobId: "recovery-attempt-outage",
              status: "IN_PROGRESS",
            },
          ],
        },
      ]);

      mockPrisma.recoveryAttempt.findFirst.mockResolvedValue({
        id: "attempt-outage",
        incidentId: "inc-outage-1",
        replayJobId: "recovery-attempt-outage",
        status: "IN_PROGRESS",
        incident: { id: "inc-outage-1", fingerprint: null },
      });
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-reconcile" });

      (observer as any).inspectionQueues.set("order-queue", {
        getJob: vi.fn().mockResolvedValue({
          attemptsMade: 1,
          opts: { attempts: 3 },
          returnvalue: { recovered: true },
          getState: vi.fn().mockResolvedValue("completed"),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const scanned = await observer.reconcileOutstandingReplays();
      expect(scanned).toBe(1);
      expect(mockPrisma.incident.updateMany).toHaveBeenCalledWith({
        where: { id: "inc-outage-1", status: { in: ["REPLAYING"] } },
        data: { status: "RESOLVED" },
      });

      await observer.closeAll();
    });
  });

  describe("B09: Resumable intake checkpoints & transient retry propagation", () => {
    const baseSnapshot = {
      idempotencyKey: "order-queue:b09:3",
      source: "test-sdk",
      queueName: "order-queue",
      jobId: "b09",
      jobName: "process-order",
      payloadSnapshot: { orderId: "ORD-B09" },
      errorMessage: "Twilio Error 20429",
      attemptsMade: 3,
      configuredAttempts: 3,
      occurredAt: new Date().toISOString(),
    };

    it("resumes duplicate redelivery stuck in INGESTED and reaches AWAITING_APPROVAL", async () => {
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: true,
        incident: {
          id: "inc-b09-ingested",
          status: "INGESTED",
          fingerprint: null,
        } as any,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-b09-ingested" });
      const diagnoseSpy = vi
        .spyOn(triageService, "diagnoseIncident")
        .mockResolvedValue({
          incidentId: "inc-b09-ingested",
          status: "PROPOSAL_READY",
          proposal: {} as any,
          proposedPayload: { orderId: "ORD-B09" },
        });
      const validateSpy = vi
        .spyOn(validationService, "validateProposal")
        .mockResolvedValue({
          incidentId: "inc-b09-ingested",
          status: "AWAITING_APPROVAL",
          validation: {} as any,
        });

      const outcome = await handleHealerJob({
        id: "intake-resume-1",
        data: baseSnapshot,
        attemptsMade: 1,
        opts: { attempts: 3 },
      });

      expect(outcome.status).toBe("AWAITING_APPROVAL");
      expect(diagnoseSpy).toHaveBeenCalledWith("inc-b09-ingested", {
        resume: true,
        rethrowErrors: true,
      });
      expect(validateSpy).toHaveBeenCalledWith("inc-b09-ingested");
    });

    it("resumes duplicate redelivery from PROPOSAL_READY directly into validation without re-running triage", async () => {
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: true,
        incident: {
          id: "inc-b09-proposal",
          status: "PROPOSAL_READY",
          fingerprint: "fp-b09",
        } as any,
      });
      const diagnoseSpy = vi.spyOn(triageService, "diagnoseIncident");
      const validateSpy = vi
        .spyOn(validationService, "validateProposal")
        .mockResolvedValue({
          incidentId: "inc-b09-proposal",
          status: "AWAITING_APPROVAL",
          validation: {} as any,
        });

      const outcome = await handleHealerJob({
        id: "intake-resume-2",
        data: baseSnapshot,
        attemptsMade: 1,
        opts: { attempts: 3 },
      });

      expect(outcome.status).toBe("AWAITING_APPROVAL");
      expect(diagnoseSpy).not.toHaveBeenCalled();
      expect(validateSpy).toHaveBeenCalledWith("inc-b09-proposal");
    });

    it("skips duplicate redelivery when incident is already settled (AWAITING_APPROVAL / RESOLVED)", async () => {
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: true,
        incident: {
          id: "inc-b09-done",
          status: "AWAITING_APPROVAL",
          fingerprint: "fp-b09",
        } as any,
      });
      const diagnoseSpy = vi.spyOn(triageService, "diagnoseIncident");
      const validateSpy = vi.spyOn(validationService, "validateProposal");

      const outcome = await handleHealerJob({
        id: "intake-done",
        data: baseSnapshot,
      });

      expect(outcome).toEqual({
        incidentId: "inc-b09-done",
        isDuplicate: true,
        status: "AWAITING_APPROVAL",
      });
      expect(diagnoseSpy).not.toHaveBeenCalled();
      expect(validateSpy).not.toHaveBeenCalled();
    });

    it("rethrows transient upstream errors when intake retries remain without clobbering status to ANALYSIS_FAILED", async () => {
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: false,
        incident: {
          id: "inc-b09-transient",
          status: "INGESTED",
          fingerprint: null,
        } as any,
      });
      mockPrisma.incident.update.mockResolvedValue({ id: "inc-b09-transient" });
      vi.spyOn(triageService, "diagnoseIncident").mockRejectedValue(
        new Error("503 Gemini API temporarily unavailable")
      );

      await expect(
        handleHealerJob({
          id: "intake-retry-1",
          data: baseSnapshot,
          attemptsMade: 0,
          opts: { attempts: 3 },
        })
      ).rejects.toThrowError(/503 Gemini API temporarily unavailable/);

      expect(mockPrisma.incident.updateMany).not.toHaveBeenCalled();
    });

    it("does not overwrite RESOLVED/REPLAYING state on 409 state conflict inside handleHealerJob", async () => {
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: true,
        incident: {
          id: "inc-b09-conflict",
          status: "INGESTED",
          fingerprint: "fp-b09",
        } as any,
      });
      vi.spyOn(triageService, "diagnoseIncident").mockRejectedValue(
        new AppError("Conflict", 409, "INVALID_STATE_TRANSITION")
      );
      mockPrisma.incident.findUnique.mockResolvedValue({ status: "RESOLVED" });

      const outcome = await handleHealerJob({
        id: "intake-conflict",
        data: baseSnapshot,
        attemptsMade: 1,
        opts: { attempts: 3 },
      });

      expect(outcome.status).toBe("RESOLVED");
      expect(mockPrisma.incident.updateMany).not.toHaveBeenCalled();
    });
  });
});
