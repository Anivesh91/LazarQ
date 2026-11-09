import path from "path";
import dotenv from "dotenv";

// Load monorepo root & engine env files before initializing queues/workers
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../engine/.env") });
dotenv.config();

import { orderQueue } from "./queues/order.queue";
import { redisConnection } from "./config/redis";
import { server } from "./producer";
import { orderWorker } from "./workers/order.worker";

console.log(
  `[Playground Dev] Producer API + BullMQ Worker (${orderWorker.name}) + @dlq-healer/sdk interceptor active`
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Playground Dev] Received ${signal}, shutting down cleanly...`);

  await Promise.allSettled([
    new Promise<void>((resolve) => server.close(() => resolve())),
    orderWorker.close(),
    orderQueue.close(),
    redisConnection.quit().catch(() => redisConnection.disconnect()),
  ]);

  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
