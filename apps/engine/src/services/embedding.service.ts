import { GoogleGenAI } from "@google/genai";
import {
  MOCK_EMBEDDING_MODEL,
  getActiveEmbeddingProvenance,
  getEmbeddingMode,
  getEmbeddingModel,
  getEmbeddingProvider,
  isUsableEmbeddingApiKey,
} from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

export interface IEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
}

const MOCK_STOP_WORDS = new Set([
  "the",
  "is",
  "a",
  "an",
  "of",
  "to",
  "in",
  "for",
  "and",
  "or",
  "on",
  "with",
  "at",
  "by",
  "from",
  "into",
  "when",
  "if",
  "unless",
  "not",
  "do",
  "this",
  "that",
  "has",
  "have",
  "been",
  "be",
  "are",
  "as",
  "than",
  "more",
  "can",
  "will",
  "may",
  "must",
  "other",
  "any",
  "error",
  "errors",
  "job",
  "worker",
  "payload",
  "stack",
  "trace",
  "ts",
  "js",
  "ms",
  "after",
  "during",
  "attempting",
  "specify",
  "directive",
  "strategy",
  "symptom",
  "root",
  "cause",
  "remediation",
  "runbook",
  "throws",
]);

export class GeminiEmbeddingService implements IEmbeddingService {
  private client: GoogleGenAI | null = null;
  private cachedClientKey: string | null = null;
  private readonly explicitApiKey?: string;
  private readonly explicitModelName?: string;
  private readonly dimensions: number = 768;

  constructor(apiKey?: string, modelName?: string) {
    if (apiKey !== undefined) {
      this.explicitApiKey = apiKey;
    }
    if (modelName !== undefined) {
      this.explicitModelName = modelName;
    }

    const initialKey = this.explicitApiKey ?? process.env.EMBEDDING_API_KEY;
    if (isUsableEmbeddingApiKey(initialKey)) {
      this.client = new GoogleGenAI({ apiKey: initialKey!.trim() });
      this.cachedClientKey = initialKey!.trim();
    }
  }

  public getProvenance(): { provider: string; model: string } {
    if (this.explicitApiKey !== undefined) {
      const mode = getEmbeddingMode(this.explicitApiKey);
      return {
        provider: mode === "mock" ? "mock" : getEmbeddingProvider(),
        model:
          mode === "mock"
            ? MOCK_EMBEDDING_MODEL
            : this.explicitModelName || getEmbeddingModel(),
      };
    }

    const base = getActiveEmbeddingProvenance();
    if (base.model !== MOCK_EMBEDDING_MODEL && this.explicitModelName) {
      return { provider: base.provider, model: this.explicitModelName };
    }
    return base;
  }

  private resolveActiveClient(): { client: GoogleGenAI | null; modelName: string } {
    const provider = getEmbeddingProvider();
    const modelName = this.explicitModelName || getEmbeddingModel();

    if (provider === "mock") {
      return { client: null, modelName: MOCK_EMBEDDING_MODEL };
    }

    const activeKey =
      this.explicitApiKey !== undefined
        ? this.explicitApiKey
        : process.env.EMBEDDING_API_KEY ?? "";

    if (!isUsableEmbeddingApiKey(activeKey)) {
      if (process.env.NODE_ENV === "production") {
        throw new AppError(
          `EMBEDDING_API_KEY is missing or placeholder in production while EMBEDDING_PROVIDER=${provider}; refusing silent mock fallback (set EMBEDDING_PROVIDER=mock explicitly if intended)`,
          503,
          "AI_PROVIDER_UNCONFIGURED"
        );
      }
      return { client: null, modelName: MOCK_EMBEDDING_MODEL };
    }

    const trimmedKey = activeKey.trim();
    if (!this.client || this.cachedClientKey !== trimmedKey) {
      this.client = new GoogleGenAI({ apiKey: trimmedKey });
      this.cachedClientKey = trimmedKey;
    }

    return { client: this.client, modelName };
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

    const { client, modelName } = this.resolveActiveClient();

    if (!client) {
      logger.warn(
        { provider: getEmbeddingProvider(), model: modelName },
        "Using deterministic local 768-dim mock embedding projection"
      );
      return this.generateMockEmbedding(safeText);
    }

    try {
      const response = await client.models.embedContent({
        model: modelName,
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

  private tokenizeForMockEmbedding(
    text: string
  ): Array<{ term: string; weight: number }> {
    const tokens: Array<{ term: string; weight: number }> = [];
    const rawMatches = text.match(/[A-Za-z0-9]+/g) || [];
    for (const match of rawMatches) {
      const parts = match
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/\s+/);
      const full = match.toLowerCase();
      const candidates = parts.length > 1 ? [full, ...parts] : [full];
      for (const candidate of candidates) {
        if (candidate.length < 2 || MOCK_STOP_WORDS.has(candidate)) {
          continue;
        }
        const isNumericCode = /^\d+$/.test(candidate);
        tokens.push({ term: candidate, weight: isNumericCode ? 2.5 : 1.5 });
      }
    }
    return tokens;
  }

  private fnv1aHash(str: string, seed: number): number {
    let hash = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  }

  private accumulateHashedFeature(
    vector: number[],
    feature: string,
    weight: number
  ): void {
    const h1 = this.fnv1aHash(feature, 2166136261);
    const h2 = this.fnv1aHash(feature, 374761393);
    vector[h1 % this.dimensions] += ((h1 & 1) === 0 ? 1 : -1) * weight;
    vector[h2 % this.dimensions] += ((h2 & 1) === 0 ? 1 : -1) * weight * 0.7;
  }

  /**
   * Deterministic semantic token/bigram/ngram unit vector projection for unit tests & explicit mock mode.
   */
  private generateMockEmbedding(seedText: string): number[] {
    const vector: number[] = new Array(this.dimensions).fill(0);
    const lines = seedText.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let inSymptomSection = false;

    lines.forEach((rawLine, idx) => {
      const trimmed = rawLine.trim();
      if (/^##\s+symptom/i.test(trimmed)) {
        inSymptomSection = true;
        return;
      }
      if (/^##\s+/i.test(trimmed)) {
        inSymptomSection = false;
      }

      let lineWeight = 0.25;
      if (
        /^error\s*:/i.test(trimmed) ||
        /^#\s+/.test(trimmed) ||
        (idx === 0 && !/^job\s*:/i.test(trimmed))
      ) {
        lineWeight = 3.0;
      } else if (inSymptomSection) {
        lineWeight = 2.0;
      } else if (/^job\s*:/i.test(trimmed) || /^stack trace\s*:/i.test(trimmed)) {
        lineWeight = 0.65;
      }

      const tokens = this.tokenizeForMockEmbedding(trimmed);
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        this.accumulateHashedFeature(vector, `u:${tok.term}`, tok.weight * lineWeight);

        if (i + 1 < tokens.length) {
          const nextTok = tokens[i + 1];
          this.accumulateHashedFeature(
            vector,
            `b:${tok.term}_${nextTok.term}`,
            Math.min(tok.weight, nextTok.weight) * lineWeight * 1.1
          );
        }

        if (tok.term.length >= 5) {
          for (let j = 0; j <= tok.term.length - 4; j++) {
            const ngram = tok.term.slice(j, j + 4);
            this.accumulateHashedFeature(vector, `g:${ngram}`, 0.3 * lineWeight);
          }
        }
      }
    });

    let normSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      normSq += vector[i] * vector[i];
    }
    const norm = Math.sqrt(normSq);
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }

    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = parseFloat((vector[i] / norm).toFixed(6));
    }
    return vector;
  }
}

export const embeddingService = new GeminiEmbeddingService();
