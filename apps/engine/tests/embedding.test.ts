import { describe, it, expect } from "vitest";
import { GeminiEmbeddingService } from "../src/services/embedding.service";

describe("GeminiEmbeddingService", () => {
  it("should generate a 768-dimensional mock embedding vector when offline/mock", async () => {
    const service = new GeminiEmbeddingService("your-embedding-api-key-here");
    const vector = await service.generateEmbedding("Twilio SMS Rate Limit error 20429");

    expect(vector).toBeDefined();
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBe(768);
    expect(typeof vector[0]).toBe("number");
  });

  it("should generate deterministic mock vectors for the same input text", async () => {
    const service = new GeminiEmbeddingService("your-embedding-api-key-here");
    const vectorA = await service.generateEmbedding("PostgreSQL pool connection timeout");
    const vectorB = await service.generateEmbedding("PostgreSQL pool connection timeout");

    expect(vectorA).toEqual(vectorB);
  });

  it("should throw an error for empty text input", async () => {
    const service = new GeminiEmbeddingService("your-embedding-api-key-here");
    await expect(service.generateEmbedding("   ")).rejects.toThrow(
      "Text cannot be empty for embedding generation"
    );
  });
});
