/**
 * Plugin Hook System
 *
 * Plugins can register hooks to react to agent lifecycle events.
 * Hooks are executed in registration order. Errors in one hook
 * don't prevent others from running.
 */

export type HookName =
  | "onTurnStart"
  | "onTurnEnd"
  | "onToolCall"
  | "onSleep"
  | "onWake"
  | "onTierChange";

export const ALL_HOOKS: HookName[] = [
  "onTurnStart",
  "onTurnEnd",
  "onToolCall",
  "onSleep",
  "onWake",
  "onTierChange",
];

export interface HookContext {
  pluginName: string;
  [key: string]: unknown;
}

export type HookHandler = (context: HookContext) => Promise<void> | void;

interface RegisteredHook {
  pluginName: string;
  handler: HookHandler;
}

/**
 * Central hook registry. Manages hook registration and execution.
 */
export class HookRegistry {
  private hooks: Map<HookName, RegisteredHook[]> = new Map();

  register(hookName: HookName, pluginName: string, handler: HookHandler): void {
    if (!ALL_HOOKS.includes(hookName)) {
      throw new Error(`Unknown hook: ${hookName}`);
    }
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    this.hooks.get(hookName)!.push({ pluginName, handler });
  }

  unregisterAll(pluginName: string): void {
    for (const [hookName, handlers] of this.hooks.entries()) {
      this.hooks.set(
        hookName,
        handlers.filter((h) => h.pluginName !== pluginName),
      );
    }
  }

  async emit(hookName: HookName, context: Omit<HookContext, "pluginName">): Promise<void> {
    const handlers = this.hooks.get(hookName) || [];
    for (const { pluginName, handler } of handlers) {
      try {
        await handler({ ...context, pluginName });
      } catch (err) {
        // Log but don't propagate — one bad plugin shouldn't break the agent
        console.error(`[plugin-hook] Error in ${pluginName}.${hookName}:`, err);
      }
    }
  }

  getRegisteredHooks(pluginName?: string): { hookName: HookName; pluginName: string }[] {
    const result: { hookName: HookName; pluginName: string }[] = [];
    for (const [hookName, handlers] of this.hooks.entries()) {
      for (const h of handlers) {
        if (!pluginName || h.pluginName === pluginName) {
          result.push({ hookName, pluginName: h.pluginName });
        }
      }
    }
    return result;
  }

  clear(): void {
    this.hooks.clear();
  }
}

/** Singleton hook registry */
export const hookRegistry = new HookRegistry();
