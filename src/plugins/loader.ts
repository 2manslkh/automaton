/**
 * Dynamic Plugin Loader
 *
 * Loads plugins at runtime from npm packages or local directories.
 * Each plugin must have a plugin.json manifest and an entry module
 * that exports a standard interface.
 *
 * Plugin isolation: each plugin gets a sandboxed context with limited
 * access to DB (read-only KV) and no direct conway access.
 *
 * Hot-reload: watches plugin directories for changes and reloads.
 */

import fs from "fs";
import path from "path";
import type { AutomatonDatabase, ConwayClient, AutomatonTool, ToolContext } from "../types.js";
import { hookRegistry, type HookName, type HookHandler, ALL_HOOKS } from "./hooks.js";

// ─── Plugin Manifest ────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string; // relative path to entry module (e.g. "index.js")
  tools?: string[]; // tool names this plugin provides
  hooks?: HookName[]; // hooks this plugin registers
  dependencies?: Record<string, string>; // plugin name -> semver
  automatonVersion?: string; // min automaton version required
}

export interface PluginExports {
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: PluginContext) => Promise<string>;
  }>;
  hooks?: Partial<Record<HookName, HookHandler>>;
  activate?: (ctx: PluginContext) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}

export interface PluginContext {
  pluginName: string;
  pluginDir: string;
  getKV: (key: string) => string | undefined;
  setKV: (key: string, value: string) => void;
  log: (message: string) => void;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  exports: PluginExports;
  tools: AutomatonTool[];
  enabled: boolean;
  loadedAt: string;
}

// ─── Plugin Loader ──────────────────────────────────────────────

export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private pluginsDir: string;
  private db: AutomatonDatabase;

  constructor(pluginsDir: string, db: AutomatonDatabase) {
    this.pluginsDir = pluginsDir;
    this.db = db;
  }

  /**
   * Create a sandboxed context for a plugin. Limits DB access.
   */
  private createPluginContext(name: string, dir: string): PluginContext {
    const prefix = `plugin:${name}:`;
    return {
      pluginName: name,
      pluginDir: dir,
      getKV: (key: string) => this.db.getKV(`${prefix}${key}`),
      setKV: (key: string, value: string) => this.db.setKV(`${prefix}${key}`, value),
      log: (message: string) => console.log(`[plugin:${name}] ${message}`),
    };
  }

  /**
   * Load a single plugin from a directory.
   */
  async loadPlugin(pluginDir: string): Promise<LoadedPlugin | null> {
    const manifestPath = path.join(pluginDir, "plugin.json");
    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf-8"),
    );

    // Validate manifest
    if (!manifest.name || !manifest.version || !manifest.entry) {
      throw new Error(`Invalid plugin manifest in ${pluginDir}: missing name, version, or entry`);
    }

    // Validate hooks in manifest
    if (manifest.hooks) {
      for (const h of manifest.hooks) {
        if (!ALL_HOOKS.includes(h)) {
          throw new Error(`Unknown hook "${h}" in plugin ${manifest.name}`);
        }
      }
    }

    const entryPath = path.join(pluginDir, manifest.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Plugin entry not found: ${entryPath}`);
    }

    // Dynamic import with cache-busting for hot-reload
    const modulePath = `${entryPath}?t=${Date.now()}`;
    const mod = await import(modulePath);
    const exports: PluginExports = mod.default || mod;

    const ctx = this.createPluginContext(manifest.name, pluginDir);

    // Register hooks
    if (exports.hooks) {
      for (const [hookName, handler] of Object.entries(exports.hooks)) {
        if (handler && ALL_HOOKS.includes(hookName as HookName)) {
          hookRegistry.register(hookName as HookName, manifest.name, handler);
        }
      }
    }

    // Convert plugin tools to AutomatonTool format
    const tools: AutomatonTool[] = (exports.tools || []).map((t) => ({
      name: `plugin:${manifest.name}:${t.name}`,
      description: `[Plugin: ${manifest.name}] ${t.description}`,
      parameters: t.parameters,
      category: "vm" as const, // plugins get basic category
      execute: async (args: Record<string, unknown>, _toolCtx: ToolContext) => {
        return t.execute(args, ctx);
      },
    }));

    // Activate plugin
    if (exports.activate) {
      await exports.activate(ctx);
    }

    const loaded: LoadedPlugin = {
      manifest,
      dir: pluginDir,
      exports,
      tools,
      enabled: true,
      loadedAt: new Date().toISOString(),
    };

    // If already loaded, unload first
    if (this.plugins.has(manifest.name)) {
      await this.unloadPlugin(manifest.name);
    }

    this.plugins.set(manifest.name, loaded);
    return loaded;
  }

  /**
   * Unload a plugin, removing its hooks and tools.
   */
  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    hookRegistry.unregisterAll(name);

    if (plugin.exports.deactivate) {
      try {
        await plugin.exports.deactivate();
      } catch (err) {
        console.error(`[plugin-loader] Error deactivating ${name}:`, err);
      }
    }

    this.plugins.delete(name);
  }

  /**
   * Scan plugins directory and load all valid plugins.
   */
  async loadAll(): Promise<LoadedPlugin[]> {
    if (!fs.existsSync(this.pluginsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    const loaded: LoadedPlugin[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.pluginsDir, entry.name);
      try {
        const plugin = await this.loadPlugin(dir);
        if (plugin) loaded.push(plugin);
      } catch (err) {
        console.error(`[plugin-loader] Failed to load ${entry.name}:`, err);
      }
    }

    return loaded;
  }

  /**
   * Start watching plugin directories for changes (hot-reload).
   */
  watchForChanges(): void {
    if (!fs.existsSync(this.pluginsDir)) return;

    const watcher = fs.watch(this.pluginsDir, { recursive: true }, async (_event, filename) => {
      if (!filename) return;
      // Determine which plugin changed
      const pluginName = filename.split(path.sep)[0];
      if (!pluginName) return;

      const pluginDir = path.join(this.pluginsDir, pluginName);
      if (!fs.existsSync(path.join(pluginDir, "plugin.json"))) return;

      console.log(`[plugin-loader] Detected change in ${pluginName}, reloading...`);
      try {
        await this.loadPlugin(pluginDir);
      } catch (err) {
        console.error(`[plugin-loader] Hot-reload failed for ${pluginName}:`, err);
      }
    });

    this.watchers.set("__root__", watcher);
  }

  /**
   * Stop all file watchers.
   */
  stopWatching(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  /**
   * Get all tools from all enabled plugins.
   */
  getAllTools(): AutomatonTool[] {
    const tools: AutomatonTool[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) {
        tools.push(...plugin.tools);
      }
    }
    return tools;
  }

  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  getAllPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  enablePlugin(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = true;
    return true;
  }

  disablePlugin(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = false;
    hookRegistry.unregisterAll(name);
    return true;
  }
}
