import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";

describe("DLQ-Healer Engine REST API", () => {
  const uniqueKey = `api-test-queue:job_${Date.now()}`;
  let createdIncidentId: string;

  afterAll(async () => {
    if (createdIncidentId) {
      await prisma.auditLog.deleteMany({
        where: { incidentId: createdIncidentId },
      });
      await prisma.incident.deleteMany({
        where: { id: createdIncidentId },
      });
    }
    await prisma.$disconnect();
  });

  describe("GET /health", () => {
    it("should return 200 and healthy status", async () => {
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.redis).toBe("connected");
      expect(res.body.database).toBe("connected");
    });
  });

  describe("POST /api/incidents/ingest", () => {
    it("should ingest a valid failure snapshot with 202 Accepted", async () => {
      const snapshot = {
        idempotencyKey: uniqueKey,
        source: "api-test",
        queueName: "order-queue",
        jobId: "12345",
        jobName: "process-order",
        payloadSnapshot: { amount: 500 },
        errorMessage: "Twilio Error 20429",
        attemptsMade: 3,
        configuredAttempts: 3,
      };

      const res = await request(app)
        .post("/api/incidents/ingest")
        .send(snapshot);

      expect(res.status).toBe(202);
      expect(res.body.received).toBe(true);
      expect(res.body.incidentId).toBeDefined();
      expect(res.body.isDuplicate).toBe(false);

      createdIncidentId = res.body.incidentId;
    });

    it("should return isDuplicate: true when identical idempotencyKey is posted", async () => {
      const snapshot = {
        idempotencyKey: uniqueKey,
        source: "api-test",
        queueName: "order-queue",
        jobId: "12345",
        jobName: "process-order",
        payloadSnapshot: { amount: 500 },
        errorMessage: "Twilio Error 20429",
        attemptsMade: 3,
        configuredAttempts: 3,
      };

      const res = await request(app)
        .post("/api/incidents/ingest")
        .send(snapshot);

      expect(res.status).toBe(202);
      expect(res.body.received).toBe(true);
      expect(res.body.isDuplicate).toBe(true);
    });

    it("should return 400 Bad Request if required fields are missing", async () => {
      const invalidSnapshot = {
        // missing idempotencyKey, queueName, errorMessage, etc.
        source: "api-test",
      };

      const res = await request(app)
        .post("/api/incidents/ingest")
        .send(invalidSnapshot);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toBeInstanceOf(Array);
    });
  });

  describe("GET /api/incidents", () => {
    it("should return paginated list of incidents", async () => {
      const res = await request(app).get("/api/incidents?page=1&limit=5");

      expect(res.status).toBe(200);
      expect(res.body.items).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(5);
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it("should filter by status", async () => {
      const res = await request(app).get("/api/incidents?status=INGESTED");

      expect(res.status).toBe(200);
      res.body.items.forEach((item: any) => {
        expect(item.status).toBe("INGESTED");
      });
    });
  });

  describe("GET /api/incidents/:id", () => {
    it("should return 200 with full incident details for valid ID", async () => {
      const res = await request(app).get(`/api/incidents/${createdIncidentId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createdIncidentId);
      expect(res.body.errorMessage).toBe("Twilio Error 20429");
      expect(res.body.auditLogs).toBeInstanceOf(Array);
    });

    it("should return 404 for non-existent incident ID", async () => {
      const res = await request(app).get("/api/incidents/non-existent-uuid");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /api/incidents/:id/history", () => {
    it("should return audit history for incident", async () => {
      const res = await request(app).get(
        `/api/incidents/${createdIncidentId}/history`
      );

      expect(res.status).toBe(200);
      expect(res.body.incidentId).toBe(createdIncidentId);
      expect(res.body.history.length).toBeGreaterThanOrEqual(1);
      expect(res.body.history[0].action).toBe("FAILURE_CAPTURED");
    });
  });
});
