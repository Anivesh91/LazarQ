import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { metricsService } from "../src/services/metrics.service";

describe("Day 14: Operational Metrics & Auth Middleware", () => {
  it("should calculate genuine operational metrics directly from PostgreSQL", async () => {
    const res = await request(app).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(typeof res.body.totalIncidents).toBe("number");
    expect(res.body.statusCounts).toBeDefined();
    expect(typeof res.body.resolutionRatePercent).toBe("number");
    expect(typeof res.body.quarantineRatePercent).toBe("number");
    expect(typeof res.body.runbookMatchRatePercent).toBe("number");
    expect(typeof res.body.totalRunbooks).toBe("number");
  });

  it("should reject unauthorized requests with 401 when ENGINE_API_KEY is configured", async () => {
    // Enable auth testing
    process.env.TEST_AUTH_ENABLED = "true";
    process.env.ENGINE_API_KEY = "secret-super-key-999";

    try {
      // 1. Request without key should be rejected
      const unauthRes = await request(app).get("/api/incidents");
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.body.code).toBe("UNAUTHORIZED");

      // 2. Request with correct x-api-key should pass
      const authRes = await request(app)
        .get("/api/incidents")
        .set("x-api-key", "secret-super-key-999");
      expect(authRes.status).toBe(200);
    } finally {
      delete process.env.TEST_AUTH_ENABLED;
      delete process.env.ENGINE_API_KEY;
    }
  });
});
