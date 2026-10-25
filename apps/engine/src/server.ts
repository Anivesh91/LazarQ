import "dotenv/config";
import { app } from "./app";
import { logger } from "./config/logger";
import { env } from "./config/env";
import { startHealerWorker, stopHealerWorker } from "./workers/healer.worker";
import { queueReinjector } from "./replay/reinjector";
import { replayResultObserver } from "./workers/replay-result.worker";
import { redis } from "./config/redis";
import { prisma } from "./db/prisma";

const PORT = env.ENGINE_PORT;

const server = app.listen(PORT, () => {
  logger.info(`🚀 DLQ-Healer Engine API running on http://localhost:${PORT}`);
  // Start the background intake consumer worker
  startHealerWorker();
});

// ── Graceful Shutdown ──
async function shutdown(signal: string) {
  logger.info(`${signal} received. Initiating graceful shutdown...`);

  try {
    // 1. Stop accepting new HTTP requests
    server.close(() => {
      logger.info("HTTP server closed.");
    });

    // 2. Stop intake queue consumer and replay observers
    await stopHealerWorker();
    await replayResultObserver.closeAll();
    await queueReinjector.closeAll();

    // 3. Disconnect Redis and PostgreSQL
    await redis.quit();
    await prisma.$disconnect();

    logger.info("Graceful shutdown completed.");
    process.exit(0);
  } catch (err: any) {
    logger.error({ err: err.message }, "Error during graceful shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
