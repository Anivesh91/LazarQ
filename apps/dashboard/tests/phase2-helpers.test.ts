import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAllowedEngineRequest } from "../src/lib/engine-proxy.ts";
import {
  collectJsonFieldDiffs,
  computeJsonLineDiff,
} from "../src/lib/payload-diff.ts";
import { formatEngineErrorMessage } from "../src/lib/api-errors.ts";

describe("Phase 2 Dashboard Helpers", () => {
  describe("isAllowedEngineRequest", () => {
    it("allows GET /incidents/:id/history", () => {
      assert.equal(isAllowedEngineRequest(["incidents", "inc-123", "history"], "GET"), true);
      assert.equal(isAllowedEngineRequest(["incidents", "inc-123", "history"], "POST"), false);
    });

    it("allows PATCH, GET, and DELETE on /runbooks/:id", () => {
      assert.equal(isAllowedEngineRequest(["runbooks", "rb-1"], "PATCH"), true);
      assert.equal(isAllowedEngineRequest(["runbooks", "rb-1"], "GET"), true);
      assert.equal(isAllowedEngineRequest(["runbooks", "rb-1"], "DELETE"), true);
      assert.equal(isAllowedEngineRequest(["runbooks", "rb-1"], "POST"), false);
    });

    it("rejects path traversal and arbitrary routes", () => {
      assert.equal(isAllowedEngineRequest(["incidents", "..", "history"], "GET"), false);
      assert.equal(isAllowedEngineRequest(["admin", "shutdown"], "POST"), false);
    });
  });

  describe("collectJsonFieldDiffs & computeJsonLineDiff", () => {
    it("identifies mutated top-level and nested fields", () => {
      const original = {
        orderId: "ORD-1",
        channel: "SMS",
        meta: { retryCount: 0, region: "ap-south-1" },
        legacyFlag: true,
      };
      const proposed = {
        orderId: "ORD-1",
        channel: "EMAIL",
        meta: { retryCount: 1, region: "ap-south-1" },
        fallbackReason: "twilio-rate-limit",
      };

      const diffs = collectJsonFieldDiffs(original, proposed);
      assert.deepEqual(diffs, [
        { path: "channel", kind: "modified", before: "SMS", after: "EMAIL" },
        { path: "meta.retryCount", kind: "modified", before: 0, after: 1 },
        { path: "legacyFlag", kind: "removed", before: true },
        { path: "fallbackReason", kind: "added", after: "twilio-rate-limit" },
      ]);
    });

    it("marks only changed lines in side-by-side LCS line diff", () => {
      const original = {
        orderId: "ORD-1",
        channel: "SMS",
        amount: 1499,
      };
      const proposed = {
        orderId: "ORD-1",
        channel: "EMAIL",
        amount: 1499,
      };

      const { originalLines, proposedLines } = computeJsonLineDiff(original, proposed);

      assert.deepEqual(
        originalLines.filter((l) => l.kind === "removed").map((l) => l.text.trim()),
        ['"channel": "SMS",']
      );
      assert.deepEqual(
        proposedLines.filter((l) => l.kind === "added").map((l) => l.text.trim()),
        ['"channel": "EMAIL",']
      );
      assert.equal(
        originalLines.filter((l) => l.kind === "unchanged").length,
        4
      );
    });

    it("returns empty proposedLines and unchanged originalLines when proposedPayload is null", () => {
      const { originalLines, proposedLines } = computeJsonLineDiff(
        { orderId: "ORD-2" },
        null
      );
      assert.equal(proposedLines.length, 0);
      assert.ok(originalLines.every((line) => line.kind === "unchanged"));
    });
  });

  describe("formatEngineErrorMessage", () => {
    it("extracts Engine error string and formats Zod details", () => {
      const formatted = formatEngineErrorMessage(400, "Bad Request", {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: [
          { path: "title", message: "Title is required" },
          { path: "content", message: "Content is required" },
        ],
      });
      assert.equal(
        formatted,
        "Validation failed (title: Title is required; content: Content is required)"
      );
    });

    it("prefers proxy message when error field is absent and falls back safely", () => {
      assert.equal(
        formatEngineErrorMessage(401, "Unauthorized", {
          message: "An authorized operator session is required",
        }),
        "An authorized operator session is required"
      );
      assert.equal(
        formatEngineErrorMessage(502, "Bad Gateway", null),
        "HTTP Error 502: Bad Gateway"
      );
    });
  });
});
