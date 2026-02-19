import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import {
  encrypt,
  decrypt,
  deriveKey,
  deriveKeyFromPrivateKey,
  encryptWithPassphrase,
  decryptWithPassphrase,
  envelopeEncrypt,
  envelopeDecrypt,
  rotateKey,
  rotateEnvelopeKey,
} from "../security/encryption.js";
import { Vault } from "../security/vault.js";
import { sanitize, containsSecrets, redactPrivateKeys } from "../security/sanitizer.js";

// ─── Encryption Tests ─────────────────────────────────────────

describe("Encryption", () => {
  const key = crypto.randomBytes(32);

  it("encrypts and decrypts a string", () => {
    const plaintext = "hello world";
    const payload = encrypt(plaintext, key);
    const result = decrypt(payload, key).toString("utf-8");
    expect(result).toBe(plaintext);
  });

  it("encrypts and decrypts binary data", () => {
    const data = crypto.randomBytes(256);
    const payload = encrypt(data, key);
    const result = decrypt(payload, key);
    expect(result.equals(data)).toBe(true);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const plaintext = "same data";
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with wrong key", () => {
    const payload = encrypt("secret", key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decrypt(payload, wrongKey)).toThrow();
  });

  it("fails if ciphertext is tampered", () => {
    const payload = encrypt("secret", key);
    const buf = Buffer.from(payload.ciphertext, "base64");
    buf[0] ^= 0xff;
    payload.ciphertext = buf.toString("base64");
    expect(() => decrypt(payload, key)).toThrow();
  });
});

describe("Key Derivation", () => {
  it("derives consistent key from same passphrase and salt", () => {
    const { key: k1, salt } = deriveKey("mypassword");
    const { key: k2 } = deriveKey("mypassword", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives different keys for different passphrases", () => {
    const salt = crypto.randomBytes(32);
    const { key: k1 } = deriveKey("password1", salt);
    const { key: k2 } = deriveKey("password2", salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives key from private key hex", () => {
    const pk = "0x" + crypto.randomBytes(32).toString("hex");
    const key = deriveKeyFromPrivateKey(pk);
    expect(key.length).toBe(32);
    // Deterministic
    const key2 = deriveKeyFromPrivateKey(pk);
    expect(key.equals(key2)).toBe(true);
  });
});

describe("Passphrase Encryption", () => {
  it("round-trips with passphrase", () => {
    const data = "sensitive data";
    const payload = encryptWithPassphrase(data, "strongpass");
    const result = decryptWithPassphrase(payload, "strongpass").toString("utf-8");
    expect(result).toBe(data);
  });

  it("fails with wrong passphrase", () => {
    const payload = encryptWithPassphrase("data", "correct");
    expect(() => decryptWithPassphrase(payload, "wrong")).toThrow();
  });
});

describe("Envelope Encryption", () => {
  const masterKey = crypto.randomBytes(32);

  it("encrypts and decrypts with envelope", () => {
    const data = "envelope secret";
    const payload = envelopeEncrypt(data, masterKey);
    const result = envelopeDecrypt(payload, masterKey).toString("utf-8");
    expect(result).toBe(data);
  });

  it("fails with wrong master key", () => {
    const payload = envelopeEncrypt("data", masterKey);
    expect(() => envelopeDecrypt(payload, crypto.randomBytes(32))).toThrow();
  });
});

describe("Key Rotation", () => {
  it("rotates encryption key", () => {
    const oldKey = crypto.randomBytes(32);
    const newKey = crypto.randomBytes(32);
    const payload = encrypt("rotate me", oldKey);
    const rotated = rotateKey(payload, oldKey, newKey);
    const result = decrypt(rotated, newKey).toString("utf-8");
    expect(result).toBe("rotate me");
    // Old key no longer works
    expect(() => decrypt(rotated, oldKey)).toThrow();
  });

  it("rotates envelope master key", () => {
    const oldMaster = crypto.randomBytes(32);
    const newMaster = crypto.randomBytes(32);
    const payload = envelopeEncrypt("envelope rotate", oldMaster);
    const rotated = rotateEnvelopeKey(payload, oldMaster, newMaster);
    const result = envelopeDecrypt(rotated, newMaster).toString("utf-8");
    expect(result).toBe("envelope rotate");
  });
});

// ─── Vault Tests ──────────────────────────────────────────────

describe("Vault", () => {
  let vault: Vault;
  let vaultPath: string;
  const privateKey = "0x" + crypto.randomBytes(32).toString("hex");

  beforeEach(() => {
    vaultPath = path.join(os.tmpdir(), `vault-test-${Date.now()}.json`);
    vault = new Vault({ vaultPath, privateKeyHex: privateKey, lockTimeoutMs: 60000 });
  });

  afterEach(() => {
    vault.destroy();
  });

  it("stores and reads a secret", () => {
    vault.store_secret("api_key", "sk-12345");
    expect(vault.read_secret("api_key")).toBe("sk-12345");
  });

  it("returns undefined for missing key", () => {
    expect(vault.read_secret("nonexistent")).toBeUndefined();
  });

  it("lists secret names without values", () => {
    vault.store_secret("key1", "val1");
    vault.store_secret("key2", "val2");
    const keys = vault.list();
    expect(keys).toContain("key1");
    expect(keys).toContain("key2");
    expect(keys.length).toBe(2);
  });

  it("deletes a secret", () => {
    vault.store_secret("temp", "value");
    expect(vault.delete_secret("temp")).toBe(true);
    expect(vault.read_secret("temp")).toBeUndefined();
  });

  it("returns false when deleting nonexistent key", () => {
    expect(vault.delete_secret("nope")).toBe(false);
  });

  it("persists across instances", () => {
    vault.store_secret("persist", "data");
    vault.lock();
    const vault2 = new Vault({ vaultPath, privateKeyHex: privateKey });
    expect(vault2.read_secret("persist")).toBe("data");
    vault2.lock();
  });

  it("maintains audit log", () => {
    vault.store_secret("audited", "val");
    vault.read_secret("audited");
    const log = vault.getAuditLog();
    const actions = log.map((e) => e.action);
    expect(actions).toContain("write");
    expect(actions).toContain("read");
  });

  it("locks and auto-unlocks on access", () => {
    vault.store_secret("x", "y");
    vault.lock();
    expect(vault.isLocked).toBe(true);
    // Should auto-unlock on read
    expect(vault.read_secret("x")).toBe("y");
    expect(vault.isLocked).toBe(false);
  });
});

// ─── Sanitizer Tests ──────────────────────────────────────────

describe("Sanitizer", () => {
  it("redacts Ethereum private keys", () => {
    const input = "Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const result = sanitize(input);
    expect(result.sanitized).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result.sanitized).not.toContain("ac0974bec39a17e36ba");
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it("redacts OpenAI API keys", () => {
    const result = sanitize("Using key sk-abcdefghijklmnopqrstuvwx");
    expect(result.sanitized).toContain("[REDACTED");
    expect(result.sanitized).not.toContain("abcdefghijkl");
  });

  it("redacts GitHub tokens", () => {
    const result = sanitize("Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(result.sanitized).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts Bearer tokens", () => {
    const result = sanitize("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5c.payload.signature");
    expect(result.sanitized).toContain("[REDACTED");
  });

  it("redacts passwords in URLs", () => {
    const result = sanitize("https://user:supersecretpass@host.com/path");
    expect(result.sanitized).toContain("[REDACTED]");
    expect(result.sanitized).not.toContain("supersecretpass");
  });

  it("redacts JWT tokens", () => {
    const result = sanitize("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(result.sanitized).toContain("[REDACTED");
  });

  it("detects secrets with containsSecrets()", () => {
    expect(containsSecrets("nothing here")).toBe(false);
    expect(containsSecrets("key: 0x" + "a".repeat(64))).toBe(true);
  });

  it("redactPrivateKeys only targets private keys", () => {
    const pk = "0x" + "ab".repeat(32);
    const input = `Address: 0x1234, Key: ${pk}`;
    const result = redactPrivateKeys(input);
    expect(result).toContain("0x1234");
    expect(result).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result).not.toContain(pk);
  });

  it("handles input with no secrets", () => {
    const result = sanitize("Hello, this is a normal message.");
    expect(result.sanitized).toBe("Hello, this is a normal message.");
    expect(result.redactedCount).toBe(0);
  });
});
