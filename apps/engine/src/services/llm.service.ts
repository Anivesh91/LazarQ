import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  getLlmModel,
  getLlmProvider,
  isUsableLlmApiKey,
} from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { assertSafeJsonValue } from "../sandbox/mutation-safety";

export const MutationSchema = z.object({
  field: z.string().min(1),
  from: z.any(),
  to: z.any(),
  reason: z.string().optional(),
});

export const RepairProposalSchema = z.object({
  classification: z.enum([
    "TRANSIENT",
    "INVALID_PAYLOAD",
    "DEPENDENCY_FAILURE",
    "UNKNOWN",
  ]),
  action: z.enum(["RETRY", "MUTATE_AND_RETRY", "QUARANTINE"]),
  confidence: z.number().min(0).max(1),
  delaySeconds: z.number().int().nonnegative().default(0),
  mutations: z.array(MutationSchema).default([]),
  rootCause: z.string().min(1),
  reasoning: z.string().min(1),
});

export type RepairProposal = z.infer<typeof RepairProposalSchema>;

export interface DiagnoseInput {
  jobName: string;
  queueName: string;
  errorMessage: string;
  stackTrace?: string | null;
  payloadSnapshot: Record<string, any>;
  attemptsMade: number;
  configuredAttempts: number;
  runbookTitle?: string;
  runbookContent?: string;
}

/**
 * Executes an async action with bounded exponential backoff on transient network / quota errors.
 */
async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 15000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTransient =
        err?.status === 429 ||
        err?.status === 503 ||
        err?.message?.includes("429") ||
        err?.message?.includes("503") ||
        err?.message?.includes("RESOURCE_EXHAUSTED") ||
        err?.message?.includes("high demand") ||
        err?.message?.includes("ECONNRESET") ||
        err?.message?.includes("ETIMEDOUT");

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const jitter = Math.random() * 300;
      const sleepMs = Math.min(delay + jitter, maxDelay);
      logger.warn(
        { attempt, maxRetries, sleepMs, err: err.message },
        "[LLM Service] Transient provider error; retrying with backoff"
      );
      await new Promise((res) => setTimeout(res, sleepMs));
      delay *= 2;
    }
  }
  return fn();
}

const RECIPIENT_EMAIL_KEYS = new Set([
  "email",
  "customeremail",
  "useremail",
  "fallbackemail",
]);

const RELEVANCE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "are",
  "not",
  "must",
  "can",
  "when",
  "error",
  "errors",
  "failed",
  "failure",
  "exception",
  "worker",
  "queue",
  "job",
  "payload",
  "step",
  "steps",
  "retry",
  "replay",
  "after",
  "runbook",
  "remediation",
]);

export class LLMService {
  private client: GoogleGenAI | null = null;
  private cachedClientKey: string | null = null;
  private readonly explicitApiKey?: string;
  private readonly explicitModelName?: string;

  constructor(apiKey?: string, modelName?: string) {
    if (apiKey !== undefined) {
      this.explicitApiKey = apiKey;
    }
    if (modelName !== undefined) {
      this.explicitModelName = modelName;
    }

    const initialKey = this.explicitApiKey ?? process.env.LLM_API_KEY;
    if (isUsableLlmApiKey(initialKey)) {
      this.client = new GoogleGenAI({ apiKey: initialKey!.trim() });
      this.cachedClientKey = initialKey!.trim();
    }
  }

  private resolveActiveClient(): { client: GoogleGenAI | null; modelName: string } {
    const provider = getLlmProvider();
    const modelName = this.explicitModelName || getLlmModel();

    if (provider === "mock") {
      return { client: null, modelName: "mock" };
    }

    const activeKey =
      this.explicitApiKey !== undefined
        ? this.explicitApiKey
        : process.env.LLM_API_KEY ?? "";

    if (!isUsableLlmApiKey(activeKey)) {
      if (process.env.NODE_ENV === "production") {
        throw new AppError(
          `LLM_API_KEY is missing or placeholder in production while LLM_PROVIDER=${provider}; refusing silent mock fallback (set LLM_PROVIDER=mock explicitly if intended)`,
          503,
          "AI_PROVIDER_UNCONFIGURED"
        );
      }
      return { client: null, modelName: "mock" };
    }

    const trimmedKey = activeKey.trim();
    if (!this.client || this.cachedClientKey !== trimmedKey) {
      this.client = new GoogleGenAI({ apiKey: trimmedKey });
      this.cachedClientKey = trimmedKey;
    }

    return { client: this.client, modelName };
  }

  /**
   * Generates a structured JSON repair proposal using Google Gemini LLM.
   */
  async generateRepairProposal(input: DiagnoseInput): Promise<RepairProposal> {
    const { client, modelName } = this.resolveActiveClient();

    if (!client) {
      logger.warn(
        { provider: getLlmProvider(), model: modelName },
        "Using deterministic mock repair planner"
      );
      return this.generateMockProposal(input);
    }

    const systemPrompt = `You are LazarQ AI Doctor, an automated Site Reliability Engineer (SRE) and failure recovery specialist.
Analyze the following terminal BullMQ job failure and the matched troubleshooting Runbook (SOP).
Your goal is to propose a safe, deterministic remediation strategy.

CRITICAL SAFETY DIRECTIVES:
1. Return strictly valid JSON adhering to the target schema. No markdown formatting, backticks, or prose outside JSON.
2. NEVER invent, hallucinate, or forge database keys or entity identifiers (e.g. userId, accountId, customerId).
3. RELEVANCE CHECK: First verify that the Error Message genuinely belongs to the matched Runbook's domain and symptom. If the Error Message is unrelated to the matched Runbook or is an unrecognized/unrecoverable exception, you MUST output action "QUARANTINE" with classification "UNKNOWN".
4. MISSING MANDATORY IDENTIFIERS ONLY: Only output action "QUARANTINE" for missing data when a mandatory execution identifier fails validation (e.g. INVALID_PAYLOAD such as missing userId or accountId). Never treat an absent optional contact field (such as missing email or customerEmail on an SMS job) as missing required data.
5. TRANSIENT RATE LIMITS & POOL TIMEOUTS: When the Error Message genuinely matches a transient SOP (such as Twilio 20429 rate limits, network glitches, or PostgreSQL pool timeouts), you MUST NOT output "QUARANTINE" — exhausted worker retry counts (e.g. 3 / 3 attempts over a few seconds) represent expected intake capture rather than a sustained 15-minute outage:
   - If the SOP specifies an SMS-to-EMAIL fallback AND the payload contains an email or customerEmail field (even if redacted), prescribe action "MUTATE_AND_RETRY" changing whichever channel key exists ("channel" or "notificationChannel") from "SMS" to "EMAIL".
   - Otherwise (for example, an SMS rate-limit payload with NO email/customerEmail field, or a database timeout), prescribe action "RETRY" with empty mutations [] and delaySeconds >= 60.
6. Allowed actions: "RETRY", "MUTATE_AND_RETRY", "QUARANTINE".
7. Allowed classifications: "TRANSIENT", "INVALID_PAYLOAD", "DEPENDENCY_FAILURE", "UNKNOWN".
8. Mutations array contains field modifications required before replay. Each mutation specifies "field", "from", and "to".

Target JSON Schema:
{
  "classification": "TRANSIENT" | "INVALID_PAYLOAD" | "DEPENDENCY_FAILURE" | "UNKNOWN",
  "action": "RETRY" | "MUTATE_AND_RETRY" | "QUARANTINE",
  "confidence": number between 0.0 and 1.0,
  "delaySeconds": integer >= 0,
  "mutations": [ { "field": string, "from": any, "to": any, "reason": string } ],
  "rootCause": string (concise 1-2 sentence explanation),
  "reasoning": string (detailed justification referencing SOP directives)
}`;

    const userPrompt = `INCIDENT DETAILS:
- Queue: ${input.queueName}
- Job Name: ${input.jobName}
- Attempts Exhausted: ${input.attemptsMade} / ${input.configuredAttempts}
- Error Message: ${input.errorMessage}
- Stack Trace: ${input.stackTrace || "N/A"}
- Payload Snapshot: ${JSON.stringify(input.payloadSnapshot, null, 2)}

MATCHED RUNBOOK / SOP:
${input.runbookTitle ? `Title: ${input.runbookTitle}\nContent:\n${input.runbookContent}` : "No runbook matched."}

Generate the JSON remediation proposal now.`;

    try {
      logger.info({ model: modelName, jobName: input.jobName }, "Requesting structured repair proposal from Gemini");

      const response = await withBoundedRetry(
        async () => {
          return client.models.generateContent({
            model: modelName,
            contents: `${systemPrompt}\n\n${userPrompt}`,
            config: {
              responseMimeType: "application/json",
              temperature: 0, // deterministic adherence to SOP & safety directives
            },
          });
        },
        { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 15000 }
      );

      const responseText = response.text?.trim();
      if (!responseText) {
        throw new Error("Empty response received from Gemini LLM");
      }

      // Parse JSON
      let parsedJson: any;
      try {
        parsedJson = JSON.parse(responseText);
      } catch (parseErr) {
        // Strip markdown backticks if any
        const cleaned = responseText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
        parsedJson = JSON.parse(cleaned);
      }

      assertSafeJsonValue(parsedJson, "llmProposal");

      // Validate against strict Zod schema
      const validatedProposal = RepairProposalSchema.parse(parsedJson);
      logger.info(
        {
          action: validatedProposal.action,
          classification: validatedProposal.classification,
          confidence: validatedProposal.confidence,
        },
        "Successfully validated AI repair proposal"
      );

      return validatedProposal;
    } catch (error: any) {
      logger.error({ err: error.message || error }, "Failed to generate valid repair proposal from LLM");
      throw new AppError(`LLM Diagnosis failed: ${error.message || "Unknown error"}`, 502);
    }
  }

  private hasRecipientEmail(
    payload: Record<string, any>,
    depth = 0
  ): boolean {
    if (!payload || typeof payload !== "object" || depth > 2) {
      return false;
    }
    for (const key of Object.keys(payload)) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const val = payload[key];
      if (
        RECIPIENT_EMAIL_KEYS.has(key.toLowerCase()) &&
        typeof val === "string" &&
        val.trim().length > 0
      ) {
        return true;
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (this.hasRecipientEmail(val, depth + 1)) {
          return true;
        }
      }
    }
    return false;
  }

  private extractDomainTokens(text: string): Set<string> {
    const tokens = new Set<string>();
    const rawMatches = text.match(/[A-Za-z0-9]+/g) || [];
    for (const match of rawMatches) {
      const splitCamel = match
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/\s+/);
      const full = match.toLowerCase();
      for (const candidate of splitCamel.length > 1 ? [full, ...splitCamel] : [full]) {
        if (candidate.length < 3 || RELEVANCE_STOP_WORDS.has(candidate)) {
          continue;
        }
        tokens.add(candidate);
      }
    }
    return tokens;
  }

  private isRunbookRelevant(input: DiagnoseInput): boolean {
    const runbookText = [input.runbookTitle || "", input.runbookContent || ""]
      .join("\n")
      .trim();
    if (!runbookText) {
      return true;
    }

    const errLower = `${input.errorMessage} ${input.stackTrace || ""}`.toLowerCase();
    const rbLower = runbookText.toLowerCase();

    if (errLower.includes("20429") || errLower.includes("rate limit")) {
      return (
        rbLower.includes("20429") ||
        rbLower.includes("rate limit") ||
        rbLower.includes("rate-limit") ||
        rbLower.includes("twilio") ||
        rbLower.includes("sms")
      );
    }

    if (errLower.includes("userid") || errLower.includes("validation")) {
      return (
        rbLower.includes("userid") ||
        rbLower.includes("validation") ||
        rbLower.includes("required field") ||
        rbLower.includes("schema")
      );
    }

    if (
      errLower.includes("timeout") ||
      errLower.includes("pool") ||
      errLower.includes("connection")
    ) {
      return (
        rbLower.includes("timeout") ||
        rbLower.includes("pool") ||
        rbLower.includes("connection") ||
        rbLower.includes("postgres") ||
        rbLower.includes("database")
      );
    }

    const errorTokens = this.extractDomainTokens(
      `${input.errorMessage} ${input.stackTrace || ""}`
    );
    const runbookTokens = this.extractDomainTokens(runbookText);
    for (const tok of errorTokens) {
      if (runbookTokens.has(tok)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Deterministic mock planner for unit tests & offline mode.
   */
  public generateMockProposal(input: DiagnoseInput): RepairProposal {
    if (!this.isRunbookRelevant(input)) {
      return {
        classification: "UNKNOWN",
        action: "QUARANTINE",
        confidence: 0.35,
        delaySeconds: 0,
        mutations: [],
        rootCause: `Matched runbook does not address error domain: ${input.errorMessage}`,
        reasoning:
          "Relevance gate detected mismatch between incident error domain and supplied runbook SOP; quarantining for operator inspection.",
      };
    }

    const err = input.errorMessage.toLowerCase();

    if (err.includes("20429") || err.includes("rate limit")) {
      const channelField =
        "channel" in input.payloadSnapshot
          ? "channel"
          : "notificationChannel" in input.payloadSnapshot
          ? "notificationChannel"
          : null;
      const currentChannel = channelField
        ? String(input.payloadSnapshot[channelField] ?? "").toUpperCase()
        : "";
      const hasEmail = this.hasRecipientEmail(input.payloadSnapshot);

      if (hasEmail && channelField && currentChannel !== "EMAIL") {
        return {
          classification: "TRANSIENT",
          action: "MUTATE_AND_RETRY",
          confidence: 0.95,
          delaySeconds: 60,
          mutations: [
            {
              field: channelField,
              from: input.payloadSnapshot[channelField] || "SMS",
              to: "EMAIL",
              reason: "Switch to email fallback channel per Twilio 20429 rate limit SOP",
            },
          ],
          rootCause: "Twilio outbound SMS rate limit exceeded (Error 20429)",
          reasoning:
            "Twilio concurrency limit saturated and recipient email is available. Runbook prescribes falling back to EMAIL notification channel.",
        };
      }

      return {
        classification: "TRANSIENT",
        action: "RETRY",
        confidence: 0.9,
        delaySeconds: 60,
        mutations: [],
        rootCause: "Twilio outbound SMS rate limit exceeded (Error 20429)",
        reasoning:
          "Twilio concurrency limit saturated, and payload lacks a fallback email/channel target. Scheduling exponential backoff RETRY per SOP.",
      };
    }

    if (err.includes("userid") || err.includes("validation")) {
      return {
        classification: "INVALID_PAYLOAD",
        action: "QUARANTINE",
        confidence: 0.92,
        delaySeconds: 0,
        mutations: [],
        rootCause: "Payload missing required field: userId",
        reasoning:
          "User identifier cannot be synthesized without compromising referential integrity. Quarantining per safety policy.",
      };
    }

    if (err.includes("timeout") || err.includes("pool") || err.includes("connection")) {
      return {
        classification: "DEPENDENCY_FAILURE",
        action: "RETRY",
        confidence: 0.88,
        delaySeconds: 30,
        mutations: [],
        rootCause: "Transient PostgreSQL connection pool exhaustion",
        reasoning:
          "Database connection pool timed out during traffic spike. Safe to retry untouched after transient recovery.",
      };
    }

    return {
      classification: "UNKNOWN",
      action: "QUARANTINE",
      confidence: 0.5,
      delaySeconds: 0,
      mutations: [],
      rootCause: `Unhandled failure: ${input.errorMessage}`,
      reasoning:
        "No definitive SOP exists for this error. Quarantining for operator inspection.",
    };
  }
}

export const llmService = new LLMService();
