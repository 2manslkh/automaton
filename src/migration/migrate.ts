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

// ─── Portable Single-File Export/Import ────────────────────────

export interface PortableExport {
  filePath: string;
  sandboxId: string;
  fileCount: number;
  sizeBytes: number;
  exportedAt: string;
}

/**
 * Export automaton state as a single portable .gz file.
 * Bundles manifest + data for easy transfer via scp/upload.
 */
export function exportPortable(
  sandboxId: string,
  outputPath: string,
  encryptionKey?: string,
): PortableExport {
  const backup = createBackup(sandboxId, { type: "full", encryptionKey });
  const manifest = loadManifest(backup.path);
  const dataGz = fs.readFileSync(path.join(backup.path, "data.gz"));

  // Bundle: 4-byte manifest length + manifest JSON + data.gz
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBuf.length);
  const bundle = Buffer.concat([header, manifestBuf, dataGz]);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, bundle, { mode: 0o600 });

  // Clean up the intermediate backup directory
  fs.rmSync(backup.path, { recursive: true, force: true });

  return {
    filePath: outputPath,
    sandboxId,
    fileCount: manifest.files.length,
    sizeBytes: bundle.length,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Import automaton state from a portable .gz bundle.
 */
export function importPortable(
  bundlePath: string,
  newSandboxId: string,
  decryptionKey?: string,
): MigrationResult {
  const bundle = fs.readFileSync(bundlePath);
  const manifestLen = bundle.readUInt32BE(0);
  const manifest = JSON.parse(bundle.subarray(4, 4 + manifestLen).toString());
  const dataGz = bundle.subarray(4 + manifestLen);

  // Write to a temp backup dir so we can use restoreBackup
  const tmpDir = path.join(getAutomatonDir(), "backups", "_portable_import");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(tmpDir, "data.gz"), dataGz);

  const result = importMigration({
    backupPath: tmpDir,
    newSandboxId,
    decryptionKey,
  });

  // Clean up temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return result;
}
