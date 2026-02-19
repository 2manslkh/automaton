/**
 * Tests for the plugin system: loader, registry, hooks, enable/disable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { HookRegistry } from "../plugins/hooks.js";
import { PluginLoader, type PluginManifest } from "../plugins/loader.js";
import { installFromLocal, checkDependencies, checkVersionCompatibility } from "../plugins/registry.js";
import { createTestDb } from "./mocks.js";

let tmpDir: string;

function createTestDb2() {
  // Use the mock helper if available, otherwise create inline
  return (createTestDb as any)?.() ?? createMockDb();
}

function createMockDb() {
  const kv: Record<string, string> = {};
  return {
    getKV: (key: string) => kv[key],
    setKV: (key: string, value: string) => { kv[key] = value; },
    deleteKV: (key: string) => { delete kv[key]; },
  } as any;
}

/**
 * Helper to create a minimal plugin on disk.
 */
function createTestPlugin(
  dir: string,
  name: string,
  opts: {
    version?: string;
    hooks?: string[];
    tools?: boolean;
    dependencies?: Record<string, string>;
  } = {},
): string {
  const pluginDir = path.join(dir, name);
  fs.mkdirSync(pluginDir, { recursive: true });

  const manifest: PluginManifest = {
    name,
    version: opts.version || "1.0.0",
    description: `Test plugin ${name}`,
    entry: "index.mjs",
    hooks: (opts.hooks || []) as any,
    tools: opts.tools ? ["test_tool"] : [],
    dependencies: opts.dependencies,
  };

  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));

  // Write the entry module
  const toolsCode = opts.tools
    ? `tools: [{ name: "test_tool", description: "A test tool", parameters: { type: "object", properties: {} }, execute: async (args, ctx) => "tool_result_from_" + ctx.pluginName }],`
    : "";

  const hooksCode = (opts.hooks || []).length > 0
    ? `hooks: { ${(opts.hooks || []).map((h) => `${h}: async (ctx) => { globalThis.__hookCalls = globalThis.__hookCalls || []; globalThis.__hookCalls.push("${name}:${h}"); }`).join(", ")} },`
    : "";

  const code = `
export default {
  ${toolsCode}
  ${hooksCode}
  activate: async (ctx) => { ctx.setKV("activated", "true"); },
  deactivate: async () => { globalThis.__deactivated_${name.replace(/-/g, "_")} = true; },
};
`;

  fs.writeFileSync(path.join(pluginDir, "index.mjs"), code);
  return pluginDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
  (globalThis as any).__hookCalls = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete (globalThis as any).__hookCalls;
});

// ─── Hook Registry Tests ────────────────────────────────────────

describe("HookRegistry", () => {
  it("registers and emits hooks", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.register("onTurnStart", "test-plugin", async (ctx) => {
      calls.push(`start:${ctx.pluginName}`);
    });

    await registry.emit("onTurnStart", {});
    expect(calls).toEqual(["start:test-plugin"]);
  });

  it("handles errors in hooks without propagating", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.register("onTurnEnd", "bad-plugin", async () => {
      throw new Error("boom");
    });
    registry.register("onTurnEnd", "good-plugin", async (ctx) => {
      calls.push("good");
    });

    await registry.emit("onTurnEnd", {});
    expect(calls).toEqual(["good"]);
  });

  it("unregisters all hooks for a plugin", async () => {
    const registry = new HookRegistry();
    registry.register("onSleep", "p1", async () => {});
    registry.register("onWake", "p1", async () => {});
    registry.register("onSleep", "p2", async () => {});

    registry.unregisterAll("p1");
    const hooks = registry.getRegisteredHooks();
    expect(hooks.every((h) => h.pluginName !== "p1")).toBe(true);
    expect(hooks.some((h) => h.pluginName === "p2")).toBe(true);
  });

  it("rejects unknown hook names", () => {
    const registry = new HookRegistry();
    expect(() =>
      registry.register("onBogus" as any, "test", async () => {}),
    ).toThrow("Unknown hook");
  });

  it("getRegisteredHooks filters by plugin name", () => {
    const registry = new HookRegistry();
    registry.register("onTurnStart", "a", async () => {});
    registry.register("onTurnEnd", "b", async () => {});

    expect(registry.getRegisteredHooks("a")).toHaveLength(1);
    expect(registry.getRegisteredHooks("a")[0].hookName).toBe("onTurnStart");
  });
});

// ─── Plugin Loader Tests ────────────────────────────────────────

describe("PluginLoader", () => {
  it("loads a plugin from directory", async () => {
    const db = createMockDb();
    createTestPlugin(tmpDir, "hello-plugin", { tools: true });

    const loader = new PluginLoader(tmpDir, db);
    const plugin = await loader.loadPlugin(path.join(tmpDir, "hello-plugin"));

    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.name).toBe("hello-plugin");
    expect(plugin!.tools).toHaveLength(1);
    expect(plugin!.enabled).toBe(true);
    // Activation should have set KV
    expect(db.getKV("plugin:hello-plugin:activated")).toBe("true");
  });

  it("loadAll discovers all plugins", async () => {
    const db = createMockDb();
    createTestPlugin(tmpDir, "p1");
    createTestPlugin(tmpDir, "p2");

    const loader = new PluginLoader(tmpDir, db);
    const plugins = await loader.loadAll();

    expect(plugins).toHaveLength(2);
  });

  it("enable and disable plugins", async () => {
    const db = createMockDb();
    createTestPlugin(tmpDir, "toggle-plugin", { tools: true });

    const loader = new PluginLoader(tmpDir, db);
    await loader.loadAll();

    expect(loader.getAllTools()).toHaveLength(1);

    loader.disablePlugin("toggle-plugin");
    expect(loader.getPlugin("toggle-plugin")!.enabled).toBe(false);
    expect(loader.getAllTools()).toHaveLength(0);

    loader.enablePlugin("toggle-plugin");
    expect(loader.getPlugin("toggle-plugin")!.enabled).toBe(true);
    expect(loader.getAllTools()).toHaveLength(1);
  });

  it("unloads plugin and calls deactivate", async () => {
    const db = createMockDb();
    createTestPlugin(tmpDir, "unload-me");

    const loader = new PluginLoader(tmpDir, db);
    await loader.loadPlugin(path.join(tmpDir, "unload-me"));

    await loader.unloadPlugin("unload-me");
    expect(loader.getPlugin("unload-me")).toBeUndefined();
  });

  it("rejects invalid manifest", async () => {
    const db = createMockDb();
    const dir = path.join(tmpDir, "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "bad" }));

    const loader = new PluginLoader(tmpDir, db);
    await expect(loader.loadPlugin(dir)).rejects.toThrow("missing name, version, or entry");
  });

  it("registers hooks from plugin", async () => {
    const db = createMockDb();
    createTestPlugin(tmpDir, "hook-plugin", { hooks: ["onTurnStart", "onTurnEnd"] });

    const { hookRegistry } = await import("../plugins/hooks.js");
    hookRegistry.clear();

    const loader = new PluginLoader(tmpDir, db);
    await loader.loadPlugin(path.join(tmpDir, "hook-plugin"));

    const hooks = hookRegistry.getRegisteredHooks("hook-plugin");
    expect(hooks).toHaveLength(2);

    await hookRegistry.emit("onTurnStart", {});
    expect((globalThis as any).__hookCalls).toContain("hook-plugin:onTurnStart");
  });
});

// ─── Registry Tests ─────────────────────────────────────────────

describe("Plugin Registry", () => {
  it("installFromLocal copies plugin to target dir", async () => {
    const sourceDir = path.join(tmpDir, "source");
    createTestPlugin(tmpDir, "source");

    const targetDir = path.join(tmpDir, "installed");
    fs.mkdirSync(targetDir, { recursive: true });

    // Read the manifest to know the plugin name
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "plugin.json"), "utf-8"));

    const result = await installFromLocal(sourceDir, targetDir);
    expect(result.success).toBe(true);
    expect(result.name).toBe("source");
    expect(fs.existsSync(path.join(targetDir, "source", "plugin.json"))).toBe(true);
  });

  it("checkDependencies reports missing deps", () => {
    const db = createMockDb();
    const loader = new PluginLoader(tmpDir, db);

    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      description: "test",
      entry: "index.mjs",
      dependencies: { "missing-dep": "^1.0.0" },
    };

    const result = checkDependencies(manifest, loader);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain("missing-dep");
  });

  it("checkVersionCompatibility works", () => {
    expect(checkVersionCompatibility({ name: "t", version: "1.0.0", description: "", entry: "i.js", automatonVersion: ">=0.1.0" }, "0.1.0")).toBe(true);
    expect(checkVersionCompatibility({ name: "t", version: "1.0.0", description: "", entry: "i.js" }, "0.1.0")).toBe(true);
  });
});
