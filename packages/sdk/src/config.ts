import { z } from "zod";
import { DLQHealerConfig } from "./types";
import { validateJsonSchemaDefinition } from "./schema";

export const DEFAULT_REDACT_FIELDS = [
  "password",
  "pass",
  "passwd",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "bearerToken",
  "bearer_token",
  "authToken",
  "auth_token",
  "sessionToken",
  "session_token",
  "idToken",
  "id_token",
  "apiKey",
  "api_key",
  "secretApiKey",
  "secret_api_key",
  "secretKey",
  "secret_key",
  "clientSecret",
  "client_secret",
  "webhookSecret",
  "webhook_secret",
  "signingSecret",
  "signing_secret",
  "accessKey",
  "access_key",
  "secretAccessKey",
  "secret_access_key",
  "privateKey",
  "private_key",
  "encryptionKey",
  "encryption_key",
  "masterKey",
  "master_key",
  "secret",
  "authorization",
  "auth",
  "cookie",
  "setCookie",
  "credentials",
  "connectionString",
  "databaseUrl",
  "cvv",
  "cardNumber",
  "creditCard",
  "ssn",
  "email",
  "customerEmail",
  "customer_email",
  "userEmail",
  "user_email",
  "fallbackEmail",
  "fallback_email",
  "phone",
  "phoneNumber",
  "phone_number",
  "mobile",
];

export const DLQHealerConfigSchema = z.object({
  redisUrl: z.string().optional().default("redis://localhost:6379"),
  redisConnection: z.any().optional(),
  intakeQueueName: z.string().min(1).default("dlq-healer-intake"),
  sourceId: z.string().min(1).default("sdk-v1"),
  redactFields: z.array(z.string()).default([]),
  expectedJsonSchema: z
    .record(z.any())
    .superRefine((schema, ctx) => {
      const check = validateJsonSchemaDefinition(schema);
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid expectedJsonSchema: ${check.error}`,
        });
      }
    })
    .optional(),
  payloadEncryptionKey: z.string().optional(),
  fallbackHttpUrl: z.string().url().optional(),
  engineApiKey: z.string().optional(),
  publishMaxAttempts: z.number().int().positive().max(10).default(3),
  onPublishFailed: z
    .custom<DLQHealerConfig["onPublishFailed"]>(
      (val) => typeof val === "function",
      "onPublishFailed must be a function"
    )
    .optional(),
  enableLogging: z.boolean().default(true),
  captureReplayFailures: z.boolean().default(false),
});

export function resolveConfig(userConfig?: DLQHealerConfig) {
  const parsed = DLQHealerConfigSchema.parse(userConfig || {});
  const combinedRedactFields = Array.from(
    new Set([...DEFAULT_REDACT_FIELDS, ...parsed.redactFields])
  );

  const envEncryptionKey = process.env.DLQ_PAYLOAD_ENCRYPTION_KEY?.trim();
  const payloadEncryptionKey =
    parsed.payloadEncryptionKey?.trim() || envEncryptionKey || undefined;

  return {
    ...parsed,
    redactFields: combinedRedactFields,
    payloadEncryptionKey,
  };
}
