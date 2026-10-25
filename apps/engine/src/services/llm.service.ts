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

    const systemPrompt = `You are DLQ-Healer AI Doctor, an automated Site Reliability Engineer (SRE) and failure recovery specialist.
Analyze the following terminal BullMQ job failure and the matched troubleshooting Runbook (SOP).
Your goal is to propose a safe, deterministic remediation strategy.

CRITICAL SAFETY DIRECTIVES:
1. Return strictly valid JSON adhering to the target schema. No markdown formatting, backticks, or prose outside JSON.
2. NEVER invent, hallucinate, or forge database keys or entity identifiers (e.g. userId, accountId, customerId).
3. If critical payload data is missing and cannot be safely derived, you MUST output action "QUARANTINE".
4. For transient network, rate limits, or pool timeouts, prescribe action "RETRY" or "MUTATE_AND_RETRY" with exponential backoff delaySeconds (e.g. 30 to 60s).
5. If the SOP specifies a channel fallback mutation (e.g. from SMS to EMAIL) and the payload contains a valid email, you MUST prescribe action "MUTATE_AND_RETRY" and include the mutation {"field": "notificationChannel", "from": "SMS", "to": "EMAIL"}.
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

      const response = await this.client.models.generateContent({
        model: this.modelName,
        contents: `${systemPrompt}\n\n${userPrompt}`,
        config: {
          responseMimeType: "application/json",
          temperature: 0.1, // low temperature for deterministic adherence
        },
      });

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
      return {
        classification: "TRANSIENT",
        action: "MUTATE_AND_RETRY",
        confidence: 0.95,
        delaySeconds: 60,
        mutations: [
          {
            field: "notificationChannel",
            from: input.payloadSnapshot.notificationChannel || "SMS",
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
