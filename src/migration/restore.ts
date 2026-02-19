/**
 * Restore System
 *
 * Restore automaton state from backup archives.
 * Supports integrity verification, selective restore, and dry-run mode.
 */

import fs from "fs";
import path from "path";
import {
  loadManifest,
  readBackupData,
  verifyBackupIntegrity,
  decryptBuffer,
  type BackupManifest,
  type BackupFileEntry,
} from "./backup.js";
import { getAutomatonDir } from "../identity/wallet.js";

// ─── Types ─────────────────────────────────────────────────────

export type RestoreCategory = "db" | "config" | "skills" | "wallet" | "heartbeat" | "soul" | "all";

export interface RestoreOptions {
  categories?: RestoreCategory[];
  dryRun?: boolean;
  decryptionKey?: string;
}

export interface RestoreResult {
  dryRun: boolean;
  restoredFiles: string[];
  skippedFiles: string[];
  errors: string[];
}

// ─── Category mapping ──────────────────────────────────────────

const FILE_CATEGORIES: Record<string, RestoreCategory> = {
  "state.db": "db",
  "automaton.json": "config",
  "wallet.json": "wallet",
  "chain-history.json": "wallet",
  "heartbeat.yml": "heartbeat",
  "SOUL.md": "soul",
};

function getCategory(relativePath: string): RestoreCategory {
  const basename = path.basename(relativePath);
  if (FILE_CATEGORIES[basename]) return FILE_CATEGORIES[basename];
  if (relativePath.startsWith("skills/")) return "skills";
  return "config"; // default
}

function shouldRestore(entry: BackupFileEntry, categories: RestoreCategory[]): boolean {
  if (categories.includes("all")) return true;
  return categories.includes(getCategory(entry.relativePath));
}

// ─── Restore ───────────────────────────────────────────────────

export function restoreBackup(
  backupPath: string,
  options: RestoreOptions = {},
): RestoreResult {
  const categories = options.categories || ["all"];
  const dryRun = options.dryRun ?? false;
  const automatonDir = getAutomatonDir();

  // Verify integrity first
  const integrity = verifyBackupIntegrity(backupPath);
  if (!integrity.valid) {
    return {
      dryRun,
      restoredFiles: [],
      skippedFiles: [],
      errors: [`Integrity check failed: ${integrity.errors.join(", ")}`],
    };
  }

  const manifest = loadManifest(backupPath);
  const files = readBackupData(backupPath);

  const restoredFiles: string[] = [];
  const skippedFiles: string[] = [];
  const errors: string[] = [];

  for (const entry of manifest.files) {
    if (!shouldRestore(entry, categories)) {
      skippedFiles.push(entry.relativePath);
      continue;
    }

    let data = files.get(entry.relativePath);
    if (!data) {
      errors.push(`Missing data for: ${entry.relativePath}`);
      continue;
    }

    // Decrypt if needed
    if (entry.encrypted) {
      if (!options.decryptionKey) {
        errors.push(`Cannot restore encrypted file without key: ${entry.relativePath}`);
        continue;
      }
      try {
        data = decryptBuffer(data, options.decryptionKey);
      } catch {
        errors.push(`Decryption failed: ${entry.relativePath}`);
        continue;
      }
    }

    if (!dryRun) {
      const targetPath = path.join(automatonDir, entry.relativePath);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(targetPath, data, { mode: 0o600 });
    }

    restoredFiles.push(entry.relativePath);
  }

  return { dryRun, restoredFiles, skippedFiles, errors };
}
