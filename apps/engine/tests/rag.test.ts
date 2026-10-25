import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { ragService } from "../src/services/rag.service";
import { incidentService } from "../src/services/incident.service";

describe("Day 7: RAG Retrieval Pipeline", () => {
  const createdIncidentIds: string[] = [];

  afterAll(async () => {
    // Teardown created incidents and audit logs
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

  it("should match Twilio 20429 rate limit error to Twilio SMS Runbook with high confidence", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `rag-test:twilio:${Date.now()}`,
      source: "rag-test",
      queueName: "order-queue",
      jobId: `job-twilio-${Date.now()}`,
      jobName: "send-order-sms",
      payloadSnapshot: { orderId: "ORD-123", channel: "SMS", phone: "+1234567890" },
      errorMessage: "Twilio Error 20429: Rate limit exceeded for phone number",
      stackTrace: "Error: Twilio Error 20429 at TwilioDispatcher.send (order.worker.ts:45)",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const matchResult = await ragService.matchIncident(ingestResult.incident.id);

    expect(matchResult.matched).toBe(true);
    expect(matchResult.status).toBe("RAG_MATCHED");
    expect(matchResult.runbook).toBeDefined();
    expect(matchResult.runbook?.title).toContain("Twilio SMS Rate Limit");
    expect(matchResult.similarity).toBeGreaterThanOrEqual(0.60);

    // Verify database state
    const updated = await prisma.incident.findUnique({
      where: { id: ingestResult.incident.id },
    });
    expect(updated?.status).toBe("RAG_MATCHED");
    expect(updated?.matchedRunbookId).toBe(matchResult.runbook?.id);

    // Verify audit log
    const auditLogs = await prisma.auditLog.findMany({
      where: { incidentId: ingestResult.incident.id },
      orderBy: { createdAt: "asc" },
    });
    const ragLog = auditLogs.find((l) => l.action === "RAG_MATCHED");
    expect(ragLog).toBeDefined();
  });

  it("should match Missing userId error to Payload Validation Runbook", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `rag-test:validation:${Date.now()}`,
      source: "rag-test",
      queueName: "order-queue",
      jobId: `job-validation-${Date.now()}`,
      jobName: "validate-order",
      payloadSnapshot: { amount: 200, items: ["item_1"] },
      errorMessage: "Validation Error: userId is required in payload",
      stackTrace: "ValidationError: userId is required at Validator.validate (order.worker.ts:25)",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const matchResult = await ragService.matchIncident(ingestResult.incident.id);

    expect(matchResult.matched).toBe(true);
    expect(matchResult.status).toBe("RAG_MATCHED");
    expect(matchResult.runbook?.title).toContain("Missing Required Field");
    expect(matchResult.similarity).toBeGreaterThanOrEqual(0.60);
  });

  it("should match PostgreSQL pool timeout to Database Runbook", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `rag-test:postgres:${Date.now()}`,
      source: "rag-test",
      queueName: "order-queue",
      jobId: `job-postgres-${Date.now()}`,
      jobName: "persist-order",
      payloadSnapshot: { orderId: "ORD-999", userId: "usr_123" },
      errorMessage: "PostgreSQL pool connection timeout after 5000ms",
      stackTrace: "Error: PostgreSQL pool connection timeout at pg.Pool.connect (order.worker.ts:60)",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const matchResult = await ragService.matchIncident(ingestResult.incident.id);

    expect(matchResult.matched).toBe(true);
    expect(matchResult.status).toBe("RAG_MATCHED");
    expect(matchResult.runbook?.title).toContain("PostgreSQL");
    expect(matchResult.similarity).toBeGreaterThanOrEqual(0.60);
  });

  it("should QUARANTINE completely unknown/irrelevant failure that lacks SOP", async () => {
    // Custom instance with strict threshold
    const strictRagService = new ragService.constructor(0.75) as typeof ragService;

    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `rag-test:unknown:${Date.now()}`,
      source: "rag-test",
      queueName: "satellite-telemetry-queue",
      jobId: `job-satellite-${Date.now()}`,
      jobName: "deep-space-tracking",
      payloadSnapshot: { altitudeKm: 42000, ionThrusterActive: true },
      errorMessage: "Deep space ion drive gyroscopic torque differential desync on Mars orbiter probe",
      stackTrace: "Error: GyroTorqueDesync at SatelliteTelemetry.track (spacecraft.ts:999)",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const matchResult = await strictRagService.matchIncident(ingestResult.incident.id);

    expect(matchResult.matched).toBe(false);
    expect(matchResult.status).toBe("QUARANTINED");
    expect(matchResult.runbook).toBeNull();

    // Verify incident updated to QUARANTINED in database
    const updated = await prisma.incident.findUnique({
      where: { id: ingestResult.incident.id },
    });
    expect(updated?.status).toBe("QUARANTINED");
  });

  it("should support triggering RAG matching via REST API: POST /api/incidents/:id/match", async () => {
    const ingestResult = await incidentService.ingestSnapshot({
      idempotencyKey: `rag-test:api:${Date.now()}`,
      source: "rag-test",
      queueName: "order-queue",
      jobId: `job-api-${Date.now()}`,
      jobName: "api-order",
      payloadSnapshot: { orderId: "ORD-API-1" },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingestResult.incident.id);

    const res = await request(app)
      .post(`/api/incidents/${ingestResult.incident.id}/match`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.incidentId).toBe(ingestResult.incident.id);
    expect(res.body.status).toBe("RAG_MATCHED");
    expect(res.body.runbook).toBeDefined();
  });
});
