import { describe, it, expect } from "vitest";
import { redactPayload } from "../src/redaction";

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
});
