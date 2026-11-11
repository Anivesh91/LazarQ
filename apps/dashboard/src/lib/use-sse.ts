"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { SSEEvent, SSEEventPayload } from "./types";
import { REGISTERED_SSE_EVENT_TYPES } from "./sse-helpers";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export function useSSE(
  onEvent?: (event: SSEEvent) => void,
  onReconnect?: () => void
) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [eventHistory, setEventHistory] = useState<SSEEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const unmountedRef = useRef<boolean>(false);
  const hasConnectedOnceRef = useRef<boolean>(false);
  const shouldSyncOnOpenRef = useRef<boolean>(false);
  const onEventRef = useRef<((event: SSEEvent) => void) | undefined>(onEvent);
  const onReconnectRef = useRef<(() => void) | undefined>(onReconnect);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

  const connect = useCallback(() => {
    if (typeof window === "undefined" || unmountedRef.current) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      if (hasConnectedOnceRef.current) {
        shouldSyncOnOpenRef.current = true;
      }
      eventSourceRef.current.close();
    }

    setStatus("connecting");
    const es = new EventSource("/api/engine/events");
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!unmountedRef.current && eventSourceRef.current === es) {
        setStatus("connected");
        const isReconnect =
          hasConnectedOnceRef.current || shouldSyncOnOpenRef.current;
        hasConnectedOnceRef.current = true;
        shouldSyncOnOpenRef.current = false;
        if (isReconnect && onReconnectRef.current) {
          onReconnectRef.current();
        }
      }
    };

    const handleMessage = (type: string, ev: MessageEvent) => {
      if (unmountedRef.current) return;
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

        if (onEventRef.current) {
          onEventRef.current(sseEvent);
        }
      } catch {
        // non-json or ping event
      }
    };

    // Specific BullMQ DLQ-Healer events
    REGISTERED_SSE_EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => handleMessage(type, e));
    });

    es.onerror = () => {
      if (unmountedRef.current || eventSourceRef.current !== es) return;

      shouldSyncOnOpenRef.current = true;
      setStatus("disconnected");
      es.close();

      void (async () => {
        try {
          const sessionRes = await fetch("/api/operator/session", {
            cache: "no-store",
          });
          if (sessionRes.ok) {
            const session = (await sessionRes.json()) as {
              authEnabled?: boolean;
              authenticated?: boolean;
            };
            if (
              session.authEnabled &&
              !session.authenticated &&
              window.location.pathname !== "/login"
            ) {
              const next = `${window.location.pathname}${window.location.search}`;
              window.location.assign(`/login?next=${encodeURIComponent(next)}`);
              return;
            }
          }
        } catch {
          // Ignore network probe error and allow standard reconnect backoff
        }

        if (unmountedRef.current) return;
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!unmountedRef.current) {
            connect();
          }
        }, 4000);
      })();
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
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
