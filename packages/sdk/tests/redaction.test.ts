import { describe, it, expect } from "vitest";
import {
  collectSensitiveValues,
  hasRedactedPlaceholder,
  redactErrorText,
  redactPayload,
} from "../src/redaction";
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

  it("B11: redacts emails, phones, webhook/client secrets, tokens, auth headers, and preserves business IDs", () => {
    const config = resolveConfig();
    const payload = {
      orderId: "ORD-B11-1",
      userId: "USR-B11-1",
      amount: 1499,
      channel: "SMS",
      email: "alice@example.com",
      customerEmail: "bob@example.com",
      emailAddress: "carol@example.com",
      phone: "+15550001234",
      secretKey: "sec_key_val",
      clientSecret: "cli_sec_val",
      webhookSecret: "whsec_val_1234567890",
      bearerToken: "bearer_tok_123",
      passwordHash: "pbkdf2_hash_value",
      headers: {
        Authorization: "Bearer super_secret_token",
        "x-api-key": "top_secret_header_key",
        "Content-Type": "application/json",
      },
    };

    const redacted = redactPayload(payload, config.redactFields);

    expect(redacted.orderId).toBe("ORD-B11-1");
    expect(redacted.userId).toBe("USR-B11-1");
    expect(redacted.amount).toBe(1499);
    expect(redacted.channel).toBe("SMS");
    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.customerEmail).toBe("[REDACTED]");
    expect(redacted.emailAddress).toBe("[REDACTED]");
    expect(redacted.phone).toBe("[REDACTED]");
    expect(redacted.secretKey).toBe("[REDACTED]");
    expect(redacted.clientSecret).toBe("[REDACTED]");
    expect(redacted.webhookSecret).toBe("[REDACTED]");
    expect(redacted.bearerToken).toBe("[REDACTED]");
    expect(redacted.passwordHash).toBe("[REDACTED]");
    expect(redacted.headers.Authorization).toBe("[REDACTED]");
    expect(redacted.headers["x-api-key"]).toBe("[REDACTED]");
    expect(redacted.headers["Content-Type"]).toBe("application/json");
    expect(hasRedactedPlaceholder(redacted)).toBe(true);
    expect(hasRedactedPlaceholder({ orderId: "ORD-1", channel: "EMAIL" })).toBe(false);
  });

  it("B11: strips sensitive values, URIs, auth headers, vendor tokens, and emails from error messages & stack traces", () => {
    const config = resolveConfig();
    const payload = {
      orderId: "ORD-B11-ERR",
      customerEmail: "victim@corp.example",
      secretApiKey: "custom-secret-value-98765",
    };
    const values = collectSensitiveValues(payload, config.redactFields);

    const rawError =
      "HTTP 401 failed for victim@corp.example and cc ops.alert@corp.example using Bearer eyJhbGciOiJIUzI1NiJ9.payload12345.sig67890 at https://api.example.com?apiKey=sk_live_abcdefgh12345678&val=custom-secret-value-98765 postgres://admin:dbPass123@db.internal:5432/prod";
    const cleaned = redactErrorText(rawError, values);

    expect(cleaned).not.toContain("victim@corp.example");
    expect(cleaned).not.toContain("ops.alert@corp.example");
    expect(cleaned).not.toContain("custom-secret-value-98765");
    expect(cleaned).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(cleaned).not.toContain("sk_live_abcdefgh12345678");
    expect(cleaned).not.toContain("dbPass123");
    expect(cleaned).toContain("Bearer [REDACTED]");
    expect(cleaned).toContain("postgres://admin:[REDACTED]@db.internal:5432/prod");
    expect(cleaned).toContain("[REDACTED_EMAIL]");
  });

  it("B11/B04: redacting malicious __proto__ own-keys never pollutes Object.prototype", () => {
    const poisoned = JSON.parse('{"__proto__":{"pollutedFromRedact":true},"secret":"abc"}');
    const sanitized = redactPayload(poisoned, ["secret"]);

    expect(sanitized.secret).toBe("[REDACTED]");
    expect(({} as any).pollutedFromRedact).toBeUndefined();
  });

  it("B10: resolveConfig rejects invalid expectedJsonSchema definitions", () => {
    expect(() =>
      resolveConfig({
        expectedJsonSchema: {
          type: "not-a-valid-json-schema-type",
        },
      })
    ).toThrow(/Invalid expectedJsonSchema/);
  });
});
