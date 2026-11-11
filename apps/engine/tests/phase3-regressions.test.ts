import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import { Queue } from "bullmq";
import { encryptReplayPayload } from "@dlq-healer/sdk";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/config/redis";
import { incidentService } from "../src/services/incident.service";
import { validationService } from "../src/services/validation.service";
import { replayService } from "../src/services/replay.service";
import { queueReinjector } from "../src/replay/reinjector";
import { intakeQueueService } from "../src/services/intake-queue.service";
import { replayResultObserver } from "../src/workers/replay-result.worker";
import { startHealerWorker, stopHealerWorker } from "../src/workers/healer.worker";

describe("Phase 3 Regressions (B11, B12, B16)", () => {
  const createdIncidentIds: string[] = [];
  const enqueuedIdempotencyKeys: string[] = [];
  const originalEncryptionKey = process.env.DLQ_PAYLOAD_ENCRYPTION_KEY;
  const originalIntakeQueue = process.env.INTAKE_QUEUE_NAME;

  afterEach(async () => {
    if (originalEncryptionKey === undefined) {
      delete process.env.DLQ_PAYLOAD_ENCRYPTION_KEY;
    } else {
      process.env.DLQ_PAYLOAD_ENCRYPTION_KEY = originalEncryptionKey;
    }
    if (originalIntakeQueue === undefined) {
      delete process.env.INTAKE_QUEUE_NAME;
    } else {
      process.env.INTAKE_QUEUE_NAME = originalIntakeQueue;
    }
    await stopHealerWorker();
  });

  afterAll(async () => {
    for (const key of enqueuedIdempotencyKeys) {
      await intakeQueueService.removeSnapshotJob(key).catch(() => undefined);
    }
    await intakeQueueService.closeAll();
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
    await replayResultObserver.closeAll();
    await queueReinjector.closeAll();
    await prisma.$disconnect();
  });

  it("B11: server-side defense-in-depth redacts raw secretApiKey, accessToken, email, and Bearer errors across DB, AuditLog, and REST API", async () => {
    const rawSecret = "custom_raw_api_secret_555";
    const rawEmail = "sensitive.user@example.com";
    const idempotencyKey = `b11:http:${Date.now()}`;
    enqueuedIdempotencyKeys.push(idempotencyKey);
    const res = await request(app)
      .post("/api/incidents/ingest")
      .send({
        idempotencyKey,
        source: "b11-test",
        queueName: "b11-queue",
        jobId: `job-b11-${Date.now()}`,
        jobName: "notify",
        payloadSnapshot: {
          orderId: "ORD-B11-SRV",
          secretApiKey: rawSecret,
          accessToken: "oauth_access_token_xyz",
          email: rawEmail,
        },
        errorMessage: `Webhook rejected for ${rawEmail} with key ${rawSecret} and Authorization: Bearer raw_bearer_999`,
        stackTrace: `Error: Auth failed for ${rawEmail} using postgres://app:dbSecret99@db.local:5432/app\n    at handler.ts:12`,
        attemptsMade: 3,
        configuredAttempts: 3,
      });

    expect(res.status).toBe(202);
    const incidentId = res.body.incidentId;
    createdIncidentIds.push(incidentId);

    const getRes = await request(app).get(`/api/incidents/${incidentId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.encryptedExecutionPayload).toBeUndefined();
    expect(getRes.body.payloadSnapshot.secretApiKey).toBe("[REDACTED]");
    expect(getRes.body.payloadSnapshot.accessToken).toBe("[REDACTED]");
    expect(getRes.body.payloadSnapshot.email).toBe("[REDACTED]");
    expect(getRes.body.errorMessage).not.toContain(rawSecret);
    expect(getRes.body.errorMessage).not.toContain(rawEmail);
    expect(getRes.body.errorMessage).not.toContain("raw_bearer_999");
    expect(getRes.body.stackTrace).not.toContain("dbSecret99");
    expect(getRes.body.stackTrace).not.toContain(rawEmail);

    const historyRes = await request(app).get(`/api/incidents/${incidentId}/history`);
    const serializedHistory = JSON.stringify(historyRes.body);
    expect(serializedHistory).not.toContain(rawSecret);
    expect(serializedHistory).not.toContain(rawEmail);
    expect(serializedHistory).not.toContain("raw_bearer_999");
  });

  it("B12: validates format:email, replays decrypted unredacted secret payload cleanly, omits sealed column from APIs, and purges it on RESOLVED", async () => {
    const key = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    process.env.DLQ_PAYLOAD_ENCRYPTION_KEY = key;

    const queueName = `b12-encrypted-${Date.now()}`;
    const queue = new Queue(queueName, { connection: redis });
    const rawOriginal = {
      orderId: `ORD-B12-${Date.now()}`,
      userId: "USR-B12-1",
      amount: 3200,
      currency: "USD",
      channel: "SMS",
      email: "sarah.connor@cyberdyne.org",
      secretApiKey: "sk_live_b12_real_secret_token",
    };

    try {
      const ingest = await incidentService.ingestSnapshot({
        idempotencyKey: `b12:enc:${Date.now()}`,
        source: "b12-test",
        queueName,
        jobId: `job-b12-${Date.now()}`,
        jobName: "process-order",
        payloadSnapshot: {
          ...rawOriginal,
          email: "[REDACTED]",
          secretApiKey: "[REDACTED]",
        },
        replayEnvelope: encryptReplayPayload(rawOriginal, key),
        expectedJsonSchema: {
          type: "object",
          required: ["orderId", "amount", "channel", "email"],
          properties: {
            orderId: { type: "string" },
            amount: { type: "number", minimum: 1 },
            channel: { type: "string", enum: ["SMS", "EMAIL"] },
            email: { type: "string", format: "email" },
          },
        },
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        attemptsMade: 3,
        configuredAttempts: 3,
      });

      const incidentId = ingest.incident.id;
      createdIncidentIds.push(incidentId);

      // Sealed envelope must NEVER appear in returned DTO or GET APIs
      expect((ingest.incident as any).encryptedExecutionPayload).toBeUndefined();

      // Prepare AI proposal with redacted proposedPayload preview
      await prisma.incident.update({
        where: { id: incidentId },
        data: {
          status: "PROPOSAL_READY",
          aiDiagnosis: {
            classification: "TRANSIENT",
            action: "MUTATE_AND_RETRY",
            confidence: 0.96,
            delaySeconds: 0,
            mutations: [
              { field: "channel", from: "SMS", to: "EMAIL" },
            ],
            rootCause: "SMS rate limit",
            reasoning: "Fallback to EMAIL",
          },
          proposedPayload: {
            ...rawOriginal,
            channel: "EMAIL",
            email: "[REDACTED]",
            secretApiKey: "[REDACTED]",
          },
        },
      });

      // Stage 1 must pass format: "email" via hydrated validation target while saving redacted diff!
      const validated = await validationService.validateProposal(incidentId);
      expect(validated.status).toBe("AWAITING_APPROVAL");
      expect(validated.validation.passed).toBe(true);
      expect(validated.validation.diff.proposed.email).toBe("[REDACTED]");
      expect(validated.validation.diff.proposed.secretApiKey).toBe("[REDACTED]");

      // Verify GET API never leaks unredacted email/secret or encryptedExecutionPayload
      const detailRes = await request(app).get(`/api/incidents/${incidentId}`);
      expect(detailRes.status).toBe(200);
      expect("encryptedExecutionPayload" in detailRes.body).toBe(false);
      expect(JSON.stringify(detailRes.body)).not.toContain("sarah.connor@cyberdyne.org");
      expect(JSON.stringify(detailRes.body)).not.toContain("sk_live_b12_real_secret_token");

      // Approve & replay -> BullMQ job MUST receive real email + secret + channel: EMAIL
      const replay = await replayService.approveIncident(incidentId, {
        approvedBy: "b12-operator",
        autoReplay: true,
      });
      expect("encryptedExecutionPayload" in replay.incident).toBe(false);

      const replayedJob = await queue.getJob(replay.recoveryAttempt.replayJobId!);
      expect(replayedJob).toBeDefined();
      expect(replayedJob?.data).toEqual({
        ...rawOriginal,
        channel: "EMAIL",
      });

      // Completing replay resolves incident AND purges encryptedExecutionPayload
      const completed = await replayResultObserver.handleJobCompleted(
        queueName,
        replay.recoveryAttempt.replayJobId!,
        { ok: true }
      );
      expect(completed).toBe(true);

      const resolvedRow = await prisma.incident.findUnique({
        where: { id: incidentId },
      });
      expect(resolvedRow?.status).toBe("RESOLVED");
      expect(resolvedRow?.encryptedExecutionPayload).toBeNull();
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  it("B12: purges encryptedExecutionPayload on rejectIncident (QUARANTINED)", async () => {
    const key = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    process.env.DLQ_PAYLOAD_ENCRYPTION_KEY = key;

    const ingest = await incidentService.ingestSnapshot({
      idempotencyKey: `b12:reject:${Date.now()}`,
      source: "b12-test",
      queueName: "order-queue",
      jobId: `job-b12-reject-${Date.now()}`,
      jobName: "process-order",
      payloadSnapshot: { orderId: "ORD-REJ", email: "user@corp.com" },
      errorMessage: "Rate limit",
      attemptsMade: 3,
      configuredAttempts: 3,
    });
    createdIncidentIds.push(ingest.incident.id);

    await prisma.incident.update({
      where: { id: ingest.incident.id },
      data: { status: "AWAITING_APPROVAL" },
    });

    await replayService.rejectIncident(ingest.incident.id, {
      rejectedBy: "security",
      reason: "Manual block",
    });

    const row = await prisma.incident.findUnique({
      where: { id: ingest.incident.id },
    });
    expect(row?.status).toBe("QUARANTINED");
    expect(row?.encryptedExecutionPayload).toBeNull();
  });

  it("B12: fails closed with 409 when payload is redacted without an unredacted source or encryption key", async () => {
    delete process.env.DLQ_PAYLOAD_ENCRYPTION_KEY;
    const queueName = `b12-failclosed-${Date.now()}`;
    const queue = new Queue(queueName, { connection: redis });

    try {
      // Case 1: Redacted snapshot with no encrypted envelope and no Redis source job
      const ingest = await incidentService.ingestSnapshot({
        idempotencyKey: `b12:noredis:${Date.now()}`,
        source: "b12-test",
        queueName,
        jobId: `missing-redis-job-${Date.now()}`,
        jobName: "send-email",
        payloadSnapshot: {
          orderId: "ORD-FAILCLOSED-1",
          channel: "SMS",
          customerEmail: "[REDACTED]",
        },
        errorMessage: "Twilio Error 20429",
        attemptsMade: 3,
        configuredAttempts: 3,
      });
      createdIncidentIds.push(ingest.incident.id);

      await prisma.incident.update({
        where: { id: ingest.incident.id },
        data: {
          status: "AWAITING_APPROVAL",
          aiDiagnosis: {
            classification: "TRANSIENT",
            action: "MUTATE_AND_RETRY",
            confidence: 0.9,
            delaySeconds: 0,
            mutations: [{ field: "channel", from: "SMS", to: "EMAIL" }],
            rootCause: "Rate limit",
            reasoning: "Fallback",
          },
          proposedPayload: {
            orderId: "ORD-FAILCLOSED-1",
            channel: "EMAIL",
            customerEmail: "[REDACTED]",
          },
          validationResult: { passed: true },
        },
      });

      const approved = await replayService.approveIncident(ingest.incident.id, {
        approvedBy: "op",
        autoReplay: false,
      });

      await expect(
        replayService.executeReplay(ingest.incident.id, approved.recoveryAttempt.id)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "REDACTED_PAYLOAD_UNREPLAYABLE",
      });

      const jobCounts = await queue.getJobCounts();
      expect(jobCounts.waiting + jobCounts.delayed + jobCounts.active).toBe(0);

      // Case 2: Encrypted envelope stored, but decryption key missing at replay time
      const encIngest = await incidentService.ingestSnapshot({
        idempotencyKey: `b12:missingkey:${Date.now()}`,
        source: "b12-test",
        queueName,
        jobId: `missing-key-job-${Date.now()}`,
        jobName: "send-email",
        payloadSnapshot: {
          orderId: "ORD-FAILCLOSED-2",
          channel: "SMS",
          email: "[REDACTED]",
        },
        replayEnvelope: encryptReplayPayload(
          { orderId: "ORD-FAILCLOSED-2", channel: "SMS", email: "op@example.com" },
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ),
        errorMessage: "Twilio Error 20429",
        attemptsMade: 3,
        configuredAttempts: 3,
      });
      createdIncidentIds.push(encIngest.incident.id);

      await prisma.incident.update({
        where: { id: encIngest.incident.id },
        data: {
          status: "AWAITING_APPROVAL",
          aiDiagnosis: {
            classification: "TRANSIENT",
            action: "MUTATE_AND_RETRY",
            confidence: 0.9,
            delaySeconds: 0,
            mutations: [{ field: "channel", from: "SMS", to: "EMAIL" }],
            rootCause: "Rate limit",
            reasoning: "Fallback",
          },
          proposedPayload: {
            orderId: "ORD-FAILCLOSED-2",
            channel: "EMAIL",
            email: "[REDACTED]",
          },
          validationResult: { passed: true },
        },
      });

      const approvedEnc = await replayService.approveIncident(encIngest.incident.id, {
        approvedBy: "op",
        autoReplay: false,
      });

      await expect(
        replayService.executeReplay(
          encIngest.incident.id,
          approvedEnc.recoveryAttempt.id
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "ENCRYPTION_KEY_MISSING",
      });
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  it("B16: supports configurable INTAKE_QUEUE_NAME across Healer Worker and Reinjector guard", async () => {
    const customIntakeQueue = `custom-dlq-intake-${Date.now()}`;
    process.env.INTAKE_QUEUE_NAME = customIntakeQueue;

    expect(() =>
      queueReinjector.validateQueueName(customIntakeQueue)
    ).toThrow(/Cannot re-inject jobs into internal system queue/);

    const worker = startHealerWorker();
    expect(worker.name).toBe(customIntakeQueue);
    await stopHealerWorker();
  });
});
