import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REGISTERED_SSE_EVENT_TYPES } from "../src/lib/sse-helpers.ts";

describe("Phase 4 Dashboard SSE Event Registrations", () => {
  it("registers all backend lifecycle SSE events including incident:validated", () => {
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("connected"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:new"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:analyzing"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:proposed"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:validated"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:approved"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:replaying"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:resolved"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:quarantined"));
    assert.ok(REGISTERED_SSE_EVENT_TYPES.includes("incident:failed"));
  });
});
