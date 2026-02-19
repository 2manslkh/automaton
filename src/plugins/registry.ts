/**
 * Plugin Registry
 *
 * Manages plugin installation from npm, git URLs, or local paths.
 * Handles enable/disable, dependency resolution, and version compatibility.
 */

import fs from "fs";
import path from "path";
import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { PluginLoader, type PluginManifest, type LoadedPlugin } from "./loader.js";

export interface PluginInstallResult {
  success: boolean;
  name?: string;
  version?: string;
  error?: string;
}

/**
 * Resolve the plugins directory, creating if needed.
 */
function ensurePluginsDir(pluginsDir: string): string {
  const resolved = pluginsDir.startsWith("~")
    ? path.join(process.env.HOME || "/root", pluginsDir.slice(1))
    : pluginsDir;
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Install a plugin from a local path (copy or symlink).
 */
export async function installFromLocal(
  sourcePath: string,
  pluginsDir: string,
): Promise<PluginInstallResult> {
  const resolved = ensurePluginsDir(pluginsDir);
  const manifestPath = path.join(sourcePath, "plugin.json");

  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: `No plugin.json found at ${sourcePath}` };
  }

  const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const targetDir = path.join(resolved, manifest.name);

  // Copy plugin directory
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
  }
  fs.cpSync(sourcePath, targetDir, { recursive: true });

  return { success: true, name: manifest.name, version: manifest.version };
}

/**
 * Install a plugin from npm.
 */
export async function installFromNpm(
  packageName: string,
  pluginsDir: string,
  conway: ConwayClient,
): Promise<PluginInstallResult> {
  const resolved = ensurePluginsDir(pluginsDir);

  // Install to a temp location, then move
  const tmpDir = path.join(resolved, ".tmp-install");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const result = await conway.exec(
    `cd ${tmpDir} && npm init -y > /dev/null 2>&1 && npm install ${packageName} --save > /dev/null 2>&1`,
    120000,
  );

  if (result.exitCode !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: `npm install failed: ${result.stderr}` };
  }

  // Find the installed package
  const nodeModules = path.join(tmpDir, "node_modules", packageName);
  if (!fs.existsSync(path.join(nodeModules, "plugin.json"))) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: `Package ${packageName} doesn't contain a plugin.json` };
  }

  const manifest: PluginManifest = JSON.parse(
    fs.readFileSync(path.join(nodeModules, "plugin.json"), "utf-8"),
  );
  const targetDir = path.join(resolved, manifest.name);

  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
  fs.cpSync(nodeModules, targetDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return { success: true, name: manifest.name, version: manifest.version };
}

/**
 * Install a plugin from a git URL.
 */
export async function installFromGit(
  gitUrl: string,
  pluginsDir: string,
  conway: ConwayClient,
): Promise<PluginInstallResult> {
  const resolved = ensurePluginsDir(pluginsDir);
  const tmpDir = path.join(resolved, ".tmp-git-clone");

  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

  const result = await conway.exec(`git clone --depth 1 ${gitUrl} ${tmpDir}`, 60000);
  if (result.exitCode !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: `git clone failed: ${result.stderr}` };
  }

  if (!fs.existsSync(path.join(tmpDir, "plugin.json"))) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: "Cloned repo doesn't contain a plugin.json" };
  }

  const manifest: PluginManifest = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "plugin.json"), "utf-8"),
  );
  const targetDir = path.join(resolved, manifest.name);

  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
  fs.renameSync(tmpDir, targetDir);

  return { success: true, name: manifest.name, version: manifest.version };
}

/**
 * Check if plugin dependencies are satisfied.
 */
export function checkDependencies(
  manifest: PluginManifest,
  loader: PluginLoader,
): { satisfied: boolean; missing: string[] } {
  if (!manifest.dependencies) return { satisfied: true, missing: [] };

  const missing: string[] = [];
  for (const [depName] of Object.entries(manifest.dependencies)) {
    const dep = loader.getPlugin(depName);
    if (!dep || !dep.enabled) {
      missing.push(depName);
    }
  }

  return { satisfied: missing.length === 0, missing };
}

/**
 * Check version compatibility.
 */
export function checkVersionCompatibility(
  manifest: PluginManifest,
  automatonVersion: string,
): boolean {
  if (!manifest.automatonVersion) return true;
  // Simple comparison: check major version match
  const required = manifest.automatonVersion.replace(/[^0-9.]/g, "").split(".");
  const current = automatonVersion.split(".");
  return parseInt(current[0]) >= parseInt(required[0]);
}

/**
 * Uninstall a plugin by removing its directory.
 */
export async function uninstallPlugin(
  name: string,
  pluginsDir: string,
  loader: PluginLoader,
): Promise<boolean> {
  await loader.unloadPlugin(name);
  const resolved = pluginsDir.startsWith("~")
    ? path.join(process.env.HOME || "/root", pluginsDir.slice(1))
    : pluginsDir;
  const targetDir = path.join(resolved, name);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
    return true;
  }
  return false;
}
