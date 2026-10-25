import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { eventBroadcaster } from "../src/services/event-broadcaster.service";

describe("Day 12: SSE Live Stream & Event Broadcaster", () => {
  afterAll(() => {
    eventBroadcaster.closeAll();
  });

  it("should return status ok and 0 subscribers initially on /api/events/status", async () => {
    const res = await request(app).get("/api/events/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.activeSubscribers).toBe("number");
    expect(res.body.timestamp).toBeDefined();
  });

  it("should safely broadcast events without error when no clients are connected", () => {
    expect(() => {
      eventBroadcaster.broadcast("incident:test", {
        message: "Hello world",
      });
    }).not.toThrow();
  });

  it("should set correct SSE headers on GET /api/events", async () => {
    // Send a request to the SSE endpoint and immediately close it
    const req = request(app).get("/api/events");

    // Listen for response headers before ending
    await new Promise<void>((resolve, reject) => {
      req
        .buffer(false)
        .parse((res, callback) => {
          try {
            expect(res.headers["content-type"]).toBe("text/event-stream");
            expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
            expect(res.headers["connection"]).toBe("keep-alive");
            callback(null, "");
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .end(() => {});
    });
  });
});
