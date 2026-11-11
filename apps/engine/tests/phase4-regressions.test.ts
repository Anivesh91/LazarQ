import http from "http";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { Queue } from "bullmq";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/config/redis";
import { assertProductionSecurityConfig } from "../src/config/env";
import { apiKeyAuth } from "../src/middleware/auth.middleware";
import { circuitBreakerService } from "../src/services/circuit-breaker.service";
import { intakeQueueService } from "../src/services/intake-queue.service";
import { eventBroadcaster } from "../src/services/event-broadcaster.service";
import { ragService } from "../src/services/rag.service";
import { llmService } from "../src/services/llm.service";
import { triageService } from "../src/services/triage.service";
import { validationService } from "../src/services/validation.service";
import { incidentService } from "../src/services/incident.service";
import {
  handleHealerJob,
  startHealerWorker,
  stopHealerWorker,
} from "../src/workers/healer.worker";
import { replayResultObserver } from "../src/workers/replay-result.worker";

describe("Phase 4 Regressions (B17, B18, B19, B20)", () => {
  const createdIncidentIds: string[] = [];
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.ENGINE_API_KEY;
  const originalTestAuth = process.env.TEST_AUTH_ENABLED;
  const originalIntakeQueue = process.env.INTAKE_QUEUE_NAME;
  const originalLlmProvider = process.env.LLM_PROVIDER;
  const originalEmbeddingProvider = process.env.EMBEDDING_PROVIDER;

  beforeEach(() => {
    circuitBreakerService.reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKey === undefined) {
      delete process.env.ENGINE_API_KEY;
    } else {
      process.env.ENGINE_API_KEY = originalApiKey;
    }
    if (originalTestAuth === undefined) {
      delete process.env.TEST_AUTH_ENABLED;
    } else {
      process.env.TEST_AUTH_ENABLED = originalTestAuth;
    }
    if (originalIntakeQueue === undefined) {
      delete process.env.INTAKE_QUEUE_NAME;
    } else {
      process.env.INTAKE_QUEUE_NAME = originalIntakeQueue;
    }
    if (originalLlmProvider === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalLlmProvider;
    }
    if (originalEmbeddingProvider === undefined) {
      delete process.env.EMBEDDING_PROVIDER;
    } else {
      process.env.EMBEDDING_PROVIDER = originalEmbeddingProvider;
    }
    await stopHealerWorker();
    await intakeQueueService.closeAll();
  });

  afterAll(async () => {
    if (createdIncidentIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { incidentId: { in: createdIncidentIds } },
      });
      await prisma.recoveryAttempt.deleteMany({
        where: { incidentId: { in: createdIncidentIds } },
      });
      await prisma.incident.deleteMany({
        where: { id: { in: createdIncidentIds } },
      });
    }
    eventBroadcaster.closeAll();
    await replayResultObserver.closeAll();
    await prisma.$disconnect();
  });

  describe("B17: Circuit breaker HALF_OPEN edge cases", () => {
    const sampleSnapshot = {
      idempotencyKey: `b17:snap:${Date.now()}`,
      source: "b17-test",
      queueName: "order-queue",
      jobId: "job-b17",
      jobName: "process-order",
      payloadSnapshot: { orderId: "ORD-B17" },
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
      occurredAt: new Date().toISOString(),
    };

    it("re-trips HALF_OPEN back to OPEN when trial yields QUARANTINED or SANDBOX_FAILED", async () => {
      const fp = circuitBreakerService.getFingerprint(
        sampleSnapshot.queueName,
        sampleSnapshot.errorMessage
      );

      for (const trialOutcome of ["QUARANTINED", "SANDBOX_FAILED"] as const) {
        circuitBreakerService.reset();
        const ts = Date.now();
        const inc = await prisma.incident.create({
          data: {
            idempotencyKey: `b17:retrip:${trialOutcome}:${ts}`,
            sourceId: "b17-test",
            queueName: sampleSnapshot.queueName,
            jobId: `job-retrip-${trialOutcome}-${ts}`,
            jobName: sampleSnapshot.jobName,
            payloadSnapshot: sampleSnapshot.payloadSnapshot,
            errorMessage: sampleSnapshot.errorMessage,
            attemptsMade: 3,
            configuredAttempts: 3,
            status: "INGESTED",
          },
        });
        createdIncidentIds.push(inc.id);

        (circuitBreakerService as any).breakers.set(fp, {
          state: "OPEN",
          failureTimestamps: [Date.now() - 40_000],
          trippedAt: Date.now() - 40_000,
          trialInFlight: false,
        });

        vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
          isDuplicate: true,
          incident: { ...inc, encryptedExecutionPayload: undefined } as any,
        });

        if (trialOutcome === "QUARANTINED") {
          vi.spyOn(triageService, "diagnoseIncident").mockResolvedValue({
            incidentId: inc.id,
            status: "QUARANTINED",
            proposal: null,
            proposedPayload: null,
          });
        } else {
          vi.spyOn(triageService, "diagnoseIncident").mockResolvedValue({
            incidentId: inc.id,
            status: "PROPOSAL_READY",
            proposal: {} as any,
            proposedPayload: { orderId: "ORD-B17" },
          });
          vi.spyOn(validationService, "validateProposal").mockResolvedValue({
            incidentId: inc.id,
            status: "SANDBOX_FAILED",
            validation: { passed: false, stages: [], failedStage: 2 } as any,
          });
        }

        const outcome = await handleHealerJob({ id: `job-${trialOutcome}`, data: sampleSnapshot });
        expect(outcome.status).toBe(trialOutcome);
        expect(circuitBreakerService.canProcess(fp).state).toBe("OPEN");
        vi.restoreAllMocks();
      }
    });

    it("releases inconclusive HALF_OPEN trial lock on 409 concurrency conflict without wedging breaker", async () => {
      const fp = circuitBreakerService.getFingerprint(
        sampleSnapshot.queueName,
        sampleSnapshot.errorMessage
      );
      const ts = Date.now();
      const inc = await prisma.incident.create({
        data: {
          idempotencyKey: `b17:409:${ts}`,
          sourceId: "b17-test",
          queueName: sampleSnapshot.queueName,
          jobId: `job-409-${ts}`,
          jobName: sampleSnapshot.jobName,
          payloadSnapshot: sampleSnapshot.payloadSnapshot,
          errorMessage: sampleSnapshot.errorMessage,
          attemptsMade: 3,
          configuredAttempts: 3,
          status: "REPLAYING",
        },
      });
      createdIncidentIds.push(inc.id);

      (circuitBreakerService as any).breakers.set(fp, {
        state: "OPEN",
        failureTimestamps: [Date.now() - 40_000],
        trippedAt: Date.now() - 40_000,
        trialInFlight: false,
      });

      // Simulate stale read returning INGESTED while DB row is already REPLAYING
      vi.spyOn(incidentService, "ingestSnapshot").mockResolvedValue({
        isDuplicate: true,
        incident: { ...inc, status: "INGESTED", fingerprint: null } as any,
      });

      const outcome = await handleHealerJob({ id: "job-409", data: sampleSnapshot });
      expect(outcome.status).toBe("REPLAYING");

      // Subsequent trial should NOT be throttled permanently
      const nextDecision = circuitBreakerService.canProcess(fp);
      expect(nextDecision).toEqual({ allowed: true, state: "HALF_OPEN" });
    });

    it("counts failed replay outcomes against the circuit breaker on handleJobFailed", async () => {
      const fp = "fp-b17-replay-fail";
      (circuitBreakerService as any).breakers.set(fp, {
        state: "HALF_OPEN",
        failureTimestamps: [Date.now() - 40_000],
        trippedAt: Date.now() - 40_000,
        trialInFlight: true,
      });

      const ts = Date.now();
      const inc = await prisma.incident.create({
        data: {
          idempotencyKey: `b17:replayfail:${ts}`,
          sourceId: "b17-test",
          queueName: "order-queue",
          jobId: `job-replayfail-${ts}`,
          jobName: "process-order",
          payloadSnapshot: { orderId: "ORD-B17-FAIL" },
          errorMessage: "Twilio Error 20429",
          attemptsMade: 3,
          configuredAttempts: 3,
          status: "REPLAYING",
          fingerprint: fp,
        },
      });
      createdIncidentIds.push(inc.id);

      const attempt = await prisma.recoveryAttempt.create({
        data: {
          incidentId: inc.id,
          proposedPayload: { orderId: "ORD-B17-FAIL" },
          status: "IN_PROGRESS",
        },
      });
      const replayJobId = `recovery-${attempt.id}`;
      await prisma.recoveryAttempt.update({
        where: { id: attempt.id },
        data: { replayJobId },
      });

      const handled = await replayResultObserver.handleJobFailed(
        "order-queue",
        replayJobId,
        "Downstream error"
      );

      expect(handled).toBe(true);
      expect(circuitBreakerService.canProcess(fp).state).toBe("OPEN");
    });
  });

  describe("B18: Engine fail-closed credentials in NODE_ENV=production", () => {
    it("rejects missing, blank, or dev-default ENGINE_API_KEY on startup and inside apiKeyAuth", () => {
      process.env.NODE_ENV = "production";
      delete process.env.TEST_AUTH_ENABLED;

      for (const badKey of [undefined, "", "   ", "dlq_dev_secret_key"]) {
        if (badKey === undefined) {
          delete process.env.ENGINE_API_KEY;
        } else {
          process.env.ENGINE_API_KEY = badKey;
        }

        expect(() => assertProductionSecurityConfig()).toThrowError(
          /ENGINE_API_KEY must be set to a non-default secret/
        );

        const next = vi.fn();
        expect(() =>
          apiKeyAuth(
            {
              path: "/api/incidents",
              headers: { "x-api-key": badKey || "dlq_dev_secret_key" },
            } as any,
            {} as any,
            next
          )
        ).toThrowError(/Unauthorized/);
        expect(next).not.toHaveBeenCalled();

        // /health probe remains permitted
        apiKeyAuth({ path: "/health", headers: {} } as any, {} as any, next);
        expect(next).toHaveBeenCalledTimes(1);
      }

      process.env.ENGINE_API_KEY = "prod_strong_key_9f8e7d6c5b4a";
      process.env.LLM_PROVIDER = "mock";
      process.env.EMBEDDING_PROVIDER = "mock";
      expect(() => assertProductionSecurityConfig()).not.toThrow();

      const validNext = vi.fn();
      apiKeyAuth(
        {
          path: "/api/incidents",
          headers: { "x-api-key": "prod_strong_key_9f8e7d6c5b4a" },
        } as any,
        {} as any,
        validNext
      );
      expect(validNext).toHaveBeenCalledTimes(1);
    });
  });

  describe("B19 & B20: HTTP ingest triggers healing worker pipeline & live SSE broadcasts", () => {
    it("enqueues POST /api/incidents/ingest onto intake queue, runs RAG->Triage->Validation, and streams incident:validated over SSE", async () => {
      const customIntake = `b19-intake-${Date.now()}`;
      process.env.INTAKE_QUEUE_NAME = customIntake;
      const intakeQueue = new Queue(customIntake, { connection: redis });

      // Start an actual HTTP server so we can open a real SSE client connection
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const sseController = new AbortController();
      const receivedEvents: Array<{ type: string; data: any }> = [];

      const sseReaderTask = (async () => {
        const res = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
          signal: sseController.signal,
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const eventMatch = frame.match(/^event:\s*(.+)$/m);
            const dataMatch = frame.match(/^data:\s*(.+)$/m);
            if (eventMatch && dataMatch) {
              const parsed = JSON.parse(dataMatch[1]);
              receivedEvents.push({ type: eventMatch[1].trim(), data: parsed.data });
            }
          }
        }
      })().catch(() => undefined);

      // Ensure at least one runbook row exists for matchedRunbookId FK!
      let tempRunbookId: string | null = null;
      let runbookRow = await prisma.runbook.findFirst({
        select: { id: true, title: true, content: true, tags: true },
      });
      if (!runbookRow) {
        const createdRb = await prisma.runbook.create({
          data: {
            title: `B19 Test Runbook ${Date.now()}`,
            content: "Fallback channel to EMAIL if email exists.",
            tags: ["twilio"],
          },
        });
        tempRunbookId = createdRb.id;
        runbookRow = {
          id: createdRb.id,
          title: createdRb.title,
          content: createdRb.content,
          tags: createdRb.tags,
        };
      }

      vi.spyOn(ragService, "findMatchingRunbooks").mockResolvedValue([
        {
          id: runbookRow.id,
          title: runbookRow.title,
          content: runbookRow.content,
          tags: runbookRow.tags,
          similarity: 0.92,
        },
      ]);
      vi.spyOn(llmService, "generateRepairProposal").mockResolvedValue({
        classification: "TRANSIENT",
        action: "MUTATE_AND_RETRY",
        confidence: 0.95,
        delaySeconds: 0,
        mutations: [
          {
            field: "channel",
            from: "SMS",
            to: "EMAIL",
            reason: "SMS rate limited; switch to EMAIL fallback",
          },
        ],
        rootCause: "Twilio SMS gateway 20429 rate limit",
        reasoning: "Recipient email is present so EMAIL fallback is valid",
      });

      try {
        // Wait until SSE handshake ('connected') is established
        const handshakeDeadline = Date.now() + 3000;
        while (
          !receivedEvents.some((e) => e.type === "connected") &&
          Date.now() < handshakeDeadline
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(receivedEvents.some((e) => e.type === "connected")).toBe(true);

        // Start healerWorker on custom intake queue
        startHealerWorker(customIntake);

        const ts = Date.now();
        const ingestRes = await request(app)
          .post("/api/incidents/ingest")
          .send({
            idempotencyKey: `b19:http:${ts}`,
            source: "b19-http-client",
            queueName: `b19-orders-${ts}`,
            jobId: `job-b19-${ts}`,
            jobName: "process-order",
            payloadSnapshot: {
              orderId: `ORD-B19-${ts}`,
              userId: "USR-B19",
              amount: 1500,
              currency: "USD",
              channel: "SMS",
              customerEmail: "b19@example.com",
            },
            errorMessage: "Twilio Error 20429: Rate limit exceeded",
            attemptsMade: 3,
            configuredAttempts: 3,
          });

        expect(ingestRes.status).toBe(202);
        expect(ingestRes.body.received).toBe(true);
        expect(ingestRes.body.queued).toBe(true);

        const incidentId = ingestRes.body.incidentId;
        createdIncidentIds.push(incidentId);

        // Wait for worker to drive incident through RAG -> Triage -> Stage 1-5 -> AWAITING_APPROVAL
        let finalRow = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          finalRow = await prisma.incident.findUnique({ where: { id: incidentId } });
          const hasValidatedEvent = receivedEvents.some(
            (e) =>
              e.type === "incident:validated" && e.data?.incidentId === incidentId
          );
          if (finalRow?.status === "AWAITING_APPROVAL" && hasValidatedEvent) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(finalRow?.status).toBe("AWAITING_APPROVAL");
        expect(finalRow?.fingerprint).toBeTruthy();

        const eventTypesForIncident = receivedEvents
          .filter(
            (e) =>
              e.data?.incidentId === incidentId ||
              e.data?.incident?.id === incidentId
          )
          .map((e) => e.type);

        expect(eventTypesForIncident).toContain("incident:new");
        expect(eventTypesForIncident).toContain("incident:analyzing");
        expect(eventTypesForIncident).toContain("incident:proposed");
        expect(eventTypesForIncident).toContain("incident:validated");

        const validatedEvent = receivedEvents.find(
          (e) => e.type === "incident:validated" && e.data?.incidentId === incidentId
        );
        expect(validatedEvent?.data).toMatchObject({
          incidentId,
          status: "AWAITING_APPROVAL",
          passed: true,
        });
      } finally {
        sseController.abort();
        await sseReaderTask;
        await stopHealerWorker();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await intakeQueue.obliterate({ force: true }).catch(() => undefined);
        await intakeQueue.close();
        if (tempRunbookId) {
          await prisma.runbook.delete({ where: { id: tempRunbookId } }).catch(() => undefined);
        }
      }
    });

    it("B20: broadcasts incident:quarantined when circuit breaker or RAG quarantines, and incident:validated on SANDBOX_FAILED", async () => {
      const broadcasted: Array<{ name: string; data: any }> = [];
      vi.spyOn(eventBroadcaster, "broadcast").mockImplementation((name, data) => {
        broadcasted.push({ name, data });
      });

      const ts = Date.now();

      // 1. Circuit breaker quarantine SSE event (real DB row, zero prisma spies)
      const openFp = circuitBreakerService.getFingerprint("b20-q", "Storm Error 429");
      (circuitBreakerService as any).breakers.set(openFp, {
        state: "OPEN",
        failureTimestamps: [Date.now()],
        trippedAt: Date.now(),
        trialInFlight: false,
      });

      const cbResult = await handleHealerJob({
        id: "job-cb-b20",
        data: {
          idempotencyKey: `b20:cb:${ts}`,
          source: "b20",
          queueName: "b20-q",
          jobId: `j1-${ts}`,
          jobName: "work",
          payloadSnapshot: {},
          errorMessage: "Storm Error 429",
          attemptsMade: 3,
          configuredAttempts: 3,
        },
      });
      createdIncidentIds.push(cbResult.incidentId);
      expect(cbResult.status).toBe("QUARANTINED");
      expect(broadcasted).toContainEqual(
        expect.objectContaining({
          name: "incident:quarantined",
          data: expect.objectContaining({
            incidentId: cbResult.incidentId,
            status: "QUARANTINED",
          }),
        })
      );

      // 2. SANDBOX_FAILED SSE event (real DB row, zero prisma spies)
      const sandboxFailInc = await prisma.incident.create({
        data: {
          idempotencyKey: `b20:sandboxfail:${ts}`,
          sourceId: "b20",
          queueName: "order-queue",
          jobId: `j2-${ts}`,
          jobName: "work",
          payloadSnapshot: { orderId: "ORD-1", amount: 500 },
          proposedPayload: { orderId: "ORD-1", amount: 1 }, // mutates immutable amount!
          errorMessage: "Twilio Error 20429",
          attemptsMade: 3,
          configuredAttempts: 3,
          status: "PROPOSAL_READY",
          aiDiagnosis: {
            classification: "TRANSIENT",
            action: "MUTATE_AND_RETRY",
            confidence: 0.9,
            mutations: [{ field: "amount", from: 500, to: 1 }],
            rootCause: "test",
            reasoning: "test",
          },
        },
      });
      createdIncidentIds.push(sandboxFailInc.id);

      const valResult = await validationService.validateProposal(sandboxFailInc.id);
      expect(valResult.status).toBe("SANDBOX_FAILED");
      expect(broadcasted).toContainEqual(
        expect.objectContaining({
          name: "incident:validated",
          data: expect.objectContaining({
            incidentId: sandboxFailInc.id,
            status: "SANDBOX_FAILED",
            passed: false,
            failedStage: 2,
          }),
        })
      );
    });
  });
});
