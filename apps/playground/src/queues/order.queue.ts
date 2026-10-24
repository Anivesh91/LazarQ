import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";
import { OrderPayload } from "../types/order";

export const ORDER_QUEUE_NAME = "order-fulfillment-queue";

export const orderQueue = new Queue<OrderPayload>(ORDER_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "fixed",
      delay: 500,
    },
    removeOnComplete: false,
    removeOnFail: false, // Keep failed jobs in Redis failed set for inspection & DLQ-Healer
  },
});
