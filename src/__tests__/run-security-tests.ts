#!/usr/bin/env node
import crypto from "crypto";
import os from "os";
import path from "path";
import {
  encrypt, decrypt, deriveKey, deriveKeyFromPrivateKey,
  encryptWithPassphrase, decryptWithPassphrase,
  envelopeEncrypt, envelopeDecrypt, rotateKey, rotateEnvelopeKey,
} from "../security/encryption.js";
import { Vault } from "../security/vault.js";
import { sanitize, containsSecrets, redactPrivateKeys } from "../security/sanitizer.js";

let pass = 0, fail = 0;
function t(cond: boolean, msg: string) {
  if (cond) { pass++; console.log("✓", msg); }
  else { fail++; console.error("✗", msg); }
}

const key = crypto.randomBytes(32);

// Encryption basics
t(decrypt(encrypt("hello", key), key).toString() === "hello", "encrypt/decrypt");
const bin = crypto.randomBytes(64);
t(decrypt(encrypt(bin, key), key).equals(bin), "binary encrypt/decrypt");
t(encrypt("x", key).iv !== encrypt("x", key).iv, "random IV");
try { decrypt(encrypt("x", key), crypto.randomBytes(32)); t(false, "wrong key"); } catch { t(true, "wrong key rejects"); }

// Key derivation
const { key: k1, salt } = deriveKey("pass");
t(deriveKey("pass", salt).key.equals(k1), "PBKDF2 deterministic");
const pk = "0x" + crypto.randomBytes(32).toString("hex");
t(deriveKeyFromPrivateKey(pk).equals(deriveKeyFromPrivateKey(pk)), "privkey derivation deterministic");

// Passphrase
t(decryptWithPassphrase(encryptWithPassphrase("s", "p"), "p").toString() === "s", "passphrase roundtrip");
try { decryptWithPassphrase(encryptWithPassphrase("s", "p"), "q"); t(false, "wrong pass"); } catch { t(true, "wrong passphrase rejects"); }

// Envelope
const mk = crypto.randomBytes(32);
t(envelopeDecrypt(envelopeEncrypt("env", mk), mk).toString() === "env", "envelope");

// Rotation
const ok = crypto.randomBytes(32), nk = crypto.randomBytes(32);
t(decrypt(rotateKey(encrypt("r", ok), ok, nk), nk).toString() === "r", "key rotation");
t(envelopeDecrypt(rotateEnvelopeKey(envelopeEncrypt("e", mk), mk, nk), nk).toString() === "e", "envelope rotation");

// Vault
const vp = path.join(os.tmpdir(), "vt-" + Date.now() + ".json");
const v = new Vault({ vaultPath: vp, privateKeyHex: pk, lockTimeoutMs: 60000 });
v.store_secret("k", "val");
t(v.read_secret("k") === "val", "vault store/read");
t(v.read_secret("missing") === undefined, "vault missing key");
v.store_secret("k2", "v2");
t(v.list().length === 2, "vault list");
t(v.delete_secret("k2") === true, "vault delete");
t(v.delete_secret("k2") === false, "vault delete missing");
v.lock();
const v2 = new Vault({ vaultPath: vp, privateKeyHex: pk });
t(v2.read_secret("k") === "val", "vault persistence");
t(v2.getAuditLog().some(e => e.action === "write"), "vault audit");
v2.destroy();

// Sanitizer
const s1 = sanitize("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
t(s1.sanitized.includes("[REDACTED") && !s1.sanitized.includes("ac0974bec"), "sanitize eth key");
t(sanitize("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij").sanitized.includes("[REDACTED"), "sanitize github");
t(!sanitize("https://u:longpassword@h.com").sanitized.includes("longpassword"), "sanitize url pass");
t(sanitize("normal").redactedCount === 0, "no false positives");
t(!containsSecrets("hello") && containsSecrets("0x" + "a".repeat(64)), "containsSecrets");
const rpk = "0x" + "ab".repeat(32);
t(!redactPrivateKeys("K:" + rpk).includes(rpk), "redactPrivateKeys");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
