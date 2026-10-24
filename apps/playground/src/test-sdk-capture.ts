import { orderQueue } from "./queues/order.queue";
import { orderWorker } from "./workers/order.worker";
import { Queue } from "bullmq";
import { redisConnection } from "./config/redis";
import { IncidentSnapshot } from "@dlq-healer/sdk";

async function runTest() {
  console.log("=== Testing SDK Terminal Capture End-to-End ===\n");

  const intakeQueue = new Queue<IncidentSnapshot>("dlq-healer-intake", {
    connection: redisConnection,
  });

  // Clean intake queue
  await intakeQueue.obliterate({ force: true });
  console.log("1. Cleaned [dlq-healer-intake] queue.");

  // Inject a job that fails with Twilio 20429 (attempts: 3)
  const job = await orderQueue.add(
    "process-order",
    {
      orderId: "TEST_ORDER_999",
      userId: "USER_999",
      amount: 1999,
      channel: "SMS",
      // Sensitive field that MUST be redacted:
      // @ts-expect-error sensitive field test
      password: "ultra_confidential_secret",
    },
    { attempts: 3, backoff: { type: "fixed", delay: 300 } }
  );

  console.log(`2. Injected Job #${job.id} with attempts: 3. Worker will now process retries...\n`);

  // Wait for 3 retries to exhaust (each backoff is 300ms)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Inspect dlq-healer-intake queue
  const intakeJobs = await intakeQueue.getJobs(["waiting", "active", "completed", "failed"]);
  console.log(`\n3. Checking [dlq-healer-intake] queue... Found ${intakeJobs.length} captured incident(s).`);

  if (intakeJobs.length === 0) {
    console.error("❌ FAILED: No incident snapshot found in intake queue!");
    process.exit(1);
  }

  const capturedSnapshot = intakeJobs[0].data;
  console.log("\n📋 Captured Incident Snapshot from Smart DLQ:");
  console.log(JSON.stringify(capturedSnapshot, null, 2));

  // Assertions:
  const isTerminal = capturedSnapshot.attemptsMade === 3;
  const isPasswordRedacted = capturedSnapshot.payloadSnapshot.password === "[REDACTED]";
  const hasErrorMessage = capturedSnapshot.errorMessage.includes("Twilio Error 20429");
  const hasIdempotencyKey = Boolean(capturedSnapshot.idempotencyKey);

  console.log("\n🔍 Verification Checks:");
  console.log("  • Attempts made === 3 (Terminal):", isTerminal ? "✅ PASS" : "❌ FAIL");
  console.log("  • Password redacted to [REDACTED]:", isPasswordRedacted ? "✅ PASS" : "❌ FAIL");
  console.log("  • Error message captured:", hasErrorMessage ? "✅ PASS" : "❌ FAIL");
  console.log("  • Idempotency key generated:", hasIdempotencyKey ? "✅ PASS" : "❌ FAIL");

  if (isTerminal && isPasswordRedacted && hasErrorMessage && hasIdempotencyKey) {
    console.log("\n🎉 ALL DAY 3 END-TO-END VERIFICATION CHECKS PASSED!\n");
  } else {
    console.error("\n❌ Some verification checks failed!");
    process.exit(1);
  }

  await orderWorker.close();
  await orderQueue.close();
  await intakeQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
