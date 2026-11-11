import "dotenv/config";
import http from "http";
import { app } from "./app";
import { logger } from "./config/logger";
import { assertProductionSecurityConfig, env } from "./config/env";
import { startHealerWorker, stopHealerWorker } from "./workers/healer.worker";
import { queueReinjector } from "./replay/reinjector";
import { intakeQueueService } from "./services/intake-queue.service";
import { replayResultObserver } from "./workers/replay-result.worker";
import { eventBroadcaster } from "./services/event-broadcaster.service";
import { redis } from "./config/redis";
import { prisma } from "./db/prisma";

const PORT = env.ENGINE_PORT;
let server: http.Server | null = null;

async function bootstrap(): Promise<void> {
  assertProductionSecurityConfig();

  // Re-attach replay outcome observers & await readiness before accepting requests
  try {
    await replayResultObserver.recoverActiveReplayObservers();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[Startup] Failed to recover active replay observers; background reconciler will retry"
    );
  }

  replayResultObserver.startReconciler();

  server = app.listen(PORT, () => {
    logger.info(`🚀 LazarQ Engine API running on http://localhost:${PORT}`);
    // Start the background intake consumer worker
    startHealerWorker();
  });
}

bootstrap().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "[Startup] Fatal error during Engine bootstrap; aborting"
  );
  process.exit(1);
});

// ── Graceful Shutdown ──
async function shutdown(signal: string) {
  logger.info(`${signal} received. Initiating graceful shutdown...`);

  try {
    // 1. Stop accepting new HTTP requests
    if (server) {
      server.close(() => {
        logger.info("HTTP server closed.");
      });
    }

    // 2. Stop intake queue consumer, replay observers, and SSE broadcaster
    await stopHealerWorker();
    await replayResultObserver.closeAll();
    await queueReinjector.closeAll();
    await intakeQueueService.closeAll();
    eventBroadcaster.closeAll();

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
