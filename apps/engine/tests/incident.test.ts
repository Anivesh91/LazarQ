import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { incidentService } from "../src/services/incident.service";
import { prisma } from "../src/db/prisma";
import { IncidentSnapshot } from "@dlq-healer/sdk";

describe("Incident Ingestion Service", () => {
  const testIdempotencyKey = `test-queue:job_9999:${Date.now()}`;

  const mockSnapshot: IncidentSnapshot = {
    idempotencyKey: testIdempotencyKey,
    source: "test-suite",
    queueName: "test-orders-queue",
    jobId: "job_9999",
    jobName: "process-order",
    payloadSnapshot: {
      orderId: "ORD_TEST_9999",
      amount: 1500,
      password: "[REDACTED]",
    },
    errorMessage: "Twilio Error 20429: Rate limit exceeded",
    stackTrace: "Error: Twilio Error 20429 at worker.ts:10",
    attemptsMade: 3,
    configuredAttempts: 3,
    occurredAt: new Date().toISOString(),
  };

  afterAll(async () => {
    // Cleanup test data
    await prisma.auditLog.deleteMany({
      where: { incident: { idempotencyKey: testIdempotencyKey } },
    });
    await prisma.incident.deleteMany({
      where: { idempotencyKey: testIdempotencyKey },
    });
    await prisma.$disconnect();
  });

  it("should successfully ingest a new terminal failure snapshot into PostgreSQL", async () => {
    const result = await incidentService.ingestSnapshot(mockSnapshot);

    expect(result.isDuplicate).toBe(false);
    expect(result.incident.id).toBeDefined();
    expect(result.incident.queueName).toBe("test-orders-queue");
    expect(result.incident.jobId).toBe("job_9999");
    expect(result.incident.status).toBe("INGESTED");
    expect(result.incident.attemptsMade).toBe(3);
  });

  it("should handle duplicate deliveries idempotently without creating duplicate rows", async () => {
    // Call ingestSnapshot again with the identical idempotencyKey
    const duplicateResult = await incidentService.ingestSnapshot(mockSnapshot);

    expect(duplicateResult.isDuplicate).toBe(true);

    // Verify exactly 1 incident exists in DB with this key
    const count = await prisma.incident.count({
      where: { idempotencyKey: testIdempotencyKey },
    });
    expect(count).toBe(1);
  });

  it("should link an initial FAILURE_CAPTURED AuditLog record", async () => {
    const incident = await prisma.incident.findUnique({
      where: { idempotencyKey: testIdempotencyKey },
      include: { auditLogs: true },
    });

    expect(incident).toBeDefined();
    expect(incident!.auditLogs.length).toBeGreaterThanOrEqual(1);
    expect(incident!.auditLogs[0].action).toBe("FAILURE_CAPTURED");
    expect(incident!.auditLogs[0].actor).toBe("system/intake");
  });

  it("should list incidents with pagination", async () => {
    const list = await incidentService.listIncidents({
      page: 1,
      limit: 10,
    });

    expect(list.items).toBeInstanceOf(Array);
    expect(list.pagination.total).toBeGreaterThanOrEqual(1);
    expect(list.pagination.page).toBe(1);
  });
});
