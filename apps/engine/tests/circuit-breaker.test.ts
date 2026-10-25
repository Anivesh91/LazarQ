import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import {
  CircuitBreakerService,
  circuitBreakerService,
} from "../src/services/circuit-breaker.service";

describe("Day 10: Circuit Breaker & Rate Limiter", () => {
  beforeEach(() => {
    circuitBreakerService.reset();
  });

  describe("Fingerprint Generation", () => {
    it("should normalize dynamic numbers, UUIDs, and timestamps to produce identical fingerprints", () => {
      const service = new CircuitBreakerService();

      const fp1 = service.getFingerprint(
        "order-queue",
        "Twilio Error 20429: Rate limit exceeded for phone 9876543210 at 2026-10-25T14:30:00Z"
      );
      const fp2 = service.getFingerprint(
        "order-queue",
        "Twilio Error 20429: Rate limit exceeded for phone 1234567890 at 2026-10-25T15:00:00Z"
      );

      expect(fp1).toBe(fp2);
    });

    it("should produce different fingerprints for different error causes or queues", () => {
      const service = new CircuitBreakerService();

      const fpTwilio = service.getFingerprint("order-queue", "Twilio Error 20429: Rate limit");
      const fpTimeout = service.getFingerprint("order-queue", "PostgreSQL pool connection timeout");
      const fpOtherQueue = service.getFingerprint("payment-queue", "Twilio Error 20429: Rate limit");

      expect(fpTwilio).not.toBe(fpTimeout);
      expect(fpTwilio).not.toBe(fpOtherQueue);
    });
  });

  describe("State Transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)", () => {
    it("should remain CLOSED when failure count is below threshold", () => {
      // Breaker with threshold = 3, window = 10s
      const service = new CircuitBreakerService({ failureThreshold: 3, windowMs: 10_000 });
      const fp = "test-fp-1";

      service.recordFailure(fp);
      service.recordFailure(fp);

      const decision = service.canProcess(fp);
      expect(decision.allowed).toBe(true);
      expect(decision.state).toBe("CLOSED");
    });

    it("should trip to OPEN when failure count reaches threshold", () => {
      const service = new CircuitBreakerService({ failureThreshold: 3, windowMs: 10_000 });
      const fp = "test-fp-2";

      service.recordFailure(fp);
      service.recordFailure(fp);
      const tripResult = service.recordFailure(fp); // 3rd failure

      expect(tripResult.tripped).toBe(true);
      expect(tripResult.state).toBe("OPEN");

      const decision = service.canProcess(fp);
      expect(decision.allowed).toBe(false);
      expect(decision.state).toBe("OPEN");
      expect(decision.reason).toContain("Circuit breaker is OPEN");
    });

    it("should transition to HALF_OPEN after coolOffMs and allow a trial request", async () => {
      // Breaker with 50ms coolOff
      const service = new CircuitBreakerService({
        failureThreshold: 2,
        windowMs: 5_000,
        coolOffMs: 50,
      });
      const fp = "test-fp-3";

      service.recordFailure(fp);
      service.recordFailure(fp); // Trips to OPEN

      expect(service.canProcess(fp).state).toBe("OPEN");

      // Wait for coolOff to expire
      await new Promise((r) => setTimeout(r, 60));

      // First check should transition to HALF_OPEN and permit trial
      const trialDecision = service.canProcess(fp);
      expect(trialDecision.allowed).toBe(true);
      expect(trialDecision.state).toBe("HALF_OPEN");

      // Second check while trial is in flight should throttle
      const throttledDecision = service.canProcess(fp);
      expect(throttledDecision.allowed).toBe(false);
      expect(throttledDecision.state).toBe("HALF_OPEN");

      // Trial succeeds -> resets to CLOSED
      service.recordSuccess(fp);
      expect(service.canProcess(fp).state).toBe("CLOSED");
      expect(service.canProcess(fp).allowed).toBe(true);
    });

    it("should re-trip to OPEN if trial request in HALF_OPEN fails", async () => {
      const service = new CircuitBreakerService({
        failureThreshold: 2,
        windowMs: 5_000,
        coolOffMs: 40,
      });
      const fp = "test-fp-4";

      service.recordFailure(fp);
      service.recordFailure(fp); // OPEN

      await new Promise((r) => setTimeout(r, 50));
      expect(service.canProcess(fp).state).toBe("HALF_OPEN");

      // Trial failed!
      service.recordFailure(fp);
      expect(service.canProcess(fp).state).toBe("OPEN");
      expect(service.canProcess(fp).allowed).toBe(false);
    });
  });

  describe("Manual Reset & Operations API", () => {
    it("should allow manual reset of active breakers", () => {
      const service = new CircuitBreakerService({ failureThreshold: 2 });
      const fp = "test-fp-reset";

      service.recordFailure(fp);
      service.recordFailure(fp);
      expect(service.canProcess(fp).state).toBe("OPEN");

      service.reset(fp);
      expect(service.canProcess(fp).state).toBe("CLOSED");
      expect(service.canProcess(fp).allowed).toBe(true);
    });

    it("should return breaker status list via GET /api/circuit-breaker", async () => {
      const fp = circuitBreakerService.getFingerprint("order-queue", "Simulated Rate Limit Error");

      // Trip the singleton breaker by recording failures
      for (let i = 0; i < 55; i++) {
        circuitBreakerService.recordFailure(fp);
      }

      const res = await request(app).get("/api/circuit-breaker");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalBreakers).toBeGreaterThanOrEqual(1);
      expect(res.body.openBreakers).toBeGreaterThanOrEqual(1);

      const found = res.body.breakers.find((b: any) => b.fingerprint === fp);
      expect(found).toBeDefined();
      expect(found.state).toBe("OPEN");
    });

    it("should reset breakers via POST /api/circuit-breaker/reset", async () => {
      const fp = circuitBreakerService.getFingerprint("order-queue", "Some Other Error");
      for (let i = 0; i < 55; i++) {
        circuitBreakerService.recordFailure(fp);
      }

      expect(circuitBreakerService.canProcess(fp).state).toBe("OPEN");

      const res = await request(app)
        .post("/api/circuit-breaker/reset")
        .send({ fingerprint: fp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(circuitBreakerService.canProcess(fp).state).toBe("CLOSED");
    });
  });
});
