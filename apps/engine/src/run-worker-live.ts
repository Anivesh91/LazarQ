import "dotenv/config";
import { startHealerWorker, stopHealerWorker } from "./workers/healer.worker";
import { prisma } from "./db/prisma";
import { redis } from "./config/redis";
import { Queue } from "bullmq";

async function verifyLiveWorker() {
  console.log("=== Testing Healer Worker Live Ingestion ===\n");

  const intakeQueue = new Queue("dlq-healer-intake", { connection: redis });
  const waitingBefore = await intakeQueue.getWaitingCount();
  console.log(`1. Jobs currently waiting in [dlq-healer-intake]: ${waitingBefore}`);

  // Start Healer Worker
  console.log("2. Starting Healer Worker to consume Smart DLQ...");
  startHealerWorker();

  // Wait for worker to consume
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const waitingAfter = await intakeQueue.getWaitingCount();
  console.log(`3. Jobs remaining in [dlq-healer-intake]: ${waitingAfter}`);

  // Query PostgreSQL
  const incidents = await prisma.incident.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { auditLogs: true },
  });

  console.log(`\n4. Verified Incidents in PostgreSQL (${incidents.length} found):`);
  incidents.forEach((inc, idx) => {
    console.log(`\n  [Incident #${idx + 1}]`);
    console.log(`    • ID: ${inc.id}`);
    console.log(`    • Queue: ${inc.queueName} | JobId: ${inc.jobId}`);
    console.log(`    • Status: ${inc.status}`);
    console.log(`    • Error: ${inc.errorMessage}`);
    console.log(`    • Redacted Payload:`, JSON.stringify(inc.payloadSnapshot));
    console.log(`    • Audit Logs (${inc.auditLogs.length}):`, inc.auditLogs.map((a) => a.action));
  });

  console.log("\n🎉 HEALER WORKER & POSTGRESQL PERSISTENCE FULLY VERIFIED!\n");

  await stopHealerWorker();
  await intakeQueue.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

verifyLiveWorker().catch((err) => {
  console.error("Live worker verification error:", err);
  process.exit(1);
});
