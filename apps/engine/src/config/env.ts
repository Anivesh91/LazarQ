import path from "path";
import dotenv from "dotenv";

// Load from root .env or local
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ENGINE_PORT: z.coerce.number().default(5000),
  ENGINE_API_KEY: z.string().default("dlq_dev_secret_key"),
  LLM_PROVIDER: z.string().default("gemini"),
  LLM_API_KEY: z.string().default(""),
  EMBEDDING_PROVIDER: z.string().default("gemini"),
  EMBEDDING_API_KEY: z.string().default(""),
});

export const env = envSchema.parse(process.env);
