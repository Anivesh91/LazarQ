import { Worker, Job } from "bullmq";
import { attachDLQHealer } from "@dlq-healer/sdk";
import { redisConnection } from "../config/redis";
import { ORDER_QUEUE_NAME } from "../queues/order.queue";
import { OrderPayload, OrderPayloadSchema } from "../types/order";

export const orderWorker = new Worker<OrderPayload>(
  ORDER_QUEUE_NAME,
  async (job: Job<OrderPayload>) => {
    const data = job.data;
    console.log(
      `[Worker] Processing Job #${job.id} (Attempt ${job.attemptsMade + 1}/${job.opts.attempts || 3}) for Order: ${data?.orderId || "unknown"}`
    );

    // ── Scenario B: Invalid Payload / Schema Failure ──
    const validation = OrderPayloadSchema.safeParse(data);
    if (!validation.success) {
      const issue = validation.error.issues[0]?.message || "Invalid order payload";
      throw new Error(`Validation Error: ${issue}`);
    }

    // ── Scenario C: Simulated Infrastructure Glitch ──
    if (data.simulateDbTimeout) {
      throw new Error("PostgreSQL pool connection timeout");
    }

    // ── Scenario A: Third-Party Rate Limit (Twilio 20429) ──
    if (data.channel === "SMS") {
      throw new Error("Twilio Error 20429: Rate limit exceeded on SMS gateway");
    }

    // ── Success Path (e.g. channel === 'EMAIL') ──
    console.log(`[Worker] ✅ Order #${data.orderId} fulfilled successfully via ${data.channel}!`);
    return {
      success: true,
      orderId: data.orderId,
      deliveredVia: data.channel,
      processedAt: new Date().toISOString(),
    };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

// ── Hook DLQ-Healer SDK to automatically intercept terminal failures! ──
attachDLQHealer(orderWorker, {
  redisConnection,
  intakeQueueName: "dlq-healer-intake",
  sourceId: "playground-app",
  redactFields: ["customerEmail", "ssn", "secret"],
  enableLogging: true,
});

orderWorker.on("completed", (job) => {
  console.log(`[Worker Event] Job #${job.id} COMPLETED`);
});

orderWorker.on("failed", (job, err) => {
  if (job) {
    const isTerminal = job.attemptsMade >= (job.opts.attempts || 3);
    console.warn(
      `[Worker Event] Job #${job.id} FAILED (Attempt ${job.attemptsMade}/${job.opts.attempts || 3}). ${
        isTerminal ? "🚨 TERMINAL FAILURE (EXHAUSTED)" : "⏳ Will retry"
      } - Error: ${err.message}`
    );
  }
});
