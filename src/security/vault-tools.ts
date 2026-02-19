/**
 * Vault Tools
 *
 * Tools for storing/reading/listing/deleting secrets in the encrypted vault.
 */

import type { AutomatonTool } from "../types.js";
import { Vault } from "./vault.js";
import path from "path";
import { getAutomatonDir } from "../identity/wallet.js";

let vaultInstance: Vault | null = null;

function getVault(privateKeyHex: string): Vault {
  if (!vaultInstance) {
    const vaultPath = path.join(getAutomatonDir(), "vault.json");
    vaultInstance = new Vault({ vaultPath, privateKeyHex });
  }
  return vaultInstance;
}

export function createVaultTools(): AutomatonTool[] {
  return [
    {
      name: "vault_store",
      description: "Store a secret in the encrypted vault. The value is encrypted at rest with AES-256-GCM.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Secret name/identifier" },
          value: { type: "string", description: "Secret value to encrypt and store" },
        },
        required: ["key", "value"],
      },
      execute: async (args, ctx) => {
        const vault = getVault((ctx.identity.account as any).source?.slice(2) || "");
        vault.store_secret(args.key as string, args.value as string, ctx.identity.name);
        return `Secret "${args.key}" stored successfully.`;
      },
    },
    {
      name: "vault_read",
      description: "Read a secret from the encrypted vault. Access is audit-logged.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Secret name to read" },
        },
        required: ["key"],
      },
      execute: async (args, ctx) => {
        const vault = getVault((ctx.identity.account as any).source?.slice(2) || "");
        const value = vault.read_secret(args.key as string, ctx.identity.name);
        if (value === undefined) return `Secret "${args.key}" not found.`;
        return value;
      },
    },
    {
      name: "vault_list",
      description: "List all secret names in the vault (values are NOT returned).",
      category: "vm",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const vault = getVault((ctx.identity.account as any).source?.slice(2) || "");
        const keys = vault.list();
        if (keys.length === 0) return "Vault is empty.";
        return `Stored secrets (${keys.length}):\n${keys.map((k) => `  - ${k}`).join("\n")}`;
      },
    },
    {
      name: "vault_delete",
      description: "Delete a secret from the vault.",
      category: "vm",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Secret name to delete" },
        },
        required: ["key"],
      },
      execute: async (args, ctx) => {
        const vault = getVault((ctx.identity.account as any).source?.slice(2) || "");
        const deleted = vault.delete_secret(args.key as string, ctx.identity.name);
        return deleted ? `Secret "${args.key}" deleted.` : `Secret "${args.key}" not found.`;
      },
    },
  ];
}
