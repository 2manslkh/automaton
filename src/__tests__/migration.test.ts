import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createBackup,
  listBackups,
  verifyBackupIntegrity,
  readBackupData,
  loadManifest,
  pruneBackups,
} from "../migration/backup.js";
import { restoreBackup } from "../migration/restore.js";
import { exportForMigration, importMigration, verifyMigration, exportPortable, importPortable } from "../migration/migrate.js";

// Use a temp dir as ~/.automaton for tests
let tmpHome: string;
let origHome: string;

beforeEach(() => {
  origHome = process.env.HOME || "/root";
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-test-"));
  process.env.HOME = tmpHome;

  // Create fake automaton dir with test files
  const autoDir = path.join(tmpHome, ".automaton");
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, "automaton.json"), JSON.stringify({ sandboxId: "sandbox-1", name: "test" }));
  fs.writeFileSync(path.join(autoDir, "heartbeat.yml"), "entries: []");
  fs.writeFileSync(path.join(autoDir, "SOUL.md"), "# I am a test automaton");
  fs.writeFileSync(path.join(autoDir, "wallet.json"), JSON.stringify({ privateKey: "0xdeadbeef" }));
  fs.writeFileSync(path.join(autoDir, "state.db"), "fake-db-content");

  // Skills
  const skillsDir = path.join(autoDir, "skills", "web");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# Web skill");
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("backup", () => {
  it("creates a full backup with all files", () => {
    const info = createBackup("sandbox-1");
    expect(info.type).toBe("full");
    expect(info.fileCount).toBeGreaterThanOrEqual(5);
    expect(info.size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(info.path, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(info.path, "data.gz"))).toBe(true);
  });

  it("creates incremental backup skipping unchanged files", () => {
    createBackup("sandbox-1", { type: "full" });
    const inc = createBackup("sandbox-1", { type: "incremental" });
    expect(inc.type).toBe("incremental");
    expect(inc.fileCount).toBe(0);

    const autoDir = path.join(tmpHome, ".automaton");
    fs.writeFileSync(path.join(autoDir, "SOUL.md"), "# Updated soul");
    const inc2 = createBackup("sandbox-1", { type: "incremental" });
    expect(inc2.fileCount).toBe(1);
  });

  it("lists backups", () => {
    createBackup("sandbox-1");
    createBackup("sandbox-1");
    const backups = listBackups();
    expect(backups.length).toBe(2);
  });

  it("encrypts wallet.json when key provided", () => {
    const info = createBackup("sandbox-1", { encryptionKey: "secret123" });
    const manifest = loadManifest(info.path);
    const walletEntry = manifest.files.find(f => f.relativePath === "wallet.json");
    expect(walletEntry?.encrypted).toBe(true);
  });

  it("prunes old backups", () => {
    createBackup("sandbox-1");
    createBackup("sandbox-1");
    createBackup("sandbox-1");
    const autoDir = path.join(tmpHome, ".automaton", "backups");
    const pruned = pruneBackups(autoDir, 1);
    expect(pruned).toBe(2);
    expect(listBackups().length).toBe(1);
  });
});

describe("integrity verification", () => {
  it("passes for valid backup", () => {
    const info = createBackup("sandbox-1");
    const result = verifyBackupIntegrity(info.path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when data is corrupted", () => {
    const info = createBackup("sandbox-1");
    // Corrupt the manifest checksum
    const manifestPath = path.join(info.path, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.checksum = "badhash";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyBackupIntegrity(info.path);
    expect(result.valid).toBe(false);
  });
});

describe("restore", () => {
  it("restores all files", () => {
    const info = createBackup("sandbox-1");
    // Delete a file
    const autoDir = path.join(tmpHome, ".automaton");
    fs.unlinkSync(path.join(autoDir, "SOUL.md"));
    expect(fs.existsSync(path.join(autoDir, "SOUL.md"))).toBe(false);

    const result = restoreBackup(info.path);
    expect(result.errors).toHaveLength(0);
    expect(result.restoredFiles).toContain("SOUL.md");
    expect(fs.existsSync(path.join(autoDir, "SOUL.md"))).toBe(true);
  });

  it("selective restore only restores requested categories", () => {
    const info = createBackup("sandbox-1");
    const result = restoreBackup(info.path, { categories: ["soul"], dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.restoredFiles).toContain("SOUL.md");
    expect(result.skippedFiles.length).toBeGreaterThan(0);
  });

  it("dry-run does not modify files", () => {
    const info = createBackup("sandbox-1");
    const autoDir = path.join(tmpHome, ".automaton");
    fs.unlinkSync(path.join(autoDir, "SOUL.md"));

    restoreBackup(info.path, { dryRun: true });
    expect(fs.existsSync(path.join(autoDir, "SOUL.md"))).toBe(false);
  });

  it("restores encrypted wallet with correct key", () => {
    const info = createBackup("sandbox-1", { encryptionKey: "mykey" });
    const autoDir = path.join(tmpHome, ".automaton");
    fs.unlinkSync(path.join(autoDir, "wallet.json"));

    const result = restoreBackup(info.path, { decryptionKey: "mykey" });
    expect(result.errors).toHaveLength(0);
    const restored = JSON.parse(fs.readFileSync(path.join(autoDir, "wallet.json"), "utf-8"));
    expect(restored.privateKey).toBe("0xdeadbeef");
  });

  it("fails to restore encrypted wallet without key", () => {
    const info = createBackup("sandbox-1", { encryptionKey: "mykey" });
    const result = restoreBackup(info.path);
    expect(result.errors.some(e => e.includes("without key"))).toBe(true);
  });
});

describe("migration", () => {
  it("exports and imports to new sandbox", () => {
    const exported = exportForMigration("sandbox-1");
    expect(exported.sourceSandboxId).toBe("sandbox-1");

    const result = importMigration({
      backupPath: exported.backup.path,
      newSandboxId: "sandbox-2",
    });
    expect(result.success).toBe(true);
    expect(result.identityUpdated).toBe(true);
    expect(result.targetSandboxId).toBe("sandbox-2");

    // Verify config was updated
    const autoDir = path.join(tmpHome, ".automaton");
    const config = JSON.parse(fs.readFileSync(path.join(autoDir, "automaton.json"), "utf-8"));
    expect(config.sandboxId).toBe("sandbox-2");
  });

  it("verifies migration completeness", () => {
    const exported = exportForMigration("sandbox-1");
    const verification = verifyMigration(exported.backup.path);
    expect(verification.complete).toBe(true);
    expect(verification.missingFiles).toHaveLength(0);
  });
});

describe("portable export/import", () => {
  it("exports and imports via single file", () => {
    const outputPath = path.join(tmpHome, "export.bin");
    const exported = exportPortable("sandbox-1", outputPath);
    expect(exported.fileCount).toBeGreaterThanOrEqual(5);
    expect(exported.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(outputPath)).toBe(true);

    // Modify config to confirm import overwrites it
    const autoDir = path.join(tmpHome, ".automaton");
    const config = JSON.parse(fs.readFileSync(path.join(autoDir, "automaton.json"), "utf-8"));
    config.name = "modified";
    fs.writeFileSync(path.join(autoDir, "automaton.json"), JSON.stringify(config));

    const result = importPortable(outputPath, "sandbox-new");
    expect(result.success).toBe(true);
    expect(result.targetSandboxId).toBe("sandbox-new");
    expect(result.filesRestored).toBeGreaterThanOrEqual(5);

    // Verify sandbox ID was updated
    const restoredConfig = JSON.parse(fs.readFileSync(path.join(autoDir, "automaton.json"), "utf-8"));
    expect(restoredConfig.sandboxId).toBe("sandbox-new");
  });

  it("handles encrypted portable export/import", () => {
    const outputPath = path.join(tmpHome, "export-enc.bin");
    const exported = exportPortable("sandbox-1", outputPath, "secretkey");
    expect(exported.fileCount).toBeGreaterThanOrEqual(5);

    const result = importPortable(outputPath, "sandbox-enc", "secretkey");
    expect(result.success).toBe(true);

    // Verify wallet was decrypted correctly
    const autoDir = path.join(tmpHome, ".automaton");
    const wallet = JSON.parse(fs.readFileSync(path.join(autoDir, "wallet.json"), "utf-8"));
    expect(wallet.privateKey).toBe("0xdeadbeef");
  });
});
