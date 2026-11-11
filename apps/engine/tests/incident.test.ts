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

  it(
    "should successfully ingest a new terminal failure snapshot into PostgreSQL",
    async () => {
      const result = await incidentService.ingestSnapshot(mockSnapshot);

      expect(result.isDuplicate).toBe(false);
      expect(result.incident.id).toBeDefined();
      expect(result.incident.queueName).toBe("test-orders-queue");
      expect(result.incident.jobId).toBe("job_9999");
      expect(result.incident.status).toBe("INGESTED");
      expect(result.incident.attemptsMade).toBe(3);
    },
    15000
  );

  it(
    "should handle duplicate deliveries idempotently without creating duplicate rows",
    async () => {
      // Call ingestSnapshot again with the identical idempotencyKey
      const duplicateResult = await incidentService.ingestSnapshot(mockSnapshot);

      expect(duplicateResult.isDuplicate).toBe(true);

      // Verify exactly 1 incident exists in DB with this key
      const count = await prisma.incident.count({
        where: { idempotencyKey: testIdempotencyKey },
      });
      expect(count).toBe(1);
    },
    15000
  );

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

  it("B15: namespaces deduplication by sourceId so different apps with identical queue/jobId/attempts create separate incidents", async () => {
    const sharedQueue = `b15-shared-queue-${Date.now()}`;
    const sharedJobId = "shared-job-42";
    const createdIds: string[] = [];

    try {
      const appA = await incidentService.ingestSnapshot({
        idempotencyKey: `app-a:${sharedQueue}:${sharedJobId}:3`,
        source: "app-a",
        queueName: sharedQueue,
        jobId: sharedJobId,
        jobName: "process-order",
        payloadSnapshot: { orderId: "ORD-A" },
        errorMessage: "Timeout error",
        attemptsMade: 3,
        configuredAttempts: 3,
      });
      createdIds.push(appA.incident.id);

      const appB = await incidentService.ingestSnapshot({
        idempotencyKey: `app-b:${sharedQueue}:${sharedJobId}:3`,
        source: "app-b",
        queueName: sharedQueue,
        jobId: sharedJobId,
        jobName: "process-order",
        payloadSnapshot: { orderId: "ORD-B" },
        errorMessage: "Timeout error",
        attemptsMade: 3,
        configuredAttempts: 3,
      });
      createdIds.push(appB.incident.id);

      expect(appA.isDuplicate).toBe(false);
      expect(appB.isDuplicate).toBe(false);
      expect(appA.incident.id).not.toBe(appB.incident.id);
      expect(appA.incident.sourceId).toBe("app-a");
      expect(appB.incident.sourceId).toBe("app-b");

      // Same sourceId + queueName + jobId + attemptsMade deduplicates even with a differing key format
      const appADup = await incidentService.ingestSnapshot({
        idempotencyKey: `app-a:alt-key:${sharedQueue}:${sharedJobId}:3`,
        source: "app-a",
        queueName: sharedQueue,
        jobId: sharedJobId,
        jobName: "process-order",
        payloadSnapshot: { orderId: "ORD-A" },
        errorMessage: "Timeout error",
        attemptsMade: 3,
        configuredAttempts: 3,
      });
      expect(appADup.isDuplicate).toBe(true);
      expect(appADup.incident.id).toBe(appA.incident.id);
    } finally {
      if (createdIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { incidentId: { in: createdIds } },
        });
        await prisma.incident.deleteMany({
          where: { id: { in: createdIds } },
        });
      }
    }
  });
});
