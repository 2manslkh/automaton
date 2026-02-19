/**
 * Backup System
 *
 * Full and incremental backups of automaton state:
 * DB, config, SOUL.md, skills, wallet (encrypted), heartbeat config.
 * Compressed with gzip, integrity verified with SHA-256 checksums.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { getAutomatonDir } from "../identity/wallet.js";

// ─── Types ─────────────────────────────────────────────────────

export interface BackupManifest {
  version: number;
  type: "full" | "incremental";
  createdAt: string;
  sandboxId: string;
  parentBackupId?: string;
  files: BackupFileEntry[];
  checksum: string; // SHA-256 of concatenated file checksums
}

export interface BackupFileEntry {
  relativePath: string;
  checksum: string;
  size: number;
  encrypted: boolean;
  modifiedAt: string;
}

export interface BackupInfo {
  id: string;
  type: "full" | "incremental";
  createdAt: string;
  size: number;
  fileCount: number;
  path: string;
}

export interface BackupOptions {
  type?: "full" | "incremental";
  encryptionKey?: string;
  maxRetained?: number;
  outputDir?: string;
}

const MANIFEST_VERSION = 1;
const BACKUP_DIR_NAME = "backups";

// Files to back up (relative to automaton dir)
const BACKUP_TARGETS = [
  "automaton.json",
  "heartbeat.yml",
  "wallet.json",
  "chain-history.json",
  "state.db",
  "SOUL.md",
];

const SENSITIVE_FILES = new Set(["wallet.json"]);

// ─── Helpers ───────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function encryptBuffer(data: Buffer, key: string): Buffer {
  const iv = crypto.randomBytes(16);
  const keyHash = crypto.createHash("sha256").update(key).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", keyHash, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

export function decryptBuffer(data: Buffer, key: string): Buffer {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const keyHash = crypto.createHash("sha256").update(key).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", keyHash, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function getBackupDir(outputDir?: string): string {
  return outputDir || path.join(getAutomatonDir(), BACKUP_DIR_NAME);
}

function generateBackupId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const rand = crypto.randomBytes(3).toString("hex");
  return `backup_${ts}_${rand}`;
}

// ─── Skills directory scanning ─────────────────────────────────

function getSkillFiles(automatonDir: string): string[] {
  const skillsDir = path.join(automatonDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const results: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else results.push(path.join("skills", rel));
    }
  };
  walk(skillsDir, "");
  return results;
}

// ─── Last backup state (for incremental) ──────────────────────

function getLastManifest(backupDir: string): BackupManifest | null {
  const manifests = listBackupManifests(backupDir);
  if (manifests.length === 0) return null;
  const latest = manifests[manifests.length - 1];
  const manifestPath = path.join(backupDir, latest.id, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function listBackupManifests(backupDir: string): BackupInfo[] {
  if (!fs.existsSync(backupDir)) return [];
  const entries = fs.readdirSync(backupDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith("backup_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map(e => {
    const manifestPath = path.join(backupDir, e.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) return null;
    const manifest: BackupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const dataPath = path.join(backupDir, e.name, "data.gz");
    const size = fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0;
    return {
      id: e.name,
      type: manifest.type,
      createdAt: manifest.createdAt,
      size,
      fileCount: manifest.files.length,
      path: path.join(backupDir, e.name),
    } as BackupInfo;
  }).filter(Boolean) as BackupInfo[];
}

// ─── Core Backup ───────────────────────────────────────────────

export function createBackup(
  sandboxId: string,
  options: BackupOptions = {},
): BackupInfo {
  const automatonDir = getAutomatonDir();
  const backupDir = getBackupDir(options.outputDir);
  const backupType = options.type || "full";
  const backupId = generateBackupId();
  const backupPath = path.join(backupDir, backupId);

  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  // Collect target files
  const allTargets = [...BACKUP_TARGETS, ...getSkillFiles(automatonDir)];

  // For incremental, get last manifest to diff
  let lastManifest: BackupManifest | null = null;
  if (backupType === "incremental") {
    lastManifest = getLastManifest(backupDir);
  }

  const lastChecksums = new Map<string, string>();
  if (lastManifest) {
    for (const f of lastManifest.files) {
      lastChecksums.set(f.relativePath, f.checksum);
    }
  }

  // Build file entries and data buffer
  const fileEntries: BackupFileEntry[] = [];
  const fileBuffers: { rel: string; data: Buffer }[] = [];

  for (const rel of allTargets) {
    const absPath = path.join(automatonDir, rel);
    if (!fs.existsSync(absPath)) continue;

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) continue;

    let data = fs.readFileSync(absPath);
    const checksum = sha256(data);

    // Skip unchanged files for incremental
    if (backupType === "incremental" && lastChecksums.get(rel) === checksum) {
      continue;
    }

    const isSensitive = SENSITIVE_FILES.has(path.basename(rel));
    if (isSensitive && options.encryptionKey) {
      data = encryptBuffer(data, options.encryptionKey);
    }

    fileEntries.push({
      relativePath: rel,
      checksum,
      size: stat.size,
      encrypted: isSensitive && !!options.encryptionKey,
      modifiedAt: stat.mtime.toISOString(),
    });

    fileBuffers.push({ rel, data });
  }

  // Create tar-like concatenated buffer with length-prefixed entries
  const chunks: Buffer[] = [];
  for (const { rel, data } of fileBuffers) {
    const header = Buffer.from(JSON.stringify({ path: rel, size: data.length }) + "\n");
    const headerLen = Buffer.alloc(4);
    headerLen.writeUInt32BE(header.length);
    chunks.push(headerLen, header, data);
  }
  const rawData = Buffer.concat(chunks);
  const compressed = zlib.gzipSync(rawData);

  fs.writeFileSync(path.join(backupPath, "data.gz"), compressed, { mode: 0o600 });

  // Build manifest
  const manifestChecksum = sha256(fileEntries.map(f => f.checksum).join(""));
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    type: backupType,
    createdAt: new Date().toISOString(),
    sandboxId,
    parentBackupId: lastManifest ? undefined : undefined,
    files: fileEntries,
    checksum: manifestChecksum,
  };

  if (backupType === "incremental" && lastManifest) {
    // Find the parent backup id from the directory listing
    const allBackups = listBackupManifests(backupDir);
    if (allBackups.length > 0) {
      manifest.parentBackupId = allBackups[allBackups.length - 1].id;
    }
  }

  fs.writeFileSync(
    path.join(backupPath, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );

  // Prune old backups
  if (options.maxRetained && options.maxRetained > 0) {
    pruneBackups(backupDir, options.maxRetained);
  }

  return {
    id: backupId,
    type: backupType,
    createdAt: manifest.createdAt,
    size: compressed.length,
    fileCount: fileEntries.length,
    path: backupPath,
  };
}

// ─── List & Prune ──────────────────────────────────────────────

export function listBackups(outputDir?: string): BackupInfo[] {
  return listBackupManifests(getBackupDir(outputDir));
}

export function pruneBackups(backupDir: string, maxRetained: number): number {
  const backups = listBackupManifests(backupDir);
  let pruned = 0;
  while (backups.length - pruned > maxRetained) {
    const toRemove = backups[pruned];
    fs.rmSync(toRemove.path, { recursive: true, force: true });
    pruned++;
  }
  return pruned;
}

// ─── Read backup data ──────────────────────────────────────────

export function readBackupData(backupPath: string): Map<string, Buffer> {
  const dataPath = path.join(backupPath, "data.gz");
  const compressed = fs.readFileSync(dataPath);
  const raw = zlib.gunzipSync(compressed);

  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset < raw.length) {
    const headerLen = raw.readUInt32BE(offset);
    offset += 4;
    const header = JSON.parse(raw.subarray(offset, offset + headerLen).toString());
    offset += headerLen;
    const data = raw.subarray(offset, offset + header.size);
    offset += header.size;
    files.set(header.path, Buffer.from(data));
  }

  return files;
}

export function loadManifest(backupPath: string): BackupManifest {
  return JSON.parse(fs.readFileSync(path.join(backupPath, "manifest.json"), "utf-8"));
}

export function verifyBackupIntegrity(backupPath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const manifest = loadManifest(backupPath);
  const files = readBackupData(backupPath);

  // Verify manifest checksum
  const expectedManifestChecksum = sha256(manifest.files.map(f => f.checksum).join(""));
  if (expectedManifestChecksum !== manifest.checksum) {
    errors.push("Manifest checksum mismatch");
  }

  // Verify each file's checksum (skip encrypted files — checksum is of plaintext)
  for (const entry of manifest.files) {
    const data = files.get(entry.relativePath);
    if (!data) {
      errors.push(`Missing file: ${entry.relativePath}`);
      continue;
    }
    if (!entry.encrypted) {
      const actual = sha256(data);
      if (actual !== entry.checksum) {
        errors.push(`Checksum mismatch: ${entry.relativePath}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
