import { orderQueue } from "./queues/order.queue";
import { redisConnection } from "./config/redis";

async function seedJobs() {
  console.log("🌱 Starting failure injection into BullMQ [order-fulfillment-queue]...\n");

  let totalQueued = 0;

  // ── 1. Valid Jobs (10 jobs) ──
  console.log("📦 1/4 Injecting 10 VALID jobs (channel: 'EMAIL')...");
  for (let i = 1; i <= 10; i++) {
    await orderQueue.add("process-order", {
      orderId: `VALID_${i.toString().padStart(3, "0")}`,
      userId: `USR_VALID_${i}`,
      amount: 100 + i * 15,
      channel: "EMAIL",
      email: `customer${i}@example.com`,
    });
    totalQueued++;
  }

  // ── 2. Type A: Rate Limit Glitches (30 jobs) ──
  console.log("⚡ 2/4 Injecting 30 RATE-LIMIT failure jobs (channel: 'SMS' -> Twilio 20429)...");
  for (let i = 1; i <= 30; i++) {
    await orderQueue.add("process-order", {
      orderId: `TWILIO_RATELIMIT_${i.toString().padStart(3, "0")}`,
      userId: `USR_SMS_${i}`,
      amount: 500 + i * 20,
      channel: "SMS",
    });
    totalQueued++;
  }

  // ── 3. Type B: Missing userId / Schema Bugs (30 jobs) ──
  console.log("🐛 3/4 Injecting 30 SCHEMA-BUG failure jobs (missing userId)...");
  for (let i = 1; i <= 30; i++) {
    await orderQueue.add("process-order", {
      orderId: `SCHEMA_BUG_${i.toString().padStart(3, "0")}`,
      // @ts-expect-error Intentionally invalid payload for failure testing
      userId: undefined,
      amount: 250 + i * 10,
      channel: "EMAIL",
    });
    totalQueued++;
  }

  // ── 4. Type C: Infrastructure Timeout (30 jobs) ──
  console.log("💥 4/4 Injecting 30 INFRA-TIMEOUT failure jobs (simulateDbTimeout: true)...");
  for (let i = 1; i <= 30; i++) {
    await orderQueue.add("process-order", {
      orderId: `DB_TIMEOUT_${i.toString().padStart(3, "0")}`,
      userId: `USR_DB_${i}`,
      amount: 1000 + i * 50,
      channel: "EMAIL",
      simulateDbTimeout: true,
    });
    totalQueued++;
  }

  console.log(`\n🎉 Successfully queued ${totalQueued} jobs!`);
  console.log("Summary:");
  console.log("  • 10 Valid jobs (expected: SUCCESS)");
  console.log("  • 30 Rate-limit jobs (expected: Twilio 20429 -> FAILED after 3 retries)");
  console.log("  • 30 Schema-bug jobs (expected: Zod validation error -> FAILED after 3 retries)");
  console.log("  • 30 DB-timeout jobs (expected: Pool connection timeout -> FAILED after 3 retries)");
  console.log("\nTotal terminal failures expected: 90 jobs in dead state.\n");

  await orderQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

seedJobs().catch((err) => {
  console.error("Error seeding jobs:", err);
  process.exit(1);
});
