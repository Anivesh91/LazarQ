import { describe, it, expect } from "vitest";
import { redactPayload } from "../src/redaction";
import { resolveConfig } from "../src/config";

describe("SDK Payload Redaction", () => {
  it("should redact default sensitive keys like password and token", () => {
    const payload = {
      orderId: "ORD_123",
      password: "super_secret_password",
      token: "jwt_token_here",
      amount: 500,
    };

    const redacted = redactPayload(payload, ["password", "token"]);

    expect(redacted.orderId).toBe("ORD_123");
    expect(redacted.amount).toBe(500);
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.token).toBe("[REDACTED]");
  });

  it("should handle case-insensitive key names", () => {
    const payload = {
      API_KEY: "secret_api_key_123",
      SecretKey: "classified",
      regularField: "visible",
    };

    const redacted = redactPayload(payload, ["api_key", "secretkey"]);

    expect(redacted.API_KEY).toBe("[REDACTED]");
    expect(redacted.SecretKey).toBe("[REDACTED]");
    expect(redacted.regularField).toBe("visible");
  });

  it("should recursively redact nested objects and arrays", () => {
    const payload = {
      user: {
        id: "U1",
        auth: {
          token: "nested_token",
          cvv: "123",
        },
      },
      items: [
        { name: "Shoe", price: 100 },
        { name: "Card", secret: "item_secret" },
      ],
    };

    const redacted = redactPayload(payload, ["token", "cvv", "secret"]);

    expect(redacted.user.id).toBe("U1");
    expect(redacted.user.auth.token).toBe("[REDACTED]");
    expect(redacted.user.auth.cvv).toBe("[REDACTED]");
    expect(redacted.items[0].name).toBe("Shoe");
    expect(redacted.items[1].secret).toBe("[REDACTED]");
  });

  it("should safely handle null and undefined", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
    expect(redactPayload(123)).toBe(123);
  });

  it("should redact default extended API secret keys such as secretApiKey and accessToken", () => {
    const config = resolveConfig();
    const payload = {
      secretApiKey: "sk_live_secret",
      accessToken: "oauth_access_123",
      refreshToken: "oauth_refresh_456",
      privateKey: "-----BEGIN PRIVATE KEY-----",
      orderId: "ORD_999",
    };

    const redacted = redactPayload(payload, config.redactFields);

    expect(redacted.secretApiKey).toBe("[REDACTED]");
    expect(redacted.accessToken).toBe("[REDACTED]");
    expect(redacted.refreshToken).toBe("[REDACTED]");
    expect(redacted.privateKey).toBe("[REDACTED]");
    expect(redacted.orderId).toBe("ORD_999");
  });

  it("should handle circular references and preserve Date and RegExp values", () => {
    const occurredAt = new Date("2026-11-11T10:00:00.000Z");
    const pattern = /^ORD-\d+$/i;
    const shared = { tag: "reusable" };
    const cyclic: Record<string, any> = {
      orderId: "ORD_CYCLE",
      secret: "top-secret",
      occurredAt,
      pattern,
      first: shared,
      second: shared,
    };
    cyclic.self = cyclic;

    const redacted = redactPayload(cyclic, ["secret"]);

    expect(redacted.secret).toBe("[REDACTED]");
    expect(redacted.self).toBe("[Circular]");
    expect(redacted.occurredAt).toBeInstanceOf(Date);
    expect(redacted.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    expect(redacted.pattern).toBeInstanceOf(RegExp);
    expect(redacted.pattern.source).toBe(pattern.source);
    expect(redacted.first).toEqual({ tag: "reusable" });
    expect(redacted.second).toEqual({ tag: "reusable" });
  });
});
