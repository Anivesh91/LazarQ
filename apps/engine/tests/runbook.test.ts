import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";

describe("Runbook Studio & API", () => {
  let createdRunbookId: string;

  afterAll(async () => {
    if (createdRunbookId) {
      await prisma.runbook.deleteMany({
        where: { id: createdRunbookId },
      });
    }
    await prisma.$disconnect();
  });

  describe("POST /api/runbooks", () => {
    it("should successfully create a new runbook with 201 Created", async () => {
      const payload = {
        title: "Test Runbook: Payment Gateway Timeout",
        content: "## Steps\n1. Replay after 5 seconds.\n2. If failed again, quarantine.",
        tags: ["payment", "gateway", "test"],
      };

      const res = await request(app).post("/api/runbooks").send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.title).toBe(payload.title);
      expect(res.body.data.tags).toEqual(payload.tags);

      createdRunbookId = res.body.data.id;
    });

    it("should reject creation with 400 when title or content is missing", async () => {
      const res = await request(app).post("/api/runbooks").send({
        title: "",
        content: "test",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("GET /api/runbooks", () => {
    it("should return a paginated list of runbooks", async () => {
      const res = await request(app).get("/api/runbooks?limit=10");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.limit).toBe(10);
    });

    it("should filter runbooks by tag", async () => {
      const res = await request(app).get("/api/runbooks?tag=payment");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("GET /api/runbooks/:id", () => {
    it("should return 200 and the runbook details for an existing ID", async () => {
      if (!createdRunbookId) return;

      const res = await request(app).get(`/api/runbooks/${createdRunbookId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdRunbookId);
    });

    it("should return 404 for a non-existent runbook ID", async () => {
      const res = await request(app).get("/api/runbooks/00000000-0000-0000-0000-000000000000");

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("PATCH /api/runbooks/:id", () => {
    it("should update runbook title and tags", async () => {
      if (!createdRunbookId) return;

      const res = await request(app)
        .patch(`/api/runbooks/${createdRunbookId}`)
        .send({
          title: "Test Runbook: Updated Payment Gateway",
          tags: ["payment", "updated"],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe("Test Runbook: Updated Payment Gateway");
      expect(res.body.data.tags).toEqual(["payment", "updated"]);
    });
  });

  describe("DELETE /api/runbooks/:id", () => {
    it("should delete the runbook with 200 OK", async () => {
      if (!createdRunbookId) return;

      const res = await request(app).delete(`/api/runbooks/${createdRunbookId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdRunbookId);

      // Verify it's gone
      const verifyRes = await request(app).get(`/api/runbooks/${createdRunbookId}`);
      expect(verifyRes.status).toBe(404);

      createdRunbookId = "";
    });
  });
});
