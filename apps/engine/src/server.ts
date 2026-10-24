import "dotenv/config";
import { app } from "./app";
import { logger } from "./config/logger";
import { env } from "./config/env";

const PORT = env.ENGINE_PORT;

app.listen(PORT, () => {
  logger.info(`DLQ-Healer Engine running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down...");
  process.exit(0);
});
