import { Router, Request, Response } from "express";
import { eventBroadcaster } from "../services/event-broadcaster.service";

export const eventsRouter: Router = Router();

/**
 * GET /api/events
 * Real-time Server-Sent Events (SSE) stream for live incident updates.
 */
eventsRouter.get("/", (req: Request, res: Response) => {
  eventBroadcaster.addClient(req, res);
});

/**
 * GET /api/events/status
 * Health and subscriber count endpoint for the SSE broadcaster.
 */
eventsRouter.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    activeSubscribers: eventBroadcaster.getConnectedClientsCount(),
    timestamp: new Date().toISOString(),
  });
});
