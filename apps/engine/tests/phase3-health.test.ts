import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../src/config/redis", () => ({
  redis: {
    status: "ready",
    ping: vi.fn().mockResolvedValue("PONG"),
    duplicate: vi.fn(),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
  },
}));

vi.mock("../src/db/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

import { app } from "../src/app";
import { env } from "../src/config/env";

describe("Phase 3 /health model metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes configured llmProvider, llmModel, and embeddingModel on GET /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      redis: "connected",
      database: "connected",
      llmProvider: env.LLM_PROVIDER,
      llmModel: env.LLM_MODEL,
      embeddingModel: env.EMBEDDING_MODEL,
    });
  });
});
