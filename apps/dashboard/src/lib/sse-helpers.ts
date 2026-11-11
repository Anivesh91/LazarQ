export const REGISTERED_SSE_EVENT_TYPES = [
  "connected",
  "incident:new",
  "incident:analyzing",
  "incident:proposed",
  "incident:validated",
  "incident:approved",
  "incident:replaying",
  "incident:resolved",
  "incident:quarantined",
  "incident:failed",
] as const;

export type RegisteredSSEEventType =
  (typeof REGISTERED_SSE_EVENT_TYPES)[number];
