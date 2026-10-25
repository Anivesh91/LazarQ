import { createHash } from "crypto";
import { redis } from "../config/redis";
import { logger } from "../config/logger";

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold?: number; // Failures needed within window to trip (default: 50)
  windowMs?: number;         // Time window for counting failures (default: 60s)
  coolOffMs?: number;        // Time before testing recovery in HALF_OPEN (default: 30s)
}

export interface BreakerStatus {
  fingerprint: string;
  state: BreakerState;
  failureCount: number;
  lastFailureTime: number;
  trippedAt?: number;
  coolOffRemainingMs: number;
}

export class CircuitBreakerService {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly coolOffMs: number;

  // In-memory state tracking
  private breakers = new Map<
    string,
    {
      state: BreakerState;
      failureTimestamps: number[];
      trippedAt?: number;
      trialInFlight: boolean;
    }
  >();

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? 50;
    this.windowMs = config?.windowMs ?? 60_000;
    this.coolOffMs = config?.coolOffMs ?? 30_000;
  }

  /**
   * Generates a deterministic normalized error fingerprint.
   * Strips dynamic tokens (UUIDs, timestamps, IDs) so identical failure root causes share a single breaker.
   */
  getFingerprint(queueName: string, errorMessage: string): string {
    const normalized = (errorMessage || "unknown_error")
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID]")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gi, "[DATE]")
      .replace(/\b\d+\b/g, "[NUM]")
      .replace(/\s+/g, " ")
      .trim();

    return createHash("sha256")
      .update(`${queueName.trim().toLowerCase()}:${normalized}`)
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Checks whether the circuit breaker permits automated processing for this failure signature.
   */
  canProcess(fingerprint: string): {
    allowed: boolean;
    state: BreakerState;
    reason?: string;
  } {
    const breaker = this.breakers.get(fingerprint);

    if (!breaker || breaker.state === "CLOSED") {
      return { allowed: true, state: "CLOSED" };
    }

    const now = Date.now();

    if (breaker.state === "OPEN") {
      const elapsedSinceTrip = now - (breaker.trippedAt || 0);

      // Check if cool-off period has passed
      if (elapsedSinceTrip >= this.coolOffMs) {
        logger.info(
          { fingerprint, elapsedSinceTrip, coolOffMs: this.coolOffMs },
          "[Circuit Breaker] Cool-off period elapsed; transitioning to HALF_OPEN for trial execution"
        );
        breaker.state = "HALF_OPEN";
        breaker.trialInFlight = true;
        return { allowed: true, state: "HALF_OPEN" };
      }

      const remainingSec = Math.ceil((this.coolOffMs - elapsedSinceTrip) / 1000);
      return {
        allowed: false,
        state: "OPEN",
        reason: `Circuit breaker is OPEN. Failure storm detected. Automated triage paused (${remainingSec}s cool-off remaining).`,
      };
    }

    if (breaker.state === "HALF_OPEN") {
      // In HALF_OPEN, allow a single trial execution
      if (!breaker.trialInFlight) {
        breaker.trialInFlight = true;
        return { allowed: true, state: "HALF_OPEN" };
      }
      return {
        allowed: false,
        state: "HALF_OPEN",
        reason: "Circuit breaker is in HALF_OPEN trial mode. Processing throttled.",
      };
    }

    return { allowed: true, state: "CLOSED" };
  }

  /**
   * Records a terminal failure occurrence for the given fingerprint.
   * Trips the breaker to OPEN if failures exceed the threshold within the sliding window.
   */
  recordFailure(fingerprint: string): { state: BreakerState; count: number; tripped: boolean } {
    const now = Date.now();
    let breaker = this.breakers.get(fingerprint);

    if (!breaker) {
      breaker = {
        state: "CLOSED",
        failureTimestamps: [],
        trialInFlight: false,
      };
      this.breakers.set(fingerprint, breaker);
    }

    // If trial execution in HALF_OPEN fails, immediately trip back to OPEN
    if (breaker.state === "HALF_OPEN") {
      breaker.state = "OPEN";
      breaker.trippedAt = now;
      breaker.trialInFlight = false;
      logger.warn({ fingerprint }, "[Circuit Breaker] Trial execution failed in HALF_OPEN; re-tripping to OPEN");
      return { state: "OPEN", count: breaker.failureTimestamps.length, tripped: true };
    }

    // Filter out timestamps outside sliding window
    breaker.failureTimestamps = breaker.failureTimestamps.filter(
      (ts) => now - ts <= this.windowMs
    );
    breaker.failureTimestamps.push(now);

    const count = breaker.failureTimestamps.length;

    if (count >= this.failureThreshold && breaker.state === "CLOSED") {
      breaker.state = "OPEN";
      breaker.trippedAt = now;
      breaker.trialInFlight = false;

      logger.warn(
        {
          fingerprint,
          failuresInWindow: count,
          threshold: this.failureThreshold,
          windowSeconds: this.windowMs / 1000,
        },
        "🚨 [Circuit Breaker] Tripped to OPEN! Rate limit / retry storm guard activated."
      );

      return { state: "OPEN", count, tripped: true };
    }

    return { state: breaker.state, count, tripped: false };
  }

  /**
   * Records a successful execution for the given fingerprint.
   * If in HALF_OPEN, resets the breaker back to CLOSED.
   */
  recordSuccess(fingerprint: string): { state: BreakerState } {
    const breaker = this.breakers.get(fingerprint);
    if (!breaker) return { state: "CLOSED" };

    if (breaker.state === "HALF_OPEN") {
      breaker.state = "CLOSED";
      breaker.failureTimestamps = [];
      breaker.trippedAt = undefined;
      breaker.trialInFlight = false;

      logger.info(
        { fingerprint },
        "[Circuit Breaker] Trial execution succeeded; reset circuit to CLOSED"
      );
    }

    return { state: breaker.state };
  }

  /**
   * Manually resets a specific breaker or all breakers back to CLOSED.
   */
  reset(fingerprint?: string): void {
    if (fingerprint) {
      this.breakers.delete(fingerprint);
      logger.info({ fingerprint }, "[Circuit Breaker] Manually reset circuit breaker");
    } else {
      this.breakers.clear();
      logger.info("[Circuit Breaker] Manually reset all circuit breakers");
    }
  }

  /**
   * Returns a snapshot of all active circuit breakers for operations and dashboard.
   */
  getAllStatuses(): BreakerStatus[] {
    const now = Date.now();
    const statuses: BreakerStatus[] = [];

    for (const [fingerprint, b] of this.breakers.entries()) {
      const activeFailures = b.failureTimestamps.filter((ts) => now - ts <= this.windowMs);
      const elapsedSinceTrip = b.trippedAt ? now - b.trippedAt : 0;
      const coolOffRemainingMs =
        b.state === "OPEN" ? Math.max(0, this.coolOffMs - elapsedSinceTrip) : 0;

      statuses.push({
        fingerprint,
        state: b.state,
        failureCount: activeFailures.length,
        lastFailureTime: b.failureTimestamps[b.failureTimestamps.length - 1] || 0,
        trippedAt: b.trippedAt,
        coolOffRemainingMs,
      });
    }

    return statuses;
  }
}

export const circuitBreakerService = new CircuitBreakerService();
