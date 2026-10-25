import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Queue, Worker, Job } from "bullmq";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/config/redis";
import { incidentService } from "../src/services/incident.service";
import { triageService } from "../src/services/triage.service";
import { validationService } from "../src/services/validation.service";
import { replayService } from "../src/services/replay.service";
import { replayResultObserver } from "../src/workers/replay-result.worker";
import { queueReinjector } from "../src/replay/reinjector";
import { runbookService } from "../src/services/runbook.service";

describe("Day 15: End-to-End Self-Healing Scenarios", () => {
  const createdIncidentIds: string[] = [];
  const createdRunbookIds: string[] = [];
  let e2eWorker: Worker | null = null;
  const testQueueName = "e2e-order-queue";

  beforeAll(async () => {
    // Ensure the Twilio remediation runbook is present
    const existing = await prisma.runbook.findFirst({
      where: { title: "Twilio SMS Rate Limit (Error 20429) Remediation" },
    });

    if (!existing) {
      const created = await runbookService.createRunbook({
        title: "Twilio SMS Rate Limit (Error 20429) Remediation",
        tags: ["twilio", "rate-limit", "sms", "notification"],
        content: `# Twilio SMS Rate Limit (Error 20429) Remediation
## Remediation Strategy
If SMS rate limited, mutate channel to EMAIL and retry immediately.`,
      });
      createdRunbookIds.push(created.id);
    }
  });

  afterAll(async () => {
    if (e2eWorker) {
      await e2eWorker.close();
    }
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
    if (createdRunbookIds.length > 0) {
      await prisma.runbook.deleteMany({
        where: { id: { in: createdRunbookIds } },
      });
    }
    await replayResultObserver.closeAll();
    await queueReinjector.closeAll();
    await prisma.$disconnect();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SCENARIO A: Happy Path Full Self-Healing Loop
  // Terminal failure -> RAG runbook match -> AI triage (RETRY or MUTATE_AND_RETRY) ->
  // 5-Stage validation gate -> Approval -> Replay -> Worker succeeds -> RESOLVED
  // ────────────────────────────────────────────────────────────────────────────
  it("Scenario A: Rate limit failure -> RAG match -> AI repair -> Validation Pass -> Approve -> Worker Success -> RESOLVED", async () => {
    const ts = Date.now();
    const originalPayload = {
      orderId: `ORD-E2E-${ts}`,
      userId: `USR-E2E-${ts}`,
      amount: 2500,
      currency: "USD",
      channel: "SMS",
    };

    // 1. Ingest terminal failure snapshot into PostgreSQL
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `e2e:scenario-a:${ts}`,
      source: "e2e-test-suite",
      queueName: testQueueName,
      jobId: `job-e2e-${ts}`,
      jobName: "process-order",
      payloadSnapshot: originalPayload,
      errorMessage: "Twilio Error 20429: Rate limit exceeded on SMS gateway",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    expect(ingest.incident.status).toBe("INGESTED");

    // 2. AI Doctor triage (RAG lookup + LLM structured repair)
    const triageResult = await triageService.diagnoseIncident(ingest.incident.id);
    expect(triageResult.status).toBe("PROPOSAL_READY");
    expect(triageResult.proposal).toBeDefined();
    expect(["MUTATE_AND_RETRY", "RETRY"]).toContain(triageResult.proposal?.action);

    // Ensure proposedPayload has fallback channel if mutated or intact if RETRY
    if (triageResult.proposal?.action === "MUTATE_AND_RETRY") {
      expect(triageResult.proposedPayload).toBeDefined();
    }

    // 3. 5-Stage Deterministic Validation Gate
    const validationResult = await validationService.validateProposal(ingest.incident.id);
    expect(validationResult.status).toBe("AWAITING_APPROVAL");
    expect(validationResult.validation.passed).toBe(true);

    // Verify invariants: orderId, userId, amount must not change
    const updatedRecord = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
    });
    const verifiedProposal = (updatedRecord?.proposedPayload || originalPayload) as Record<string, any>;
    expect(verifiedProposal.orderId).toBe(originalPayload.orderId);
    expect(verifiedProposal.userId).toBe(originalPayload.userId);
    expect(verifiedProposal.amount).toBe(originalPayload.amount);

    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        aiDiagnosis: {
          ...((updatedRecord?.aiDiagnosis as Record<string, any>) || {}),
          delaySeconds: 0,
        },
      },
    });

    // 4. Setup mock BullMQ Worker on the target queue
    e2eWorker = new Worker(
      testQueueName,
      async (job: Job) => {
        return { success: true, processedAt: new Date().toISOString() };
      },
      { connection: redis }
    );

    // 5. Approve incident via Replay Service (or HTTP endpoint)
    const replayResult = await replayService.approveIncident(ingest.incident.id, {
      approvedBy: "e2e-tester",
      autoReplay: true,
    });

    expect(replayResult.incident.status).toBe("REPLAYING");
    expect(replayResult.recoveryAttempt.status).toBe("IN_PROGRESS");

    // 6. Wait for the worker and real QueueEvents observer to persist completion.
    let finalIncident = null;
    const resolutionDeadline = Date.now() + 10_000;
    while (Date.now() < resolutionDeadline) {
      finalIncident = await prisma.incident.findUnique({
        where: { id: ingest.incident.id },
        include: { recoveryAttempts: true, auditLogs: true },
      });
      if (finalIncident?.status === "RESOLVED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 7. Verify final incident status is RESOLVED
    expect(finalIncident?.status).toBe("RESOLVED");
    expect(finalIncident?.recoveryAttempts[0].status).toBe("COMPLETED");

    // Verify complete audit log trajectory
    const actions = finalIncident?.auditLogs.map((a) => a.action);
    expect(actions).toContain("FAILURE_CAPTURED");
    expect(actions).toContain("RAG_MATCHED");
    expect(actions).toContain("PROPOSAL_READY");
    expect(actions).toContain("AWAITING_APPROVAL");
    expect(actions).toContain("RECOVERY_APPROVED");
    expect(actions).toContain("RECOVERY_RESOLVED");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SCENARIO B: Validation Gate Invariant Violation Rejection
  // Malformed / Adversarial LLM proposal mutates immutable field (e.g. amount) ->
  // Stage 2 Invariant Checker intercepts -> SANDBOX_FAILED / QUARANTINED
  // ────────────────────────────────────────────────────────────────────────────
  it("Scenario B: Malformed proposal alters immutable field -> Gate intercepts -> SANDBOX_FAILED -> No replay", async () => {
    const ts = Date.now();
    const originalPayload = {
      orderId: `ORD-TAMPER-${ts}`,
      userId: `USR-TAMPER-${ts}`,
      amount: 9999, // Immutable monetary value
      currency: "EUR",
      channel: "SMS",
    };

    // 1. Ingest incident
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `e2e:scenario-b:${ts}`,
      source: "e2e-test-suite",
      queueName: testQueueName,
      jobId: `job-tamper-${ts}`,
      jobName: "process-order",
      payloadSnapshot: originalPayload,
      errorMessage: "Twilio Error 20429: Rate limit exceeded",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    // 2. Inject an adversarial proposed payload that tampers with amount
    const maliciousProposedPayload = {
      ...originalPayload,
      amount: 10, // Tampered from 9999 to 10!
      channel: "EMAIL",
    };

    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: {
        status: "PROPOSAL_READY",
        proposedPayload: maliciousProposedPayload,
        aiDiagnosis: {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.99,
          mutations: [{ field: "amount", from: 9999, to: 10 }],
        },
      },
    });

    // 3. Run through 5-Stage Validation Gate
    const validationResult = await validationService.validateProposal(ingest.incident.id);

    // Invariant Stage 2 MUST fail
    expect(validationResult.validation.passed).toBe(false);
    expect(validationResult.status).toBe("SANDBOX_FAILED");
    expect(validationResult.validation.failedStage).toBe(2);
    expect(validationResult.validation.rejectionReason).toContain("amount");

    // 4. Attempting to approve must fail because incident is in SANDBOX_FAILED status
    await expect(
      replayService.approveIncident(ingest.incident.id)
    ).rejects.toThrowError(/SANDBOX_FAILED|safety invariant guard/);

    // Verify incident was never queued for replay
    const incidentState = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
      include: { recoveryAttempts: true },
    });
    expect(incidentState?.status).toBe("SANDBOX_FAILED");
    expect(incidentState?.recoveryAttempts).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SCENARIO C: Unknown Error Fast Quarantine & No Cascading Replay Loop
  // Unresolvable error without valid SOP -> Triage prescribes QUARANTINED -> Zero cascading loops
  // ────────────────────────────────────────────────────────────────────────────
  it("Scenario C: Unknown error without runbook -> System quarantines safely -> Zero cascading loops", async () => {
    const ts = Date.now();
    const weirdPayload = {
      alienId: "ZOG-99",
      entropyLevel: 42,
    };

    // 1. Ingest incident with totally bizarre error
    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `e2e:scenario-c:${ts}`,
      source: "e2e-test-suite",
      queueName: testQueueName,
      jobId: `job-alien-${ts}`,
      jobName: "alien-telemetry",
      payloadSnapshot: weirdPayload,
      errorMessage: "UnrecoverableQuantumFluxException: Quantum phase shift destabilized in subatomic chamber 0x9F",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    // 2. Diagnose incident
    const triageResult = await triageService.diagnoseIncident(ingest.incident.id);

    // Must be quarantined (either via RAG similarity gate or AI safety directive)
    expect(triageResult.status).toBe("QUARANTINED");
    if (triageResult.proposal) {
      expect(triageResult.proposal.action).toBe("QUARANTINE");
    }

    // 3. Verify database state
    const incidentState = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
      include: { recoveryAttempts: true, auditLogs: true },
    });

    expect(incidentState?.status).toBe("QUARANTINED");
    expect(incidentState?.recoveryAttempts).toHaveLength(0);

    const auditActions = incidentState?.auditLogs.map((l) => l.action);
    expect(auditActions).toContain("QUARANTINED");
    expect(auditActions).not.toContain("RECOVERY_APPROVED");
  });
});
