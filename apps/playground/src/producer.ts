import express, { Request, Response } from "express";
import { orderQueue } from "./queues/order.queue";
import { OrderPayload } from "./types/order";
import { redisConnection } from "./config/redis";

const app = express();
app.use(express.json());

// ── Health Check ──
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const pong = await redisConnection.ping();
    res.json({
      status: "ok",
      service: "playground-producer",
      redis: pong === "PONG" ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({
      status: "error",
      error: err.message,
    });
  }
});

// ── Queue Status / Metrics ──
app.get("/queue/status", async (_req: Request, res: Response) => {
  try {
    const counts = await orderQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed"
    );
    res.json({
      queue: orderQueue.name,
      counts,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create Order Endpoint ──
app.post("/orders", async (req: Request, res: Response) => {
  try {
    const payload = req.body as OrderPayload;
    const orderId = payload.orderId || `ORD_${Date.now()}`;

    const job = await orderQueue.add("process-order", {
      ...payload,
      orderId,
    });

    res.status(202).json({
      status: "queued",
      jobId: job.id,
      orderId,
      payload: job.data,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PLAYGROUND_PORT || 4000;

app.listen(PORT, () => {
  console.log(`[Playground API] Producer listening on http://localhost:${PORT}`);
});

export { app };
