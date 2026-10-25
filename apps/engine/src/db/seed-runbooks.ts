import { runbookService } from "../services/runbook.service";
import { prisma } from "./prisma";
import { logger } from "../config/logger";

export const SEED_RUNBOOKS = [
  {
    title: "Twilio SMS Rate Limit (Error 20429) Remediation",
    tags: ["twilio", "rate-limit", "sms", "notification"],
    content: `# Twilio SMS Rate Limit (Error 20429) Remediation Runbook

## Symptom
Worker throws "Twilio Error 20429: Rate limit exceeded" when attempting to send outbound SMS.

## Root Cause
Twilio concurrency limit for shortcodes or standard phone numbers has been temporarily saturated due to burst traffic.

## Remediation Strategy
1. Fallback Channel: If the job payload contains a valid customer email or alternative channel, mutate "notificationChannel" from "SMS" to "EMAIL".
2. Backoff Replay: If email fallback is not viable, reschedule the job with an exponential backoff delay (minimum 60 seconds) with jitter.
3. Safe Replay: This error is transient. Do NOT quarantine the job unless rate limits persist continuously for more than 15 minutes.`,
  },
  {
    title: "Missing Required Field (userId) Remediation",
    tags: ["validation", "schema", "userId", "missing-data"],
    content: `# Missing Required Field (userId) Remediation Runbook

## Symptom
Worker throws "Validation Error: userId is required" during payload schema validation.

## Root Cause
Upstream checkout or client application omitted the customer identifier during guest checkout or asynchronous cart creation.

## Remediation Strategy
1. Identity Lookup: Check if payload has "customerEmail" or "phone" to deterministically resolve the user ID.
2. Safety Gate: Never fabricate or hallucinate arbitrary user IDs. If "userId" cannot be resolved deterministically, proposal MUST specify status "QUARANTINE" for manual data correction.
3. Alerting: Flag incident for upstream producer bug report.`,
  },
  {
    title: "PostgreSQL Database Connection Pool Exhaustion Remediation",
    tags: ["database", "postgres", "timeout", "pool-exhausted"],
    content: `# PostgreSQL Connection Pool Timeout Remediation Runbook

## Symptom
Worker throws "PostgreSQL pool connection timeout" while attempting to execute transactional writes.

## Root Cause
Database connection pool exhaustion caused by sudden spike in worker concurrency or lingering database locks.

## Remediation Strategy
1. Transient Recovery: Check if PostgreSQL container and healthcheck are healthy.
2. Controlled Replay: If database is responsive, replay the job untouched with exponential backoff delay of 30 seconds.
3. Throttle Concurrency: If connection timeouts recur across multiple jobs, reduce worker concurrency.`,
  },
];

export async function seedRunbooks() {
  logger.info("Starting Runbook knowledge base seeding...");

  for (const item of SEED_RUNBOOKS) {
    const existing = await prisma.runbook.findFirst({
      where: { title: item.title },
    });

    if (existing) {
      logger.info({ title: item.title }, "Runbook already exists, skipping");
      continue;
    }

    logger.info({ title: item.title }, "Generating embedding and saving Runbook...");
    const created = await runbookService.createRunbook(item);
    logger.info({ id: created.id, title: created.title }, "Runbook seeded successfully");
  }

  logger.info("Runbook knowledge base seeding completed.");
}

// Allow direct CLI execution: pnpm tsx src/db/seed-runbooks.ts
if (require.main === module) {
  seedRunbooks()
    .then(() => {
      console.log("Seeding finished successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}
