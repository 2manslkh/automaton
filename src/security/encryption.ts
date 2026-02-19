/**
 * Encryption Module
 *
 * AES-256-GCM encryption/decryption with PBKDF2 key derivation
 * and envelope encryption support.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits

export interface EncryptedPayload {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded IV */
  iv: string;
  /** Base64-encoded auth tag */
  tag: string;
  /** Base64-encoded salt (present when derived from passphrase) */
  salt?: string;
  /** Version for future-proofing */
  version: number;
}

export interface EnvelopeEncryptedPayload {
  /** The data encrypted with the data key */
  data: EncryptedPayload;
  /** The data key encrypted with the master key */
  encryptedDataKey: EncryptedPayload;
  version: number;
}

/**
 * Derive a 256-bit key from a passphrase using PBKDF2.
 */
export function deriveKey(passphrase: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
  const s = salt ?? crypto.randomBytes(SALT_LENGTH);
  const key = crypto.pbkdf2Sync(passphrase, s, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
  return { key, salt: s };
}

/**
 * Derive a key from a hex private key (e.g. wallet key).
 * Uses the first 32 bytes of SHA-256 hash as deterministic salt.
 */
export function deriveKeyFromPrivateKey(privateKeyHex: string): Buffer {
  const cleaned = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
  const hash = crypto.createHash("sha512").update(Buffer.from(cleaned, "hex")).digest();
  return hash.subarray(0, KEY_LENGTH);
}

/**
 * Encrypt arbitrary data with AES-256-GCM.
 */
export function encrypt(data: Buffer | string, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    version: 1,
  };
}

/**
 * Decrypt AES-256-GCM encrypted data.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt with passphrase (derives key internally).
 */
export function encryptWithPassphrase(data: Buffer | string, passphrase: string): EncryptedPayload {
  const { key, salt } = deriveKey(passphrase);
  const payload = encrypt(data, key);
  payload.salt = salt.toString("base64");
  return payload;
}

/**
 * Decrypt with passphrase.
 */
export function decryptWithPassphrase(payload: EncryptedPayload, passphrase: string): Buffer {
  if (!payload.salt) throw new Error("Missing salt in encrypted payload");
  const salt = Buffer.from(payload.salt, "base64");
  const { key } = deriveKey(passphrase, salt);
  return decrypt(payload, key);
}

/**
 * Envelope encryption: generate a random data key, encrypt data with it,
 * then encrypt the data key with the master key.
 */
export function envelopeEncrypt(data: Buffer | string, masterKey: Buffer): EnvelopeEncryptedPayload {
  const dataKey = crypto.randomBytes(KEY_LENGTH);
  const encryptedData = encrypt(data, dataKey);
  const encryptedDataKey = encrypt(dataKey, masterKey);

  return {
    data: encryptedData,
    encryptedDataKey,
    version: 1,
  };
}

/**
 * Envelope decryption.
 */
export function envelopeDecrypt(payload: EnvelopeEncryptedPayload, masterKey: Buffer): Buffer {
  const dataKey = decrypt(payload.encryptedDataKey, masterKey);
  return decrypt(payload.data, dataKey);
}

/**
 * Re-encrypt data with a new key (key rotation).
 */
export function rotateKey(payload: EncryptedPayload, oldKey: Buffer, newKey: Buffer): EncryptedPayload {
  const plaintext = decrypt(payload, oldKey);
  return encrypt(plaintext, newKey);
}

/**
 * Re-encrypt envelope-encrypted data with a new master key.
 */
export function rotateEnvelopeKey(
  payload: EnvelopeEncryptedPayload,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): EnvelopeEncryptedPayload {
  // Decrypt the data key with old master, re-encrypt with new master
  const dataKey = decrypt(payload.encryptedDataKey, oldMasterKey);
  const newEncryptedDataKey = encrypt(dataKey, newMasterKey);

  return {
    data: payload.data, // data stays the same — same data key
    encryptedDataKey: newEncryptedDataKey,
    version: payload.version,
  };
}
