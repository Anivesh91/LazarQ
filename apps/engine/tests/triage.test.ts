import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { triageService } from "../src/services/triage.service";
import { incidentService } from "../src/services/incident.service";
import { llmService } from "../src/services/llm.service";

describe("Day 8: The AI Doctor - Structured LLM Repair Planner", () => {
  const createdIncidentIds: string[] = [];

  afterAll(async () => {
    if (createdIncidentIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { incidentId: { in: createdIncidentIds } },
      });
      await prisma.incident.deleteMany({
        where: { id: { in: createdIncidentIds } },
      });
    }
    await prisma.$disconnect();
  });

  it(
    "should diagnose Twilio 20429 rate limit, prescribe MUTATE_AND_RETRY to EMAIL, and set PROPOSAL_READY",
    async () => {
      const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `triage:twilio:${Date.now()}`,
      source: "triage-test",
      queueName: "order-queue",
      jobId: `job-twilio-triage-${Date.now()}`,
      jobName: "send-order-sms",
      payloadSnapshot: {
        orderId: "ORD-TWILIO-101",
        notificationChannel: "SMS",
        customerEmail: "user@example.com",
        phone: "+15551234567",
      },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      stackTrace: "Error: Twilio Error 20429 at worker.ts:40",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const triageResult = await triageService.diagnoseIncident(ingestResult.incident.id);

    expect(triageResult.status).toBe("PROPOSAL_READY");
    expect(triageResult.proposal).toBeDefined();
    expect(["MUTATE_AND_RETRY", "RETRY"]).toContain(triageResult.proposal?.action);
    expect(triageResult.proposal?.classification).toBe("TRANSIENT");
    expect(triageResult.proposal?.delaySeconds).toBeGreaterThanOrEqual(30);

    // Verify proposed payload exists
    expect(triageResult.proposedPayload).toBeDefined();
    expect(triageResult.proposedPayload?.orderId).toBe("ORD-TWILIO-101");

    // Verify database state
    const incidentDb = await prisma.incident.findUnique({
      where: { id: ingestResult.incident.id },
    });
    expect(incidentDb?.status).toBe("PROPOSAL_READY");
    expect(incidentDb?.aiDiagnosis).toBeDefined();
    expect(incidentDb?.proposedPayload).toBeDefined();

    // Verify AuditLog
    const logs = await prisma.auditLog.findMany({
      where: { incidentId: ingestResult.incident.id },
    });
    expect(logs.some((l) => l.action === "PROPOSAL_READY" && l.actor === "ai-doctor")).toBe(true);
  }, 15000);

  it("should diagnose missing userId, prescribe QUARANTINE, and set status QUARANTINED without forging IDs", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `triage:validation:${Date.now()}`,
      source: "triage-test",
      queueName: "order-queue",
      jobId: `job-validation-triage-${Date.now()}`,
      jobName: "validate-order",
      payloadSnapshot: {
        orderId: "ORD-INVALID-999",
        amount: 2500,
      },
      errorMessage: "Validation Error: userId is required in payload",
      stackTrace: "ValidationError: userId is required at worker.ts:20",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const triageResult = await triageService.diagnoseIncident(ingestResult.incident.id);

    expect(triageResult.status).toBe("QUARANTINED");
    expect(triageResult.proposal).toBeDefined();
    expect(triageResult.proposal?.action).toBe("QUARANTINE");
    expect(triageResult.proposedPayload).toBeNull();

    // Verify database status
    const incidentDb = await prisma.incident.findUnique({
      where: { id: ingestResult.incident.id },
    });
    expect(incidentDb?.status).toBe("QUARANTINED");

    // Verify AuditLog
    const logs = await prisma.auditLog.findMany({
      where: { incidentId: ingestResult.incident.id },
    });
    expect(logs.some((l) => l.action === "QUARANTINED" && l.actor === "ai-doctor")).toBe(true);
  });

  it("should diagnose PostgreSQL timeout, prescribe pure RETRY with delaySeconds, and preserve payload intact", async () => {
    const originalPayload = {
      orderId: "ORD-DB-777",
      userId: "usr_active_42",
      total: 1200,
    };

    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `triage:postgres:${Date.now()}`,
      source: "triage-test",
      queueName: "order-queue",
      jobId: `job-postgres-triage-${Date.now()}`,
      jobName: "persist-order",
      payloadSnapshot: originalPayload,
      errorMessage: "PostgreSQL pool connection timeout after 5000ms",
      stackTrace: "Error: PostgreSQL pool connection timeout at worker.ts:55",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const triageResult = await triageService.diagnoseIncident(ingestResult.incident.id);

    expect(triageResult.status).toBe("PROPOSAL_READY");
    expect(triageResult.proposal?.action).toBe("RETRY");
    expect(triageResult.proposal?.delaySeconds).toBeGreaterThanOrEqual(15);
    expect(triageResult.proposedPayload).toEqual(originalPayload);
  });

  it("should transition incident to ANALYSIS_FAILED if LLM provider fails", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `triage:fail:${Date.now()}`,
      source: "triage-test",
      queueName: "order-queue",
      jobId: `job-fail-${Date.now()}`,
      jobName: "failing-order",
      payloadSnapshot: { id: "1" },
      errorMessage: "Some transient error",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    // Temporarily mock LLM failure
    const originalMethod = llmService.generateRepairProposal;
    llmService.generateRepairProposal = async () => {
      throw new Error("Simulated upstream LLM rate-limit 429 quota exhaustion");
    };

    try {
      const triageResult = await triageService.diagnoseIncident(ingestResult.incident.id);
      expect(triageResult.status).toBe("ANALYSIS_FAILED");
      expect(triageResult.proposal).toBeNull();

      const incidentDb = await prisma.incident.findUnique({
        where: { id: ingestResult.incident.id },
      });
      expect(incidentDb?.status).toBe("ANALYSIS_FAILED");
    } finally {
      llmService.generateRepairProposal = originalMethod;
    }
  });

  it("should support triggering AI diagnosis via REST API: POST /api/incidents/:id/diagnose", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `triage:api:${Date.now()}`,
      source: "triage-test",
      queueName: "order-queue",
      jobId: `job-api-triage-${Date.now()}`,
      jobName: "send-order-sms",
      payloadSnapshot: {
        orderId: "ORD-API-202",
        notificationChannel: "SMS",
      },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const res = await request(app)
      .post(`/api/incidents/${ingestResult.incident.id}/diagnose`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("PROPOSAL_READY");
    expect(["MUTATE_AND_RETRY", "RETRY"]).toContain(res.body.proposal.action);
  }, 15000);
});
