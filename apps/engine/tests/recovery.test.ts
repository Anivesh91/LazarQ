import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import { Queue } from "bullmq";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/config/redis";
import { incidentService } from "../src/services/incident.service";
import { validationService } from "../src/services/validation.service";
import { replayService } from "../src/services/replay.service";
import { queueReinjector } from "../src/replay/reinjector";
import { replayResultObserver } from "../src/workers/replay-result.worker";

describe("Day 11: Dynamic Queue Re-injector & Outcome Tracker", () => {
  const createdIncidentIds: string[] = [];

  afterAll(async () => {
    if (createdIncidentIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { incidentId: { in: createdIncidentIds } },
      });
      await prisma.recoveryAttempt.deleteMany({
        where: { incidentId: { in: createdIncidentIds } },
      });
      await prisma.incident.deleteMany({
        where: { id: { in: createdIncidentIds } },
      });
    }
    await replayResultObserver.closeAll();
    await queueReinjector.closeAll();
    await prisma.$disconnect();
  });

  // Helper to create an incident ready for approval
  async function createAwaitingApprovalIncident(overrides: Partial<any> = {}) {
    const ts = Date.now() + Math.floor(Math.random() * 100000);
    const originalPayload = {
      orderId: `ORD-${ts}`,
      userId: "usr_99",
      amount: 4999,
      currency: "INR",
      notificationChannel: "SMS",
      ...overrides.originalPayload,
    };

    const proposedPayload = {
      ...originalPayload,
      notificationChannel: "EMAIL",
      ...overrides.proposedPayload,
    };

    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `recovery:test:${ts}`,
      source: "recovery-test",
      queueName: overrides.queueName || "notifications-queue",
      jobId: `job-${ts}`,
      jobName: overrides.jobName || "send-notification",
      payloadSnapshot: originalPayload,
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
    });

    createdIncidentIds.push(ingest.incident.id);

    const updated = await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        status: overrides.status || "AWAITING_APPROVAL",
        aiDiagnosis: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.95,
          delaySeconds: 1,
          mutations: [
            { field: "notificationChannel", from: "SMS", to: "EMAIL" },
          ],
          rootCause: "Rate limit exceeded",
          reasoning: "Switched to email fallback",
        },
        proposedPayload: proposedPayload,
        validationResult: {
          passed: true,
          stages: [
            { stage: 1, name: "Schema Validation", passed: true },
            { stage: 2, name: "Invariant Check", passed: true },
            { stage: 3, name: "Allowed Mutations", passed: true },
            { stage: 4, name: "Replay Guard", passed: true },
            { stage: 5, name: "Dry-Run Boundary", passed: true },
          ],
        },
      },
    });

    return updated;
  }

  describe("QueueReinjector Unit Behavior", () => {
    it("should throw an error when attempting to re-inject into an internal system queue", async () => {
      expect(() => {
        queueReinjector.validateQueueName("dlq-healer-intake");
      }).toThrowError(/Cannot re-inject jobs into internal system queue/);
    });

    it("should throw an error on empty or invalid queue names", async () => {
      expect(() => {
        queueReinjector.validateQueueName("");
      }).toThrowError(/Invalid queue name/);

      expect(() => {
        queueReinjector.validateQueueName("queue with spaces!");
      }).toThrowError(/contains invalid characters/);
    });

    it("should successfully re-inject a valid payload into target BullMQ queue", async () => {
      const result = await queueReinjector.reinjectJob(
        "test-recovery-queue",
        "test-job",
        { test: true, replayedAt: new Date().toISOString() },
        { delayMs: 100 }
      );

      expect(result.jobId).toBeDefined();
      expect(result.queueName).toBe("test-recovery-queue");
      expect(result.jobName).toBe("test-job");
    });
  });

  describe("Replay Service Approval & Execution Flow", () => {
    it("should reject approval if incident does not exist", async () => {
      await expect(
        replayService.approveIncident("00000000-0000-0000-0000-000000000000")
      ).rejects.toThrowError(/Incident not found/);
    });

    it("should reject approval if incident is not in AWAITING_APPROVAL status", async () => {
      const incident = await createAwaitingApprovalIncident({ status: "INGESTED" });
      await expect(
        replayService.approveIncident(incident.id)
      ).rejects.toThrowError(/Incident cannot be approved in current status/);
    });

    it("should reject approval if safety invariant is violated in proposedPayload", async () => {
      // Modify proposedPayload to tamper with immutable amount
      const incident = await createAwaitingApprovalIncident({
        proposedPayload: { amount: 100 }, // Changed from 4999!
      });

      await expect(
        replayService.approveIncident(incident.id)
      ).rejects.toThrowError(/Approval rejected by safety invariant guard/);
    });

    it("should approve incident without autoReplay and transition to REPLAY_QUEUED", async () => {
      const incident = await createAwaitingApprovalIncident();

      const result = await replayService.approveIncident(incident.id, {
        approvedBy: "qa-engineer",
        autoReplay: false,
      });

      expect(result.incident.status).toBe("REPLAY_QUEUED");
      expect(result.recoveryAttempt).toBeDefined();
      expect(result.recoveryAttempt.status).toBe("QUEUED");
      expect(result.recoveryAttempt.incidentId).toBe(incident.id);

      // Verify AuditLog
      const audit = await prisma.auditLog.findFirst({
        where: { incidentId: incident.id, action: "RECOVERY_APPROVED" },
      });
      expect(audit).toBeDefined();
      expect(audit?.actor).toBe("qa-engineer");
    });

    it("should approve with autoReplay (default) and immediately transition to REPLAYING", async () => {
      const incident = await createAwaitingApprovalIncident();

      const result = await replayService.approveIncident(incident.id, {
        approvedBy: "lead-dev",
        autoReplay: true,
      });

      expect(result.incident.status).toBe("REPLAYING");
      expect(result.recoveryAttempt.status).toBe("IN_PROGRESS");
      expect(result.recoveryAttempt.replayJobId).toMatch(/^recovery-/);

      // Verify original payload snapshot remained completely intact (immutable preservation)
      const freshIncident = await prisma.incident.findUnique({
        where: { id: incident.id },
      });
      expect((freshIncident?.payloadSnapshot as any).notificationChannel).toBe("SMS");
      expect((freshIncident?.proposedPayload as any).notificationChannel).toBe("EMAIL");
    });

    it("should prevent duplicate approve/replay on an incident that is already REPLAYING or RESOLVED (409 Conflict)", async () => {
      const incident = await createAwaitingApprovalIncident();

      // First approval triggers replay
      await replayService.approveIncident(incident.id, { autoReplay: true });

      // Second approval attempt should be rejected with 409 conflict
      await expect(
        replayService.approveIncident(incident.id)
      ).rejects.toThrowError(/currently replaying/);
    });

    it("should allow rejecting a proposed repair and transition to QUARANTINED", async () => {
      const incident = await createAwaitingApprovalIncident();

      const result = await replayService.rejectIncident(incident.id, {
        rejectedBy: "security-reviewer",
        reason: "Manual inspection required due to high value order",
      });

      expect(result.incident.status).toBe("QUARANTINED");

      const audit = await prisma.auditLog.findFirst({
        where: { incidentId: incident.id, action: "RECOVERY_REJECTED" },
      });
      expect(audit).toBeDefined();
      expect(audit?.actor).toBe("security-reviewer");
      expect((audit?.details as any).reason).toContain("Manual inspection");
    });
  });

  describe("Replay Result Observer (Outcome Tracker)", () => {
    it("should mark incident RESOLVED and attempt COMPLETED on replayed job success", async () => {
      const incident = await createAwaitingApprovalIncident();
      const replay = await replayService.approveIncident(incident.id, { autoReplay: true });
      const replayJobId = replay.recoveryAttempt.replayJobId!;

      // Simulate completed event
      const processed = await replayResultObserver.handleJobCompleted(
        incident.queueName,
        replayJobId,
        { success: true, deliveredAt: new Date().toISOString() }
      );

      expect(processed).toBe(true);

      const resolvedIncident = await prisma.incident.findUnique({
        where: { id: incident.id },
      });
      expect(resolvedIncident?.status).toBe("RESOLVED");

      const completedAttempt = await prisma.recoveryAttempt.findUnique({
        where: { id: replay.recoveryAttempt.id },
      });
      expect(completedAttempt?.status).toBe("COMPLETED");
      expect(completedAttempt?.completedAt).toBeDefined();

      const audit = await prisma.auditLog.findFirst({
        where: { incidentId: incident.id, action: "RECOVERY_RESOLVED" },
      });
      expect(audit).toBeDefined();
    });

    it("should mark incident REPLAY_FAILED and attempt FAILED on replayed job failure", async () => {
      const incident = await createAwaitingApprovalIncident();
      const replay = await replayService.approveIncident(incident.id, { autoReplay: true });
      const replayJobId = replay.recoveryAttempt.replayJobId!;

      // Simulate failed event
      const processed = await replayResultObserver.handleJobFailed(
        incident.queueName,
        replayJobId,
        "SMTP server refused authentication"
      );

      expect(processed).toBe(true);

      const failedIncident = await prisma.incident.findUnique({
        where: { id: incident.id },
      });
      expect(failedIncident?.status).toBe("REPLAY_FAILED");

      const failedAttempt = await prisma.recoveryAttempt.findUnique({
        where: { id: replay.recoveryAttempt.id },
      });
      expect(failedAttempt?.status).toBe("FAILED");
      expect(failedAttempt?.failureReason).toBe("SMTP server refused authentication");

      const audit = await prisma.auditLog.findFirst({
        where: { incidentId: incident.id, action: "RECOVERY_REPLAY_FAILED" },
      });
      expect(audit).toBeDefined();
    });
  });

  describe("REST API Endpoints", () => {
    it("POST /api/incidents/:id/approve should approve and trigger replay via HTTP", async () => {
      const incident = await createAwaitingApprovalIncident();

      const res = await request(app)
        .post(`/api/incidents/${incident.id}/approve`)
        .send({
          approvedBy: "dashboard-user",
          autoReplay: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.incident.status).toBe("REPLAYING");
      expect(res.body.recoveryAttempt.status).toBe("IN_PROGRESS");
    });

    it("POST /api/incidents/:id/reject should quarantine incident via HTTP", async () => {
      const incident = await createAwaitingApprovalIncident();

      const res = await request(app)
        .post(`/api/incidents/${incident.id}/reject`)
        .send({
          rejectedBy: "dashboard-user",
          reason: "Risk assessment rejected proposal",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.incident.status).toBe("QUARANTINED");
    });

    it("GET /api/incidents/:id/recoveries should return recovery history", async () => {
      const incident = await createAwaitingApprovalIncident();
      await replayService.approveIncident(incident.id, { autoReplay: true });

      const res = await request(app).get(`/api/incidents/${incident.id}/recoveries`);

      expect(res.status).toBe(200);
      expect(res.body.incidentId).toBe(incident.id);
      expect(res.body.totalAttempts).toBe(1);
      expect(res.body.recoveries).toHaveLength(1);
      expect(res.body.recoveries[0].status).toBe("IN_PROGRESS");
    });

    it("B01: rejects POST /replay on unapproved AWAITING_APPROVAL incident with 409 and enqueues 0 jobs", async () => {
      const queueName = `b01-unapproved-${Date.now()}`;
      const incident = await createAwaitingApprovalIncident({ queueName });
      const queue = new Queue(queueName, { connection: redis });

      try {
        const res = await request(app)
          .post(`/api/incidents/${incident.id}/replay`)
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("APPROVAL_REQUIRED");

        const dbIncident = await prisma.incident.findUnique({
          where: { id: incident.id },
          include: { recoveryAttempts: true, auditLogs: true },
        });
        expect(dbIncident?.status).toBe("AWAITING_APPROVAL");
        expect(dbIncident?.recoveryAttempts).toHaveLength(0);
        expect(
          dbIncident?.auditLogs.some((log) => log.action === "RECOVERY_APPROVED")
        ).toBe(false);

        const jobCounts = await queue.getJobCounts();
        expect(
          jobCounts.waiting + jobCounts.delayed + jobCounts.active + jobCounts.completed
        ).toBe(0);
      } finally {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    });

    it("B01: rejects executeReplay when REPLAY_QUEUED incident lacks persisted RECOVERY_APPROVED audit record", async () => {
      const incident = await createAwaitingApprovalIncident({
        status: "REPLAY_QUEUED",
      });
      await prisma.recoveryAttempt.create({
        data: {
          incidentId: incident.id,
          proposedPayload: incident.proposedPayload as any,
          validationResult: incident.validationResult as any,
          status: "QUEUED",
        },
      });

      const res = await request(app)
        .post(`/api/incidents/${incident.id}/replay`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("APPROVAL_REQUIRED");
    });

    it("B02: rejects cross-incident recoveryAttemptId without mutating either incident or enqueuing a job", async () => {
      const queueAName = `b02-queue-a-${Date.now()}`;
      const queueBName = `b02-queue-b-${Date.now()}`;
      const incidentA = await createAwaitingApprovalIncident({ queueName: queueAName });
      const incidentB = await createAwaitingApprovalIncident({ queueName: queueBName });

      const approvedA = await replayService.approveIncident(incidentA.id, {
        approvedBy: "operator-a",
        autoReplay: false,
      });
      const approvedB = await replayService.approveIncident(incidentB.id, {
        approvedBy: "operator-b",
        autoReplay: false,
      });

      const queueA = new Queue(queueAName, { connection: redis });
      try {
        const res = await request(app)
          .post(`/api/incidents/${incidentA.id}/replay`)
          .send({ recoveryAttemptId: approvedB.recoveryAttempt.id });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("RECOVERY_ATTEMPT_NOT_FOUND");

        const freshA = await prisma.incident.findUnique({ where: { id: incidentA.id } });
        const freshAttemptA = await prisma.recoveryAttempt.findUnique({
          where: { id: approvedA.recoveryAttempt.id },
        });
        const freshAttemptB = await prisma.recoveryAttempt.findUnique({
          where: { id: approvedB.recoveryAttempt.id },
        });

        expect(freshA?.status).toBe("REPLAY_QUEUED");
        expect(freshAttemptA?.status).toBe("QUEUED");
        expect(freshAttemptB?.status).toBe("QUEUED");
        expect(freshAttemptB?.replayJobId).toBeNull();

        const jobCountsA = await queueA.getJobCounts();
        expect(
          jobCountsA.waiting + jobCountsA.delayed + jobCountsA.active
        ).toBe(0);
      } finally {
        await queueA.obliterate({ force: true }).catch(() => undefined);
        await queueA.close();
      }
    });

    it("B03: concurrent approvals yield exactly one queued attempt and concurrent replays dispatch exactly one deterministic job", async () => {
      const queueName = `b03-concurrent-${Date.now()}`;
      const incident = await createAwaitingApprovalIncident({ queueName });
      const queue = new Queue(queueName, { connection: redis });

      try {
        // Concurrent approve calls with autoReplay: false
        const approveResults = await Promise.allSettled([
          replayService.approveIncident(incident.id, {
            approvedBy: "op-1",
            autoReplay: false,
          }),
          replayService.approveIncident(incident.id, {
            approvedBy: "op-2",
            autoReplay: false,
          }),
        ]);

        const fulfilledApprovals = approveResults.filter(
          (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled"
        );
        const rejectedApprovals = approveResults.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );

        expect(fulfilledApprovals).toHaveLength(1);
        expect(rejectedApprovals).toHaveLength(1);

        // Sequential repeat approval while REPLAY_QUEUED must also conflict with 409
        const repeatRes = await request(app)
          .post(`/api/incidents/${incident.id}/approve`)
          .send({ approvedBy: "op-3", autoReplay: false });
        expect(repeatRes.status).toBe(409);

        const attempts = await prisma.recoveryAttempt.findMany({
          where: { incidentId: incident.id },
        });
        expect(attempts).toHaveLength(1);
        const attemptId = attempts[0].id;

        // Concurrent executeReplay calls for that approved queued attempt
        const replayResults = await Promise.allSettled([
          replayService.executeReplay(incident.id, attemptId),
          replayService.executeReplay(incident.id, attemptId),
        ]);

        const fulfilledReplays = replayResults.filter(
          (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled"
        );
        const rejectedReplays = replayResults.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );

        expect(fulfilledReplays).toHaveLength(1);
        expect(rejectedReplays).toHaveLength(1);
        expect(fulfilledReplays[0].value.recoveryAttempt.replayJobId).toBe(
          `recovery-${attemptId}`
        );

        const job = await queue.getJob(`recovery-${attemptId}`);
        expect(job).toBeDefined();
        const jobCounts = await queue.getJobCounts();
        expect(
          jobCounts.waiting + jobCounts.delayed + jobCounts.active + jobCounts.completed
        ).toBe(1);
      } finally {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    });

    it("B05: enforces cumulative lineage replay ceiling across child incidents from failed replays", async () => {
      const queueName = `b05-lineage-${Date.now()}`;
      const rootIncident = await createAwaitingApprovalIncident({ queueName });
      const queue = new Queue(queueName, { connection: redis });

      try {
        // Root replay #1 succeeds dispatch and propagates lineage metadata onto BullMQ job opts
        const replay = await replayService.approveIncident(rootIncident.id, {
          approvedBy: "operator-1",
          autoReplay: true,
        });
        const replayJobId = replay.recoveryAttempt.replayJobId!;
        const replayedJob = await queue.getJob(replayJobId);
        expect(replayedJob).toBeDefined();
        expect((replayedJob?.opts as any)?.dlqLineage).toEqual({
          lineageRootId: rootIncident.id,
          parentIncidentId: rootIncident.id,
          replayDepth: 1,
        });

        // Mark replay #1 failed
        await replayResultObserver.handleJobFailed(
          queueName,
          replayJobId,
          "Downstream failure during replay"
        );

        // Child incident re-captured from failed replay (both via explicit lineage & recovery job ID)
        const childIngest = await incidentService.ingestSnapshot({
          idempotencyKey: `b05-child:${Date.now()}`,
          source: "recovery-test",
          queueName,
          jobId: replayJobId,
          jobName: rootIncident.jobName,
          payloadSnapshot: rootIncident.payloadSnapshot as Record<string, any>,
          errorMessage: "Downstream failure during replay",
          attemptsMade: 3,
          configuredAttempts: 3,
          lineage: (replayedJob?.opts as any)?.dlqLineage,
        });
        createdIncidentIds.push(childIngest.incident.id);

        expect(childIngest.incident.lineageRootId).toBe(rootIncident.id);
        expect(childIngest.incident.parentIncidentId).toBe(rootIncident.id);
        expect(childIngest.incident.replayDepth).toBe(1);

        // Prepare child proposal -> Stage 4 MUST reject because lineage replay budget (1) is exhausted
        await prisma.incident.update({
          where: { id: childIngest.incident.id },
          data: {
            status: "PROPOSAL_READY",
            aiDiagnosis: rootIncident.aiDiagnosis as any,
            proposedPayload: rootIncident.proposedPayload as any,
          },
        });

        const validation = await validationService.validateProposal(
          childIngest.incident.id
        );
        expect(validation.status).toBe("SANDBOX_FAILED");
        expect(validation.validation.passed).toBe(false);
        expect(validation.validation.failedStage).toBe(4);
        expect(validation.validation.rejectionReason).toContain(
          "REPLAY_LIMIT_EXCEEDED"
        );

        // Even if forced to AWAITING_APPROVAL, approveIncident must reject with 409 REPLAY_LIMIT_EXCEEDED
        await prisma.incident.update({
          where: { id: childIngest.incident.id },
          data: {
            status: "AWAITING_APPROVAL",
            validationResult: { passed: true } as any,
          },
        });

        const approveRes = await request(app)
          .post(`/api/incidents/${childIngest.incident.id}/approve`)
          .send({ approvedBy: "operator-2", autoReplay: true });

        expect(approveRes.status).toBe(409);
        expect(approveRes.body.code).toBe("REPLAY_LIMIT_EXCEEDED");
      } finally {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    });

    it("B06: rejects /match, /diagnose, /validate on RESOLVED, REPLAYING, and QUARANTINED incidents with 409 without mutating DB state", async () => {
      const protectedStatuses = ["RESOLVED", "REPLAYING", "QUARANTINED"] as const;

      for (const status of protectedStatuses) {
        const incident = await createAwaitingApprovalIncident({ status });

        for (const action of ["match", "diagnose", "validate"] as const) {
          const res = await request(app)
            .post(`/api/incidents/${incident.id}/${action}`)
            .send({});

          expect(res.status).toBe(409);
          expect(res.body.code).toBe("INVALID_STATE_TRANSITION");

          const fresh = await prisma.incident.findUnique({
            where: { id: incident.id },
          });
          expect(fresh?.status).toBe(status);
        }
      }
    });

    it("B07: awaits observer readiness before reinjecting replay job into BullMQ", async () => {
      const queueName = `b07-ready-${Date.now()}`;
      const incident = await createAwaitingApprovalIncident({ queueName });
      const callOrder: string[] = [];

      const readySpy = vi
        .spyOn(replayResultObserver, "ensureQueueObserverReady")
        .mockImplementation(async () => {
          callOrder.push("observerReady");
          return {} as any;
        });
      const reinjectSpy = vi
        .spyOn(queueReinjector, "reinjectJob")
        .mockImplementation(async (_q, jobName, _p, opts) => {
          callOrder.push("reinjectJob");
          return { jobId: opts?.jobId || "recovery-mock", queueName, jobName };
        });

      try {
        await replayService.approveIncident(incident.id, {
          approvedBy: "b07-tester",
          autoReplay: true,
        });
        expect(callOrder).toEqual(["observerReady", "reinjectJob"]);
      } finally {
        readySpy.mockRestore();
        reinjectSpy.mockRestore();
      }
    });
  });
});
