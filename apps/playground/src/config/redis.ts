import Redis from "ioredis";
import "dotenv/config";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on("error", (err) => {
  console.error("[Playground Redis Error]", err.message);
});
