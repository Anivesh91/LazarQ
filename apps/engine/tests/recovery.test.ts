import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { incidentService } from "../src/services/incident.service";
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
  });
});
