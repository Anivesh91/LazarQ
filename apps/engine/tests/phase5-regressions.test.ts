import { describe, it, expect, afterEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db/prisma";
import { assertProductionSecurityConfig } from "../src/config/env";
import { GeminiEmbeddingService } from "../src/services/embedding.service";
import { LLMService } from "../src/services/llm.service";
import { runbookService } from "../src/services/runbook.service";
import { ragService } from "../src/services/rag.service";

describe("Phase 5 Regressions (B21, B23, B24)", () => {
  const createdRunbookIds: string[] = [];

  const origNodeEnv = process.env.NODE_ENV;
  const origApiKey = process.env.ENGINE_API_KEY;
  const origLlmProvider = process.env.LLM_PROVIDER;
  const origLlmKey = process.env.LLM_API_KEY;
  const origEmbProvider = process.env.EMBEDDING_PROVIDER;
  const origEmbKey = process.env.EMBEDDING_API_KEY;

  function restoreEnv() {
    process.env.NODE_ENV = origNodeEnv;
    if (origApiKey === undefined) delete process.env.ENGINE_API_KEY;
    else process.env.ENGINE_API_KEY = origApiKey;

    if (origLlmProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = origLlmProvider;

    if (origLlmKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = origLlmKey;

    if (origEmbProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = origEmbProvider;

    if (origEmbKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = origEmbKey;
  }

  afterEach(() => {
    restoreEnv();
  });

  afterAll(async () => {
    restoreEnv();
    if (createdRunbookIds.length > 0) {
      await prisma.runbook.deleteMany({
        where: { id: { in: createdRunbookIds } },
      });
    }
    await prisma.$disconnect();
  });

  describe("B23: Explicit mock mode, production fail-closed checks, and vector provenance isolation", () => {
    it("refuses silent mock fallback in NODE_ENV=production when gemini keys are placeholder or missing, but permits explicit mock mode", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENGINE_API_KEY = "prod_strong_key_9f8e7d6c5b4a";
      process.env.LLM_PROVIDER = "gemini";
      process.env.LLM_API_KEY = "your-llm-api-key-here";
      process.env.EMBEDDING_PROVIDER = "gemini";
      process.env.EMBEDDING_API_KEY = "";

      expect(() => assertProductionSecurityConfig()).toThrowError(
        /LLM_API_KEY must be set/
      );

      const badEmbeddingService = new GeminiEmbeddingService("your-embedding-api-key-here");
      await expect(
        badEmbeddingService.generateEmbedding("Twilio 20429 error")
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "AI_PROVIDER_UNCONFIGURED",
      });

      const badLlmService = new LLMService("your-llm-api-key-here");
      await expect(
        badLlmService.generateRepairProposal({
          jobName: "send-sms",
          queueName: "order-queue",
          errorMessage: "Twilio Error 20429",
          payloadSnapshot: { channel: "SMS" },
          attemptsMade: 3,
          configuredAttempts: 3,
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "AI_PROVIDER_UNCONFIGURED",
      });

      // Explicit mock configuration works cleanly even in NODE_ENV=production
      process.env.LLM_PROVIDER = "mock";
      process.env.EMBEDDING_PROVIDER = "mock";
      expect(() => assertProductionSecurityConfig()).not.toThrow();

      const explicitMockEmbed = new GeminiEmbeddingService();
      const vec = await explicitMockEmbed.generateEmbedding("PostgreSQL timeout");
      expect(vec).toHaveLength(768);
      expect(explicitMockEmbed.getProvenance()).toEqual({
        provider: "mock",
        model: "mock-bow-768",
      });

      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        llmProvider: "mock",
        llmMode: "mock",
        embeddingProvider: "mock",
        embeddingMode: "mock",
      });
    });

    it("stores embedding provenance on Runbooks and isolates pgvector searches across incompatible providers", async () => {
      process.env.EMBEDDING_PROVIDER = "mock";
      const ts = Date.now();
      const mockTitle = `B23 Mock Provenance Runbook ${ts}`;

      const created = await runbookService.createRunbook({
        title: mockTitle,
        content: `# ${mockTitle}\n## Symptom\nWorker throws "MockIsolatedTimeoutException ${ts}"`,
        tags: ["b23-test"],
      });
      createdRunbookIds.push(created.id);

      expect(created.embeddingProvider).toBe("mock");
      expect(created.embeddingModel).toBe("mock-bow-768");

      // Searching while EMBEDDING_PROVIDER=mock returns the mock-embedded runbook
      const mockMatches = await ragService.findMatchingRunbooks(
        {
          jobName: "b23-job",
          errorMessage: `MockIsolatedTimeoutException ${ts}`,
        },
        5
      );
      expect(mockMatches.some((m) => m.id === created.id)).toBe(true);

      // Re-tag the row as a different provider ('custom-legacy-provider') and confirm mock RAG never compares against it
      await prisma.runbook.update({
        where: { id: created.id },
        data: {
          embeddingProvider: "custom-legacy-provider",
          embeddingModel: "legacy-v0",
        },
      });

      const isolatedMatches = await ragService.findMatchingRunbooks(
        {
          jobName: "b23-job",
          errorMessage: `MockIsolatedTimeoutException ${ts}`,
        },
        10
      );
      expect(isolatedMatches.some((m) => m.id === created.id)).toBe(false);
    });
  });

  describe("B24: Offline mock planner recipient check and runbook relevance gate", () => {
    it("prescribes RETRY without EMAIL mutation when SMS rate-limit job has no email/customerEmail field", () => {
      const llm = new LLMService("your-llm-api-key-here");
      const proposal = llm.generateMockProposal({
        jobName: "send-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-NO-EMAIL-24",
          channel: "SMS",
          phone: "+15550001111",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
        runbookTitle: "Twilio SMS Rate Limit (Error 20429) Remediation",
        runbookContent: "Fallback to EMAIL only if payload has a valid email/customerEmail.",
      });

      expect(proposal.action).toBe("RETRY");
      expect(proposal.classification).toBe("TRANSIENT");
      expect(proposal.mutations).toEqual([]);
      expect(proposal.delaySeconds).toBeGreaterThanOrEqual(60);
    });

    it("prescribes MUTATE_AND_RETRY when redacted customerEmail or email field exists", () => {
      const llm = new LLMService("your-llm-api-key-here");
      const proposal = llm.generateMockProposal({
        jobName: "send-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-HAS-EMAIL-24",
          channel: "SMS",
          customerEmail: "[REDACTED]",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
        runbookTitle: "Twilio SMS Rate Limit (Error 20429) Remediation",
        runbookContent: "Fallback to EMAIL if valid email/customerEmail exists.",
      });

      expect(proposal.action).toBe("MUTATE_AND_RETRY");
      expect(proposal.mutations).toHaveLength(1);
      expect(proposal.mutations[0]).toMatchObject({
        field: "channel",
        from: "SMS",
        to: "EMAIL",
      });
    });

    it("returns QUARANTINE with classification UNKNOWN when supplied runbook is unrelated to error domain", () => {
      const llm = new LLMService("your-llm-api-key-here");
      const mismatched = llm.generateMockProposal({
        jobName: "send-sms",
        queueName: "order-queue",
        errorMessage: "Twilio Error 20429: Rate limit exceeded",
        payloadSnapshot: {
          orderId: "ORD-MISMATCH-24",
          channel: "SMS",
          email: "user@example.com",
        },
        attemptsMade: 3,
        configuredAttempts: 3,
        runbookTitle: "PostgreSQL Database Connection Pool Exhaustion Remediation",
        runbookContent: "Worker throws PostgreSQL pool connection timeout.",
      });

      expect(mismatched.action).toBe("QUARANTINE");
      expect(mismatched.classification).toBe("UNKNOWN");
      expect(mismatched.mutations).toEqual([]);
    });
  });

  describe("B21 Engine pagination & search API sanity check", () => {
    it("supports page, limit, search, and total pagination beyond 20 runbooks", async () => {
      process.env.EMBEDDING_PROVIDER = "mock";
      const prefix = `B21PageCheck-${Date.now()}`;
      for (let i = 1; i <= 3; i++) {
        const created = await runbookService.createRunbook({
          title: `${prefix} Runbook #${i}`,
          content: `Unique keyword ${prefix} entry ${i}`,
          tags: ["b21-pagination"],
        });
        createdRunbookIds.push(created.id);
      }

      const page1 = await request(app).get(
        `/api/runbooks?search=${encodeURIComponent(prefix)}&limit=2&page=1`
      );
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.pagination).toEqual({
        total: 3,
        page: 1,
        limit: 2,
        totalPages: 2,
      });

      const page2 = await request(app).get(
        `/api/runbooks?search=${encodeURIComponent(prefix)}&limit=2&page=2`
      );
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.pagination).toEqual({
        total: 3,
        page: 2,
        limit: 2,
        totalPages: 2,
      });
    });
  });
});
