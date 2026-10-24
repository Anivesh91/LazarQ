import express, { Express } from "express";
import cors from "cors";
import { redis } from "./config/redis";
import { prisma } from "./db/prisma";

const app: Express = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Health check endpoint
app.get("/health", async (_req, res) => {
  let redisStatus = "disconnected";
  let dbStatus = "disconnected";

  try {
    const pong = await redis.ping();
    if (pong === "PONG") redisStatus = "connected";
  } catch (err) {
    redisStatus = "error";
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "connected";
  } catch (err) {
    dbStatus = "error";
  }

  const isHealthy = redisStatus === "connected" && dbStatus === "connected";

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    redis: redisStatus,
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

export { app };
