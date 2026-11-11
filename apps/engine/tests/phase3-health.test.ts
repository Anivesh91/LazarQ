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
import {
  getEmbeddingMode,
  getEmbeddingModel,
  getEmbeddingProvider,
  getLlmMode,
  getLlmModel,
  getLlmProvider,
} from "../src/config/env";

describe("Phase 3 & Phase 5 /health model metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes configured llmProvider, llmModel, llmMode, embeddingProvider, embeddingModel, and embeddingMode on GET /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      redis: "connected",
      database: "connected",
      llmProvider: getLlmProvider(),
      llmModel: getLlmModel(),
      llmMode: getLlmMode(),
      embeddingProvider: getEmbeddingProvider(),
      embeddingModel: getEmbeddingModel(),
      embeddingMode: getEmbeddingMode(),
    });
  });
});
