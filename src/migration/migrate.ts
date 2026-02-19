/**
 * Cross-Sandbox Migration
 *
 * Export state from current sandbox, import into a new one,
 * handle identity transfer and verify completeness.
 */

import fs from "fs";
import path from "path";
import { createBackup, loadManifest, readBackupData, verifyBackupIntegrity, type BackupInfo } from "./backup.js";
import { restoreBackup } from "./restore.js";
import { getAutomatonDir } from "../identity/wallet.js";

// ─── Types ─────────────────────────────────────────────────────

export interface MigrationExport {
  backup: BackupInfo;
  sourceSandboxId: string;
  exportedAt: string;
}

export interface MigrationImportOptions {
  backupPath: string;
  newSandboxId: string;
  decryptionKey?: string;
}

export interface MigrationResult {
  success: boolean;
  sourceSandboxId: string;
  targetSandboxId: string;
  filesRestored: number;
  identityUpdated: boolean;
  errors: string[];
}

// ─── Export ────────────────────────────────────────────────────

export function exportForMigration(
  sandboxId: string,
  encryptionKey?: string,
  outputDir?: string,
): MigrationExport {
  const backup = createBackup(sandboxId, {
    type: "full",
    encryptionKey,
    outputDir,
  });

  return {
    backup,
    sourceSandboxId: sandboxId,
    exportedAt: new Date().toISOString(),
  };
}

// ─── Import ────────────────────────────────────────────────────

export function importMigration(options: MigrationImportOptions): MigrationResult {
  const { backupPath, newSandboxId, decryptionKey } = options;
  const errors: string[] = [];

  // Verify integrity
  const integrity = verifyBackupIntegrity(backupPath);
  if (!integrity.valid) {
    return {
      success: false,
      sourceSandboxId: "",
      targetSandboxId: newSandboxId,
      filesRestored: 0,
      identityUpdated: false,
      errors: [`Integrity check failed: ${integrity.errors.join(", ")}`],
    };
  }

  const manifest = loadManifest(backupPath);
  const sourceSandboxId = manifest.sandboxId;

  // Restore all files
  const result = restoreBackup(backupPath, {
    categories: ["all"],
    dryRun: false,
    decryptionKey,
  });

  if (result.errors.length > 0) {
    errors.push(...result.errors);
  }

  // Update sandbox ID in config
  let identityUpdated = false;
  const automatonDir = getAutomatonDir();
  const configPath = path.join(automatonDir, "automaton.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      config.sandboxId = newSandboxId;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      identityUpdated = true;
    } catch (e: any) {
      errors.push(`Failed to update config sandboxId: ${e.message}`);
    }
  }

  return {
    success: errors.length === 0,
    sourceSandboxId,
    targetSandboxId: newSandboxId,
    filesRestored: result.restoredFiles.length,
    identityUpdated,
    errors,
  };
}

// ─── Verification ──────────────────────────────────────────────

export function verifyMigration(backupPath: string): {
  complete: boolean;
  missingFiles: string[];
  presentFiles: string[];
} {
  const manifest = loadManifest(backupPath);
  const automatonDir = getAutomatonDir();
  const missingFiles: string[] = [];
  const presentFiles: string[] = [];

  for (const entry of manifest.files) {
    const targetPath = path.join(automatonDir, entry.relativePath);
    if (fs.existsSync(targetPath)) {
      presentFiles.push(entry.relativePath);
    } else {
      missingFiles.push(entry.relativePath);
    }
  }

  return {
    complete: missingFiles.length === 0,
    missingFiles,
    presentFiles,
  };
}
