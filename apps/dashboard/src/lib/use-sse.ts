"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { SSEEvent, SSEEventPayload } from "./types";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export function useSSE(onEvent?: (event: SSEEvent) => void) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [eventHistory, setEventHistory] = useState<SSEEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (typeof window === "undefined") return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus("connecting");
    const es = new EventSource("/api/engine/events");
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus("connected");
    };

    const handleMessage = (type: string, ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as Record<string, unknown>;
        const payload: SSEEventPayload =
          parsed.data !== undefined &&
          typeof parsed.data === "object" &&
          parsed.data !== null
            ? (parsed.data as SSEEventPayload)
            : (parsed as SSEEventPayload);
        const sseEvent: SSEEvent = {
          type:
            type ||
            (typeof parsed.type === "string" ? parsed.type : "unknown"),
          data: payload,
          timestamp:
            typeof parsed.timestamp === "string"
              ? parsed.timestamp
              : new Date().toISOString(),
        };

        setLastEvent(sseEvent);
        setEventHistory((prev) => [sseEvent, ...prev].slice(0, 50)); // keep last 50 events

        if (onEvent) {
          onEvent(sseEvent);
        }
      } catch {
        // non-json or ping event
      }
    };

    // Specific BullMQ DLQ-Healer events
    const eventTypes = [
      "connected",
      "incident:new",
      "incident:analyzing",
      "incident:proposed",
      "incident:approved",
      "incident:replaying",
      "incident:resolved",
      "incident:quarantined",
      "incident:failed",
    ];

    eventTypes.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => handleMessage(type, e));
    });

    es.onerror = () => {
      setStatus("disconnected");
      es.close();

      // Auto-reconnect after 4 seconds
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 4000);
    };
  }, [onEvent]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, [connect]);

  return {
    status,
    lastEvent,
    eventHistory,
    reconnect: connect,
  };
}
