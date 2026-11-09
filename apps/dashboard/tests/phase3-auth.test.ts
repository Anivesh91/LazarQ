import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOperatorSession } from "../src/lib/operator-session.ts";
import {
  isOperatorAuthEnabled,
  sanitizeNextPath,
  verifyOperatorSessionToken,
} from "../src/lib/operator-session-edge.ts";

const ORIGINAL_PASSWORD = process.env.DASHBOARD_OPERATOR_PASSWORD;
const ORIGINAL_SECRET = process.env.DASHBOARD_SESSION_SECRET;

function restoreAuthEnv() {
  if (ORIGINAL_PASSWORD === undefined) {
    delete process.env.DASHBOARD_OPERATOR_PASSWORD;
  } else {
    process.env.DASHBOARD_OPERATOR_PASSWORD = ORIGINAL_PASSWORD;
  }

  if (ORIGINAL_SECRET === undefined) {
    delete process.env.DASHBOARD_SESSION_SECRET;
  } else {
    process.env.DASHBOARD_SESSION_SECRET = ORIGINAL_SECRET;
  }
}

describe("Phase 3 Operator Auth & Edge Verification", () => {
  afterEach(() => {
    restoreAuthEnv();
  });

  it("treats auth as disabled when operator credentials are not configured", async () => {
    delete process.env.DASHBOARD_OPERATOR_PASSWORD;
    delete process.env.DASHBOARD_SESSION_SECRET;

    assert.equal(isOperatorAuthEnabled(), false);
    assert.equal(await verifyOperatorSessionToken(undefined), true);
  });

  it("verifies tokens signed by createOperatorSession using Edge Web Crypto", async () => {
    process.env.DASHBOARD_OPERATOR_PASSWORD = "super-secret-operator-pass";
    process.env.DASHBOARD_SESSION_SECRET =
      "0123456789abcdef0123456789abcdef0123456789";

    assert.equal(isOperatorAuthEnabled(), true);
    const token = createOperatorSession();
    assert.ok(token);

    assert.equal(await verifyOperatorSessionToken(token), true);

    const [expiry, sig] = token.split(".");
    const tampered = `${expiry}.${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`;
    assert.equal(await verifyOperatorSessionToken(tampered), false);
    assert.equal(await verifyOperatorSessionToken("1000.invalid"), false);
    assert.equal(await verifyOperatorSessionToken(undefined), false);
  });

  it("sanitizes post-login redirect paths against open redirects", () => {
    assert.equal(sanitizeNextPath("/incidents/inc-1?tab=audit"), "/incidents/inc-1?tab=audit");
    assert.equal(sanitizeNextPath("//evil.example.com"), "/");
    assert.equal(sanitizeNextPath("/\\evil.example.com"), "/");
    assert.equal(sanitizeNextPath("https://evil.example.com"), "/");
    assert.equal(sanitizeNextPath(null), "/");
  });
});
