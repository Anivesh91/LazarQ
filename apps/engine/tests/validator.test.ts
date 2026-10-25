import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { validationService } from "../src/services/validation.service";
import { incidentService } from "../src/services/incident.service";
import { deterministicValidator } from "../src/sandbox/validator";

describe("Day 9: Deterministic Validation Gate (5-Stage Sandbox)", () => {
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

  it("should PASS all 5 stages for a legitimate channel mutation and set AWAITING_APPROVAL", async () => {
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `val:pass:${Date.now()}`,
      source: "val-test",
      queueName: "order-queue",
      jobId: `job-pass-${Date.now()}`,
      jobName: "send-order-sms",
      payloadSnapshot: {
        orderId: "ORD-VAL-101",
        userId: "usr_42",
        amount: 2500,
        notificationChannel: "SMS",
      },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    // Mock proposal attached to incident
    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        status: "PROPOSAL_READY",
        aiDiagnosis: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.95,
          delaySeconds: 60,
          mutations: [
            { field: "notificationChannel", from: "SMS", to: "EMAIL", reason: "Fallback per SOP" },
          ],
          rootCause: "Rate limit",
          reasoning: "Safe channel fallback",
        },
        proposedPayload: {
          orderId: "ORD-VAL-101",
          userId: "usr_42",
          amount: 2500,
          notificationChannel: "EMAIL",
        },
      },
    });

    const result = await validationService.validateProposal(ingest.incident.id);

    expect(result.status).toBe("AWAITING_APPROVAL");
    expect(result.validation.passed).toBe(true);
    expect(result.validation.stages.length).toBe(5);
    expect(result.validation.stages.every((s) => s.passed)).toBe(true);

    // Verify DB update
    const dbIncident = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
    });
    expect(dbIncident?.status).toBe("AWAITING_APPROVAL");
    expect(dbIncident?.validationResult).toBeDefined();

    // Verify AuditLog
    const logs = await prisma.auditLog.findMany({
      where: { incidentId: ingest.incident.id },
    });
    expect(logs.some((l) => l.action === "AWAITING_APPROVAL" && l.actor === "validation-gate")).toBe(true);
  });

  it("should FAIL Stage 1 (Schema Validation) when proposed payload omits schema-required fields", () => {
    const context: any = {
      incident: {
        id: "inc-stage-1",
        queueName: "order-queue",
        status: "PROPOSAL_READY",
        attemptsMade: 3,
        configuredAttempts: 3,
        payloadSnapshot: { orderId: "ORD-1", amount: 100 },
        expectedJsonSchema: {
          required: ["orderId", "amount", "shippingAddress"],
        },
      },
      proposal: {
        classification: "TRANSIENT",
        action: "RETRY",
        confidence: 0.9,
        delaySeconds: 30,
        mutations: [],
        rootCause: "Timeout",
        reasoning: "Retry",
      },
      proposedPayload: {
        orderId: "ORD-1",
        amount: 100, // missing shippingAddress
      },
    };

    const res = deterministicValidator.validate(context);
    expect(res.passed).toBe(false);
    expect(res.failedStage).toBe(1);
    expect(res.rejectionReason).toContain("missing required fields [shippingAddress]");
  });

  it("should FAIL Stage 2 (Invariant Check) when immutable business fields are mutated", async () => {
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `val:invariant:${Date.now()}`,
      source: "val-test",
      queueName: "order-queue",
      jobId: `job-inv-${Date.now()}`,
      jobName: "process-order",
      payloadSnapshot: {
        orderId: "ORD-ORIGINAL-999",
        amount: 5000,
        notificationChannel: "SMS",
      },
      errorMessage: "Some error",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    // AI illegally reduced price amount from 5000 to 50
    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        status: "PROPOSAL_READY",
        aiDiagnosis: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.8,
          delaySeconds: 0,
          mutations: [{ field: "amount", from: 5000, to: 50 }],
          rootCause: "Price discount",
          reasoning: "Illegally altering amount",
        },
        proposedPayload: {
          orderId: "ORD-ORIGINAL-999",
          amount: 50, // MUTATED INVARIANT!
          notificationChannel: "SMS",
        },
      },
    });

    const result = await validationService.validateProposal(ingest.incident.id);

    expect(result.status).toBe("SANDBOX_FAILED");
    expect(result.validation.passed).toBe(false);
    expect(result.validation.failedStage).toBe(2);
    expect(result.validation.rejectionReason).toContain('Immutable field "amount" was mutated');

    const dbIncident = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
    });
    expect(dbIncident?.status).toBe("SANDBOX_FAILED");
  });

  it("should FAIL Stage 3 (Allowed Mutations) when unwhitelisted fields are altered", () => {
    const context: any = {
      incident: {
        id: "inc-stage-3",
        queueName: "order-queue",
        status: "PROPOSAL_READY",
        attemptsMade: 3,
        configuredAttempts: 3,
        payloadSnapshot: { orderId: "ORD-1", internalRiskScore: 10 },
      },
      proposal: {
        classification: "TRANSIENT",
        action: "MUTATE_AND_RETRY",
        confidence: 0.85,
        delaySeconds: 10,
        mutations: [
          { field: "internalRiskScore", from: 10, to: 0, reason: "Bypass risk check" },
        ],
        rootCause: "Risk rejection",
        reasoning: "Illegally clearing risk",
      },
      proposedPayload: {
        orderId: "ORD-1",
        internalRiskScore: 0,
      },
    };

    const res = deterministicValidator.validate(context);
    expect(res.passed).toBe(false);
    expect(res.failedStage).toBe(3);
    expect(res.rejectionReason).toContain("Unauthorized mutation keys detected: [internalRiskScore]");
  });

  it("should FAIL Stage 4 (Replay Guard) when incident is already in a terminal state", () => {
    const context: any = {
      incident: {
        id: "inc-stage-4",
        queueName: "order-queue",
        status: "RESOLVED", // already resolved!
        attemptsMade: 3,
        configuredAttempts: 3,
        payloadSnapshot: { orderId: "ORD-1" },
      },
      proposal: {
        classification: "TRANSIENT",
        action: "RETRY",
        confidence: 0.9,
        delaySeconds: 30,
        mutations: [],
        rootCause: "Transient",
        reasoning: "Retry",
      },
      proposedPayload: { orderId: "ORD-1" },
    };

    const res = deterministicValidator.validate(context);
    expect(res.passed).toBe(false);
    expect(res.failedStage).toBe(4);
    expect(res.rejectionReason).toContain('Incident is in state "RESOLVED"');
  });

  it("should FAIL Stage 5 (Dry-Run Boundary) when malicious prototype pollution or scripts are injected", () => {
    const context: any = {
      incident: {
        id: "inc-stage-5",
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
        mutations: [{ field: "notificationChannel", from: "SMS", to: "EMAIL" }],
        rootCause: "XSS attempt",
        reasoning: "Injected script",
      },
      proposedPayload: {
        orderId: "ORD-1",
        notificationChannel: "EMAIL",
        malicious: "<script>alert(1)</script>", // INJECTION ATTEMPT!
      },
    };

    const res = deterministicValidator.validate(context);
    expect(res.passed).toBe(false);
    expect(res.failedStage).toBe(5);
    expect(res.rejectionReason).toContain("Malicious injection pattern detected");
  });

  it("should support running the validation gate via REST API: POST /api/incidents/:id/validate", async () => {
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `val:api:${Date.now()}`,
      source: "val-test",
      queueName: "order-queue",
      jobId: `job-api-val-${Date.now()}`,
      jobName: "send-order-sms",
      payloadSnapshot: {
        orderId: "ORD-API-VAL-1",
        notificationChannel: "SMS",
      },
      errorMessage: "Twilio Error 20429",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        status: "PROPOSAL_READY",
        aiDiagnosis: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.95,
          delaySeconds: 60,
          mutations: [{ field: "notificationChannel", from: "SMS", to: "EMAIL" }],
          rootCause: "Rate limit",
          reasoning: "Safe fallback",
        },
        proposedPayload: {
          orderId: "ORD-API-VAL-1",
          notificationChannel: "EMAIL",
        },
      },
    });

    const res = await request(app)
      .post(`/api/incidents/${ingest.incident.id}/validate`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("AWAITING_APPROVAL");
    expect(res.body.validation.passed).toBe(true);
  });
});
