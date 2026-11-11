import path from "path";
import dotenv from "dotenv";

// Search multiple standard locations for .env across monorepo workspaces
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") }); // Root .env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });       // apps/engine/.env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });         // Working directory .env
dotenv.config();

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ENGINE_PORT: z.coerce.number().default(5000),
  ENGINE_API_KEY: z.string().default("dlq_dev_secret_key"),
  LLM_PROVIDER: z.string().default("gemini"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("gemini-3.5-flash-lite"),
  EMBEDDING_PROVIDER: z.string().default("gemini"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  INTAKE_QUEUE_NAME: z.string().min(1).default("dlq-healer-intake"),
  DLQ_PAYLOAD_ENCRYPTION_KEY: z.string().default(""),
  MAX_REPLAY_ATTEMPTS: z.coerce.number().int().positive().default(1),
});

export const env = envSchema.parse(process.env);

export function getIntakeQueueName(): string {
  const raw = process.env.INTAKE_QUEUE_NAME?.trim();
  return raw && raw.length > 0 ? raw : env.INTAKE_QUEUE_NAME;
}

export function getPayloadEncryptionKey(): string | undefined {
  const raw = process.env.DLQ_PAYLOAD_ENCRYPTION_KEY?.trim();
  const resolved =
    raw && raw.length > 0 ? raw : env.DLQ_PAYLOAD_ENCRYPTION_KEY.trim();
  return resolved.length > 0 ? resolved : undefined;
}

export function getMaxReplayAttempts(): number {
  const raw = process.env.MAX_REPLAY_ATTEMPTS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return env.MAX_REPLAY_ATTEMPTS;
}

export const KNOWN_INSECURE_ENGINE_API_KEYS = new Set([
  "",
  "dlq_dev_secret_key",
  "your-api-key",
  "changeme",
]);

export function getLlmProvider(): string {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw : env.LLM_PROVIDER.trim().toLowerCase();
}

export function getLlmModel(): string {
  const raw = process.env.LLM_MODEL?.trim();
  return raw && raw.length > 0 ? raw : env.LLM_MODEL;
}

export function getEmbeddingProvider(): string {
  const raw = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  return raw && raw.length > 0
    ? raw
    : env.EMBEDDING_PROVIDER.trim().toLowerCase();
}

export function getEmbeddingModel(): string {
  const raw = process.env.EMBEDDING_MODEL?.trim();
  return raw && raw.length > 0 ? raw : env.EMBEDDING_MODEL;
}

export function isUsableLlmApiKey(key?: string): boolean {
  const trimmed = key?.trim() ?? "";
  return trimmed.length > 0 && trimmed !== "your-llm-api-key-here";
}

export function isUsableEmbeddingApiKey(key?: string): boolean {
  const trimmed = key?.trim() ?? "";
  return trimmed.length > 0 && trimmed !== "your-embedding-api-key-here";
}

export function getLlmMode(overrideKey?: string): "live" | "mock" {
  if (getLlmProvider() === "mock") {
    return "mock";
  }
  const key =
    overrideKey !== undefined
      ? overrideKey
      : process.env.LLM_API_KEY ?? env.LLM_API_KEY;
  return isUsableLlmApiKey(key) ? "live" : "mock";
}

export function getEmbeddingMode(overrideKey?: string): "live" | "mock" {
  if (getEmbeddingProvider() === "mock") {
    return "mock";
  }
  const key =
    overrideKey !== undefined
      ? overrideKey
      : process.env.EMBEDDING_API_KEY ?? env.EMBEDDING_API_KEY;
  return isUsableEmbeddingApiKey(key) ? "live" : "mock";
}

export const MOCK_EMBEDDING_MODEL = "mock-bow-768";

export function getActiveEmbeddingProvenance(overrideKey?: string): {
  provider: string;
  model: string;
} {
  const mode = getEmbeddingMode(overrideKey);
  return {
    provider: mode === "mock" ? "mock" : getEmbeddingProvider(),
    model: mode === "mock" ? MOCK_EMBEDDING_MODEL : getEmbeddingModel(),
  };
}

export function isValidProductionEngineApiKey(key: string | undefined): boolean {
  const trimmed = key?.trim() ?? "";
  return trimmed.length > 0 && !KNOWN_INSECURE_ENGINE_API_KEYS.has(trimmed);
}

export function assertProductionSecurityConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (!isValidProductionEngineApiKey(process.env.ENGINE_API_KEY)) {
    throw new Error(
      "Security configuration error: ENGINE_API_KEY must be set to a non-default secret when NODE_ENV=production"
    );
  }

  const llmProvider = getLlmProvider();
  if (llmProvider !== "mock" && !isUsableLlmApiKey(process.env.LLM_API_KEY)) {
    throw new Error(
      `Configuration error: LLM_API_KEY must be set when NODE_ENV=production and LLM_PROVIDER=${llmProvider} (or set LLM_PROVIDER=mock explicitly)`
    );
  }

  const embeddingProvider = getEmbeddingProvider();
  if (
    embeddingProvider !== "mock" &&
    !isUsableEmbeddingApiKey(process.env.EMBEDDING_API_KEY)
  ) {
    throw new Error(
      `Configuration error: EMBEDDING_API_KEY must be set when NODE_ENV=production and EMBEDDING_PROVIDER=${embeddingProvider} (or set EMBEDDING_PROVIDER=mock explicitly)`
    );
  }
}
