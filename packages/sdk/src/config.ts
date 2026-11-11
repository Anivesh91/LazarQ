import { z } from "zod";
import { DLQHealerConfig } from "./types";

export const DEFAULT_REDACT_FIELDS = [
  "password",
  "pass",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "secretApiKey",
  "secret_api_key",
  "privateKey",
  "private_key",
  "secret",
  "authorization",
  "auth",
  "cvv",
  "cardNumber",
  "creditCard",
  "ssn",
];

export const DLQHealerConfigSchema = z.object({
  redisUrl: z.string().optional().default("redis://localhost:6379"),
  redisConnection: z.any().optional(),
  intakeQueueName: z.string().default("dlq-healer-intake"),
  sourceId: z.string().default("sdk-v1"),
  redactFields: z.array(z.string()).default([]),
  expectedJsonSchema: z.record(z.any()).optional(),
  enableLogging: z.boolean().default(true),
  captureReplayFailures: z.boolean().default(false),
});

export function resolveConfig(userConfig?: DLQHealerConfig) {
  const parsed = DLQHealerConfigSchema.parse(userConfig || {});
  const combinedRedactFields = Array.from(
    new Set([...DEFAULT_REDACT_FIELDS, ...parsed.redactFields])
  );

  return {
    ...parsed,
    redactFields: combinedRedactFields,
  };
}
