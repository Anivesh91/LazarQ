import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOperatorSession,
  isAuthorizedOperatorSession,
  getOperatorAuthState as getNodeOperatorAuthState,
} from "../src/lib/operator-session.ts";
import {
  getOperatorAuthState,
  isOperatorAuthEnabled,
  sanitizeNextPath,
  verifyOperatorSessionToken,
} from "../src/lib/operator-session-edge.ts";

const ORIGINAL_PASSWORD = process.env.DASHBOARD_OPERATOR_PASSWORD;
const ORIGINAL_SECRET = process.env.DASHBOARD_SESSION_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

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

  if (ORIGINAL_NODE_ENV === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  } else {
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe("Phase 3 Operator Auth & Edge Verification", () => {
  afterEach(() => {
    restoreAuthEnv();
  });

  it("treats auth as disabled only in non-production when neither credential is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.DASHBOARD_OPERATOR_PASSWORD;
    delete process.env.DASHBOARD_SESSION_SECRET;

    assert.equal(isOperatorAuthEnabled(), false);
    assert.equal(getOperatorAuthState().misconfigured, false);
    assert.equal(await verifyOperatorSessionToken(undefined), true);
  });

  it("B18: fails closed on partial configuration (password without valid secret or vice versa) in all environments", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";

    // Case 1: Password set, secret missing
    process.env.DASHBOARD_OPERATOR_PASSWORD = "only-password-set";
    delete process.env.DASHBOARD_SESSION_SECRET;

    assert.equal(isOperatorAuthEnabled(), true);
    assert.equal(getOperatorAuthState().misconfigured, true);
    assert.equal(getNodeOperatorAuthState().misconfigured, true);
    assert.equal(await verifyOperatorSessionToken(undefined), false);
    assert.equal(
      isAuthorizedOperatorSession({
        cookies: { get: () => undefined },
      } as any),
      false
    );

    // Case 2: Password set, secret too short (<32 chars)
    process.env.DASHBOARD_SESSION_SECRET = "too-short-secret";
    assert.equal(isOperatorAuthEnabled(), true);
    assert.equal(getOperatorAuthState().misconfigured, true);
    assert.equal(createOperatorSession(), null);
    assert.equal(await verifyOperatorSessionToken("9999999999.fake"), false);

    // Case 3: Secret valid, password missing
    delete process.env.DASHBOARD_OPERATOR_PASSWORD;
    process.env.DASHBOARD_SESSION_SECRET =
      "0123456789abcdef0123456789abcdef0123456789";
    assert.equal(isOperatorAuthEnabled(), true);
    assert.equal(getOperatorAuthState().misconfigured, true);
    assert.equal(await verifyOperatorSessionToken(undefined), false);
  });

  it("B18: fails closed in NODE_ENV=production when credentials are missing or blank", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.DASHBOARD_OPERATOR_PASSWORD;
    delete process.env.DASHBOARD_SESSION_SECRET;

    assert.equal(isOperatorAuthEnabled(), true);
    assert.equal(getOperatorAuthState().misconfigured, true);
    assert.equal(getNodeOperatorAuthState().misconfigured, true);
    assert.equal(await verifyOperatorSessionToken(undefined), false);
    assert.equal(
      isAuthorizedOperatorSession({
        cookies: { get: () => undefined },
      } as any),
      false
    );

    // Blank strings also fail closed
    process.env.DASHBOARD_OPERATOR_PASSWORD = "   ";
    process.env.DASHBOARD_SESSION_SECRET = "";
    assert.equal(await verifyOperatorSessionToken(undefined), false);
    assert.equal(
      isAuthorizedOperatorSession({
        cookies: { get: () => undefined },
      } as any),
      false
    );
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
