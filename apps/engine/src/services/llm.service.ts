import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

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

export class LLMService {
  private client: GoogleGenAI | null = null;
  private readonly modelName: string;

  constructor(apiKey?: string, modelName?: string) {
    const key = apiKey || env.LLM_API_KEY;
    this.modelName = modelName || env.LLM_MODEL || "gemini-3.5-flash-lite";

    if (key && key !== "your-llm-api-key-here") {
      this.client = new GoogleGenAI({ apiKey: key });
    }
  }

  /**
   * Generates a structured JSON repair proposal using Google Gemini LLM.
   */
  async generateRepairProposal(input: DiagnoseInput): Promise<RepairProposal> {
    if (!this.client) {
      logger.warn("LLM API key not configured; using deterministic mock repair planner");
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
      logger.info({ model: this.modelName, jobName: input.jobName }, "Requesting structured repair proposal from Gemini");

      const response = await withBoundedRetry(
        async () => {
          if (!this.client) throw new Error("LLM client not initialized");
          return this.client.models.generateContent({
            model: this.modelName,
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

  /**
   * Deterministic mock planner for unit tests & offline mode.
   */
  public generateMockProposal(input: DiagnoseInput): RepairProposal {
    const err = input.errorMessage.toLowerCase();

    if (err.includes("20429") || err.includes("rate limit")) {
      const channelField =
        "channel" in input.payloadSnapshot
          ? "channel"
          : "notificationChannel";

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
        reasoning: "Twilio concurrency limit saturated. Runbook prescribes falling back to EMAIL notification channel.",
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
        reasoning: "User identifier cannot be synthesized without compromising referential integrity. Quarantining per safety policy.",
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
        reasoning: "Database connection pool timed out during traffic spike. Safe to retry untouched after transient recovery.",
      };
    }

    return {
      classification: "UNKNOWN",
      action: "QUARANTINE",
      confidence: 0.5,
      delaySeconds: 0,
      mutations: [],
      rootCause: `Unhandled failure: ${input.errorMessage}`,
      reasoning: "No definitive SOP exists for this error. Quarantining for operator inspection.",
    };
  }
}

export const llmService = new LLMService();
