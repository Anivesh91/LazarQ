import express, { Express } from "express";
import cors from "cors";
import { redis } from "./config/redis";
import {
  getEmbeddingMode,
  getEmbeddingModel,
  getEmbeddingProvider,
  getLlmMode,
  getLlmModel,
  getLlmProvider,
} from "./config/env";
import { prisma } from "./db/prisma";
import { incidentRouter } from "./api/incident.routes";
import { runbookRouter } from "./api/runbook.routes";
import { circuitBreakerRouter } from "./api/circuit-breaker.routes";
import { eventsRouter } from "./api/events.routes";
import { metricsRouter } from "./api/metrics.routes";
import { apiKeyAuth } from "./middleware/auth.middleware";
import { errorHandler } from "./middleware/error-handler";

const app: Express = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Health Check Endpoint ──
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
    llmProvider: getLlmProvider(),
    llmModel: getLlmModel(),
    llmMode: getLlmMode(),
    embeddingProvider: getEmbeddingProvider(),
    embeddingModel: getEmbeddingModel(),
    embeddingMode: getEmbeddingMode(),
    timestamp: new Date().toISOString(),
  });
});

// ── API Key Authentication (Optional/Configurable) ──
app.use(apiKeyAuth);

// ── API Routes ──
app.use("/api/incidents", incidentRouter);
app.use("/api/runbooks", runbookRouter);
app.use("/api/circuit-breaker", circuitBreakerRouter);
app.use("/api/events", eventsRouter);
app.use("/api/metrics", metricsRouter);

// ── Global Error Handler ──
app.use(errorHandler);

export { app };
