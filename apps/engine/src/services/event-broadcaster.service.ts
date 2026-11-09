import { Request, Response } from "express";
import { logger } from "../config/logger";

export interface BroadcastEvent {
  type: string;
  data: any;
  timestamp: string;
}

const MAX_SSE_CLIENTS = 100;

export class EventBroadcasterService {
  private clients: Set<Response> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Starts a 25-second periodic SSE comment ping (: ping\n\n)
   * to keep HTTP connections alive across proxies and reverse proxies.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size > 0) {
        for (const client of this.clients) {
          try {
            client.write(": ping\n\n");
          } catch (err) {
            this.clients.delete(client);
          }
        }
      }
    }, 25000);

    // Unref so this timer doesn't prevent graceful process exit in tests
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * Registers a new HTTP SSE client connection.
   */
  public addClient(req: Request, res: Response): void {
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      res.status(503).json({ message: "Maximum SSE connections reached" });
      return;
    }

    // Required headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable buffering for Nginx

    // Send initial handshake event
    const initialPayload: BroadcastEvent = {
      type: "connected",
      data: {
        message: "Connected to LazarQ live event stream",
        clientCount: this.clients.size + 1,
      },
      timestamp: new Date().toISOString(),
    };

    res.write(`event: connected\ndata: ${JSON.stringify(initialPayload)}\n\n`);

    this.clients.add(res);
    logger.info(
      { totalClients: this.clients.size, ip: req.ip },
      "[SSE Broadcaster] New dashboard client connected"
    );

    // Handle client disconnect
    req.on("close", () => {
      this.clients.delete(res);
      logger.info(
        { totalClients: this.clients.size },
        "[SSE Broadcaster] Client disconnected"
      );
    });
  }

  /**
   * Broadcasts a named event with JSON payload to all active SSE subscribers.
   */
  public broadcast(eventName: string, data: any): void {
    if (this.clients.size === 0) {
      return;
    }

    const payload: BroadcastEvent = {
      type: eventName,
      data,
      timestamp: new Date().toISOString(),
    };

    let message: string;
    try {
      message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch (err) {
      logger.error(
        { err, eventName },
        "[SSE Broadcaster] Failed to serialize event payload"
      );
      return;
    }

    let deadClients = 0;
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (err) {
        this.clients.delete(client);
        deadClients++;
      }
    }

    logger.debug(
      {
        eventName,
        recipients: this.clients.size,
        deadClients,
      },
      "[SSE Broadcaster] Dispatched event to connected clients"
    );
  }

  /**
   * Returns current active subscriber count.
   */
  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  /**
   * Closes all active SSE connections gracefully.
   */
  public closeAll(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    logger.info("[SSE Broadcaster] All SSE clients disconnected");
  }
}

export const eventBroadcaster = new EventBroadcasterService();
