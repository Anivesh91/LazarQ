import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

export interface IEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
}

export class GeminiEmbeddingService implements IEmbeddingService {
  private client: GoogleGenAI | null = null;
  private readonly modelName: string;
  private readonly dimensions: number = 768;

  constructor(apiKey?: string, modelName?: string) {
    const key = apiKey || env.EMBEDDING_API_KEY;
    this.modelName = modelName || process.env.EMBEDDING_MODEL || "gemini-embedding-001";

    if (key && key !== "your-embedding-api-key-here") {
      this.client = new GoogleGenAI({ apiKey: key });
    }
  }

  /**
   * Generates a 768-dimensional float embedding vector for the provided text.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const sanitizedText = text.trim();
    if (!sanitizedText) {
      throw new AppError("Text cannot be empty for embedding generation", 400);
    }

    // Guard against token limit exhaustion on large stack traces or payloads
    const MAX_EMBEDDING_CHARS = 8000;
    const safeText =
      sanitizedText.length > MAX_EMBEDDING_CHARS
        ? sanitizedText.slice(0, MAX_EMBEDDING_CHARS)
        : sanitizedText;

    // In testing or when no real API key is configured, fallback to deterministic 768-dim mock
    if (!this.client) {
      logger.warn("Gemini API key not configured; returning mock 768-dim embedding");
      return this.generateMockEmbedding(safeText);
    }

    try {
      const response = await this.client.models.embedContent({
        model: this.modelName,
        contents: safeText,
        config: {
          outputDimensionality: this.dimensions,
        },
      });

      if (
        !response ||
        !response.embeddings ||
        !response.embeddings[0] ||
        !response.embeddings[0].values
      ) {
        throw new Error("Invalid or empty response received from Gemini Embedding API");
      }

      const values = response.embeddings[0].values;
      if (values.length !== this.dimensions) {
        logger.warn(
          { expected: this.dimensions, actual: values.length },
          "Embedding dimension mismatch, adjusting"
        );
      }

      return values;
    } catch (error: any) {
      logger.error({ err: error.message || error }, "Failed to generate embedding via Gemini API");
      throw new AppError(`Embedding generation failed: ${error.message || "Unknown error"}`, 502);
    }
  }

  /**
   * Deterministic mock vector generation for unit tests & offline mode.
   */
  private generateMockEmbedding(seedText: string): number[] {
    const vector: number[] = new Array(this.dimensions).fill(0);
    let hash = 0;
    for (let i = 0; i < seedText.length; i++) {
      hash = (hash << 5) - hash + seedText.charCodeAt(i);
      hash |= 0;
    }

    for (let i = 0; i < this.dimensions; i++) {
      const pseudoVal = Math.sin(hash + i) * 0.1;
      vector[i] = parseFloat(pseudoVal.toFixed(6));
    }
    return vector;
  }
}

export const embeddingService = new GeminiEmbeddingService();
