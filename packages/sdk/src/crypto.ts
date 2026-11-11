import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { EncryptedReplayEnvelope } from "./types";

const DISALLOWED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertNoUnsafeKeys(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnsafeKeys(item);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (DISALLOWED_KEYS.has(key)) {
      throw new Error(`Unsafe key "${key}" rejected in decrypted replay payload`);
    }
    assertNoUnsafeKeys((value as Record<string, unknown>)[key]);
  }
}

export function parseEncryptionKey(rawKey: string): Buffer {
  const key = rawKey.trim();
  if (!key) {
    throw new Error("DLQ payload encryption key cannot be empty");
  }

  if (/^[0-9a-f]{64}$/i.test(key)) {
    return Buffer.from(key, "hex");
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    const decoded = Buffer.from(key, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  }

  if (Buffer.byteLength(key, "utf8") >= 32) {
    return createHash("sha256").update(key, "utf8").digest();
  }

  throw new Error(
    "DLQ payload encryption key must be at least 32 UTF-8 bytes, 64 hex chars, or 32-byte base64"
  );
}

export function encryptReplayPayload(
  payload: Record<string, any>,
  rawKey: string
): EncryptedReplayEnvelope {
  const key = parseEncryptionKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: encrypted.toString("base64"),
  };
}

export function decryptReplayPayload(
  envelope: unknown,
  rawKey: string
): Record<string, any> {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Invalid encrypted replay envelope");
  }

  const candidate = envelope as Partial<EncryptedReplayEnvelope>;
  if (
    candidate.v !== 1 ||
    candidate.alg !== "aes-256-gcm" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.ct !== "string"
  ) {
    throw new Error("Unsupported or malformed encrypted replay envelope");
  }

  const key = parseEncryptionKey(rawKey);
  const iv = Buffer.from(candidate.iv, "base64");
  const tag = Buffer.from(candidate.tag, "base64");
  const ct = Buffer.from(candidate.ct, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(decrypted);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted replay payload is not a JSON object");
  }
  assertNoUnsafeKeys(parsed);
  return parsed as Record<string, any>;
}
