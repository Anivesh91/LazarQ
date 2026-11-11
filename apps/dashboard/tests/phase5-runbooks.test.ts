import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunbooksQueryString,
  normalizeRunbooksResponse,
} from "../src/lib/runbook-query.ts";

describe("Phase 5 Dashboard Runbook Query & Pagination Helpers (B21)", () => {
  it("builds paginated, search, and tag query parameters cleanly", () => {
    assert.equal(buildRunbooksQueryString(), "");
    assert.equal(
      buildRunbooksQueryString({
        page: 2,
        limit: 20,
        search: "  Twilio 20429  ",
        tag: " Rate-Limit ",
      }),
      "?page=2&limit=20&search=Twilio+20429&tag=rate-limit"
    );
    // Caps limit cleanly at backend max 100
    assert.equal(
      buildRunbooksQueryString({ page: 6, limit: 250 }),
      "?page=6&limit=100"
    );
  });

  it("preserves full backend pagination totals beyond page limit (>20 / >100 items)", () => {
    const page2Items = Array.from({ length: 20 }, (_, i) => ({
      id: `rb-${21 + i}`,
      title: `Runbook ${21 + i}`,
    }));

    const normalized = normalizeRunbooksResponse(
      {
        data: page2Items,
        pagination: {
          page: 2,
          limit: 20,
          total: 125,
          totalPages: 7,
        },
      },
      { page: 2, limit: 20 }
    );

    assert.equal(normalized.runbooks.length, 20);
    assert.equal(normalized.runbooks[0].id, "rb-21");
    assert.deepEqual(normalized.pagination, {
      page: 2,
      limit: 20,
      total: 125,
      totalPages: 7,
    });
  });
});
