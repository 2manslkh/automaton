/**
 * Migration Tools
 *
 * Tool definitions for backup, restore, list, and migrate operations.
 */

import type { AutomatonTool } from "../types.js";
import { createBackup, listBackups } from "./backup.js";
import { restoreBackup, type RestoreCategory } from "./restore.js";
import { exportForMigration, importMigration, verifyMigration, exportPortable, importPortable } from "./migrate.js";

export function createMigrationTools(): AutomatonTool[] {
  return [
    {
      name: "create_backup",
      description: "Create a full or incremental backup of automaton state (DB, config, wallet, skills, SOUL.md).",
      category: "migration",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["full", "incremental"], description: "Backup type" },
          encryption_key: { type: "string", description: "Optional key to encrypt sensitive files" },
          max_retained: { type: "number", description: "Max backups to keep (auto-prune older)" },
        },
      },
      async execute(args, context) {
        const info = createBackup(context.config.sandboxId, {
          type: (args.type as "full" | "incremental") || "full",
          encryptionKey: args.encryption_key as string | undefined,
          maxRetained: args.max_retained as number | undefined,
        });
        return JSON.stringify(info, null, 2);
      },
    },
    {
      name: "list_backups",
      description: "List available backups with size, date, and file count.",
      category: "migration",
      parameters: { type: "object", properties: {} },
      async execute(_args, _context) {
        const backups = listBackups();
        if (backups.length === 0) return "No backups found.";
        return backups.map(b =>
          `${b.id} | ${b.type} | ${b.fileCount} files | ${(b.size / 1024).toFixed(1)}KB | ${b.createdAt}`
        ).join("\n");
      },
    },
    {
      name: "restore_backup",
      description: "Restore automaton state from a backup. Supports selective restore and dry-run.",
      category: "migration",
      parameters: {
        type: "object",
        properties: {
          backup_path: { type: "string", description: "Path to backup directory" },
          categories: {
            type: "array",
            items: { type: "string", enum: ["db", "config", "skills", "wallet", "heartbeat", "soul", "all"] },
            description: "Which categories to restore (default: all)",
          },
          dry_run: { type: "boolean", description: "Preview without restoring" },
          decryption_key: { type: "string", description: "Key to decrypt sensitive files" },
        },
        required: ["backup_path"],
      },
      async execute(args, _context) {
        const result = restoreBackup(args.backup_path as string, {
          categories: (args.categories as RestoreCategory[]) || ["all"],
          dryRun: args.dry_run as boolean | undefined,
          decryptionKey: args.decryption_key as string | undefined,
        });
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "migrate_to_sandbox",
      description: "Migrate automaton state to a new Conway sandbox. Exports current state, can import into target.",
      category: "migration",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["export", "import", "verify"], description: "Migration action" },
          new_sandbox_id: { type: "string", description: "Target sandbox ID (for import)" },
          backup_path: { type: "string", description: "Backup path (for import/verify)" },
          encryption_key: { type: "string", description: "Encryption/decryption key" },
        },
        required: ["action"],
      },
      async execute(args, context) {
        const action = args.action as string;
        if (action === "export") {
          const result = exportForMigration(
            context.config.sandboxId,
            args.encryption_key as string | undefined,
          );
          return JSON.stringify(result, null, 2);
        }
        if (action === "import") {
          if (!args.backup_path || !args.new_sandbox_id) {
            return "Error: backup_path and new_sandbox_id required for import";
          }
          const result = importMigration({
            backupPath: args.backup_path as string,
            newSandboxId: args.new_sandbox_id as string,
            decryptionKey: args.encryption_key as string | undefined,
          });
          return JSON.stringify(result, null, 2);
        }
        if (action === "verify") {
          if (!args.backup_path) return "Error: backup_path required for verify";
          const result = verifyMigration(args.backup_path as string);
          return JSON.stringify(result, null, 2);
        }
        return `Unknown action: ${action}`;
      },
    },
    {
      name: "portable_export",
      description: "Export automaton state as a single portable file for easy transfer between sandboxes (scp, upload, etc).",
      category: "migration",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Output file path (default: ~/automaton-export.bin)" },
          encryption_key: { type: "string", description: "Optional key to encrypt sensitive files" },
        },
      },
      async execute(args, context) {
        const outputPath = (args.output_path as string) || `${process.env.HOME}/automaton-export.bin`;
        const result = exportPortable(
          context.config.sandboxId,
          outputPath,
          args.encryption_key as string | undefined,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "portable_import",
      description: "Import automaton state from a portable export file into this sandbox.",
      category: "migration",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the portable export file" },
          new_sandbox_id: { type: "string", description: "New sandbox ID for this instance" },
          decryption_key: { type: "string", description: "Key to decrypt sensitive files" },
        },
        required: ["file_path", "new_sandbox_id"],
      },
      async execute(args, _context) {
        const result = importPortable(
          args.file_path as string,
          args.new_sandbox_id as string,
          args.decryption_key as string | undefined,
        );
        return JSON.stringify(result, null, 2);
      },
    },
  ];
}
