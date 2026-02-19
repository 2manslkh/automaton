/**
 * Secure Vault
 *
 * Encrypted key-value store for secrets (API keys, tokens, credentials).
 * Master key derived from wallet private key — no extra password needed.
 * Features: encrypt-on-write, decrypt-on-read, audit logging, auto-lock.
 */

import fs from "fs";
import path from "path";
import { encrypt, decrypt, deriveKeyFromPrivateKey, type EncryptedPayload } from "./encryption.js";

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface AuditLogEntry {
  timestamp: string;
  action: "read" | "write" | "delete" | "list" | "lock" | "unlock";
  key?: string;
  accessor: string;
}

export interface VaultStore {
  secrets: Record<string, EncryptedPayload>;
  audit: AuditLogEntry[];
  version: number;
}

export interface VaultOptions {
  vaultPath: string;
  privateKeyHex: string;
  lockTimeoutMs?: number;
}

export class Vault {
  private masterKey: Buffer | null = null;
  private store: VaultStore;
  private vaultPath: string;
  private privateKeyHex: string;
  private lockTimeoutMs: number;
  private lastAccessTime: number = 0;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VaultOptions) {
    this.vaultPath = options.vaultPath;
    this.privateKeyHex = options.privateKeyHex;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.store = this.loadStore();
    this.unlock();
  }

  /** Derive master key from wallet private key and unlock. */
  unlock(): void {
    this.masterKey = deriveKeyFromPrivateKey(this.privateKeyHex);
    this.touch();
    this.addAuditEntry("unlock", undefined, "system");
  }

  /** Lock the vault — wipe master key from memory. */
  lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.addAuditEntry("lock", undefined, "system");
    this.persist();
  }

  get isLocked(): boolean {
    return this.masterKey === null;
  }

  /** Store a secret. */
  store_secret(key: string, value: string, accessor: string = "agent"): void {
    this.ensureUnlocked();
    this.touch();
    this.store.secrets[key] = encrypt(value, this.masterKey!);
    this.addAuditEntry("write", key, accessor);
    this.persist();
  }

  /** Read a secret (audit-logged). */
  read_secret(key: string, accessor: string = "agent"): string | undefined {
    this.ensureUnlocked();
    this.touch();
    const payload = this.store.secrets[key];
    if (!payload) return undefined;
    this.addAuditEntry("read", key, accessor);
    this.persist(); // persist audit entry
    return decrypt(payload, this.masterKey!).toString("utf-8");
  }

  /** List secret names (no values). */
  list(): string[] {
    this.ensureUnlocked();
    this.touch();
    this.addAuditEntry("list", undefined, "agent");
    return Object.keys(this.store.secrets);
  }

  /** Delete a secret. */
  delete_secret(key: string, accessor: string = "agent"): boolean {
    this.ensureUnlocked();
    this.touch();
    if (!(key in this.store.secrets)) return false;
    delete this.store.secrets[key];
    this.addAuditEntry("delete", key, accessor);
    this.persist();
    return true;
  }

  /** Get recent audit log entries. */
  getAuditLog(limit: number = 50): AuditLogEntry[] {
    return this.store.audit.slice(-limit);
  }

  /** Check if auto-lock timeout has elapsed. Call periodically. */
  checkAutoLock(): void {
    if (this.masterKey && Date.now() - this.lastAccessTime > this.lockTimeoutMs) {
      this.lock();
    }
  }

  private ensureUnlocked(): void {
    if (this.isLocked) {
      // Auto-unlock using stored private key
      this.unlock();
    }
  }

  private touch(): void {
    this.lastAccessTime = Date.now();
    // Reset auto-lock timer
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), this.lockTimeoutMs);
  }

  private addAuditEntry(action: AuditLogEntry["action"], key: string | undefined, accessor: string): void {
    this.store.audit.push({
      timestamp: new Date().toISOString(),
      action,
      key,
      accessor,
    });
    // Keep audit log bounded
    if (this.store.audit.length > 1000) {
      this.store.audit = this.store.audit.slice(-500);
    }
  }

  private loadStore(): VaultStore {
    if (fs.existsSync(this.vaultPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.vaultPath, "utf-8"));
      } catch {
        // Corrupted — start fresh
      }
    }
    return { secrets: {}, audit: [], version: 1 };
  }

  private persist(): void {
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.vaultPath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }

  /** Destroy the vault — for testing. */
  destroy(): void {
    this.lock();
    if (fs.existsSync(this.vaultPath)) {
      fs.unlinkSync(this.vaultPath);
    }
  }
}
