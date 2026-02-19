/**
 * Structured Long-Term Memory System
 *
 * Provides episodic, semantic, and working memory beyond simple KV storage.
 * Supports search by tags, categories, keywords, time ranges, and importance.
 * Includes automatic memory decay for low-importance old memories.
 */

import type { AutomatonDatabase, AutomatonTool, ToolContext } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────

export type MemoryType = "episodic" | "semantic";

export interface EpisodicMemory {
  id: string;
  content: string;
  tags: string[];
  importance: number; // 1-5
  timestamp: string;
  createdAt: string;
}

export interface SemanticMemory {
  id: string;
  key: string;
  value: string;
  category: string;
  importance: number; // 1-5
  createdAt: string;
  updatedAt: string;
}

export interface WorkingMemoryItem {
  id: string;
  goal: string;
  status: "active" | "completed" | "abandoned";
  priority: number; // 1-5
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchOptions {
  query?: string;
  tags?: string[];
  category?: string;
  minImportance?: number;
  since?: string;
  until?: string;
  limit?: number;
  type?: MemoryType;
}

// ─── Schema Migration ──────────────────────────────────────────

export const MEMORY_MIGRATION = `
  CREATE TABLE IF NOT EXISTS episodic_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 3,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS semantic_memories (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    importance INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_memories(importance);
  CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_memories(timestamp);
  CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memories(category);
  CREATE INDEX IF NOT EXISTS idx_semantic_key ON semantic_memories(key);
  CREATE INDEX IF NOT EXISTS idx_working_status ON working_memory(status);
`;

// ─── Memory Manager ────────────────────────────────────────────

export class MemoryManager {
  private db: any; // raw better-sqlite3 instance

  constructor(db: any) {
    this.db = db;
  }

  // ─── Episodic Memory ──────────────────────────────────────

  storeEpisodic(memory: Omit<EpisodicMemory, "createdAt">): EpisodicMemory {
    const createdAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO episodic_memories (id, content, tags, importance, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      memory.id,
      memory.content,
      JSON.stringify(memory.tags),
      Math.max(1, Math.min(5, memory.importance)),
      memory.timestamp,
      createdAt,
    );
    return { ...memory, createdAt };
  }

  getEpisodicById(id: string): EpisodicMemory | undefined {
    const row = this.db.prepare("SELECT * FROM episodic_memories WHERE id = ?").get(id) as any;
    return row ? deserializeEpisodic(row) : undefined;
  }

  // ─── Semantic Memory ──────────────────────────────────────

  storeSemantic(memory: Omit<SemanticMemory, "createdAt" | "updatedAt">): SemanticMemory {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO semantic_memories (id, key, value, category, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM semantic_memories WHERE id = ?), ?), ?)`
    ).run(
      memory.id,
      memory.key,
      memory.value,
      memory.category,
      Math.max(1, Math.min(5, memory.importance)),
      memory.id,
      now,
      now,
    );
    return { ...memory, createdAt: now, updatedAt: now };
  }

  getSemanticByKey(key: string): SemanticMemory | undefined {
    const row = this.db.prepare("SELECT * FROM semantic_memories WHERE key = ?").get(key) as any;
    return row ? deserializeSemantic(row) : undefined;
  }

  // ─── Working Memory ───────────────────────────────────────

  setGoal(item: Omit<WorkingMemoryItem, "createdAt" | "updatedAt">): WorkingMemoryItem {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO working_memory (id, goal, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM working_memory WHERE id = ?), ?), ?)`
    ).run(item.id, item.goal, item.status, item.priority, item.id, now, now);
    return { ...item, createdAt: now, updatedAt: now };
  }

  getGoals(activeOnly: boolean = true): WorkingMemoryItem[] {
    const sql = activeOnly
      ? "SELECT * FROM working_memory WHERE status = 'active' ORDER BY priority DESC, updated_at DESC"
      : "SELECT * FROM working_memory ORDER BY priority DESC, updated_at DESC";
    return (this.db.prepare(sql).all() as any[]).map(deserializeWorkingMemory);
  }

  updateGoalStatus(id: string, status: "active" | "completed" | "abandoned"): void {
    this.db.prepare(
      "UPDATE working_memory SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  }

  // ─── Search ───────────────────────────────────────────────

  search(options: MemorySearchOptions): (EpisodicMemory | SemanticMemory)[] {
    const results: (EpisodicMemory | SemanticMemory)[] = [];
    const limit = options.limit ?? 20;
    const searchEpisodic = !options.type || options.type === "episodic";
    const searchSemantic = !options.type || options.type === "semantic";

    if (searchEpisodic) {
      let sql = "SELECT * FROM episodic_memories WHERE 1=1";
      const params: any[] = [];

      if (options.minImportance) {
        sql += " AND importance >= ?";
        params.push(options.minImportance);
      }
      if (options.since) {
        sql += " AND timestamp >= ?";
        params.push(options.since);
      }
      if (options.until) {
        sql += " AND timestamp <= ?";
        params.push(options.until);
      }
      if (options.query) {
        sql += " AND content LIKE ?";
        params.push(`%${options.query}%`);
      }
      if (options.tags && options.tags.length > 0) {
        for (const tag of options.tags) {
          sql += " AND tags LIKE ?";
          params.push(`%"${tag}"%`);
        }
      }

      sql += " ORDER BY importance DESC, timestamp DESC LIMIT ?";
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as any[];
      results.push(...rows.map(deserializeEpisodic));
    }

    if (searchSemantic) {
      let sql = "SELECT * FROM semantic_memories WHERE 1=1";
      const params: any[] = [];

      if (options.minImportance) {
        sql += " AND importance >= ?";
        params.push(options.minImportance);
      }
      if (options.category) {
        sql += " AND category = ?";
        params.push(options.category);
      }
      if (options.query) {
        sql += " AND (key LIKE ? OR value LIKE ?)";
        params.push(`%${options.query}%`, `%${options.query}%`);
      }

      sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as any[];
      results.push(...rows.map(deserializeSemantic));
    }

    // Sort combined results by importance descending, return up to limit
    results.sort((a, b) => b.importance - a.importance);
    return results.slice(0, limit);
  }

  // ─── Memory Decay ─────────────────────────────────────────

  /**
   * Prune old low-importance memories, keeping at most maxTotal.
   * High-importance memories (4-5) are never auto-pruned.
   */
  decay(maxTotal: number = 1000): number {
    // Count total episodic memories
    const countRow = this.db.prepare("SELECT COUNT(*) as c FROM episodic_memories").get() as any;
    const total = countRow.c;

    if (total <= maxTotal) return 0;

    const toRemove = total - maxTotal;
    // Remove oldest, lowest-importance episodic memories (never prune importance >= 4)
    const result = this.db.prepare(
      `DELETE FROM episodic_memories WHERE id IN (
        SELECT id FROM episodic_memories
        WHERE importance < 4
        ORDER BY importance ASC, timestamp ASC
        LIMIT ?
      )`
    ).run(toRemove);

    return result.changes;
  }

  // ─── Context Injection ────────────────────────────────────

  /**
   * Get top relevant memories for system prompt injection.
   * Returns top 5 memories by importance, with recent bias.
   */
  getRelevantMemories(contextHint?: string): string {
    const parts: string[] = [];

    // Top episodic memories (recent + important)
    let episodicSql = "SELECT * FROM episodic_memories ORDER BY importance DESC, timestamp DESC LIMIT 5";
    const episodicParams: any[] = [];

    if (contextHint) {
      episodicSql = "SELECT * FROM episodic_memories WHERE content LIKE ? ORDER BY importance DESC, timestamp DESC LIMIT 5";
      episodicParams.push(`%${contextHint}%`);
    }

    const episodic = (this.db.prepare(episodicSql).all(...episodicParams) as any[]).map(deserializeEpisodic);

    // If context search returned few results, backfill with top importance
    if (episodic.length < 5 && contextHint) {
      const ids = episodic.map(e => e.id);
      const placeholders = ids.length > 0 ? ids.map(() => '?').join(',') : "'__none__'";
      const backfill = (this.db.prepare(
        `SELECT * FROM episodic_memories WHERE id NOT IN (${placeholders}) ORDER BY importance DESC, timestamp DESC LIMIT ?`
      ).all(...ids, 5 - episodic.length) as any[]).map(deserializeEpisodic);
      episodic.push(...backfill);
    }

    if (episodic.length > 0) {
      parts.push("Key memories:");
      for (const m of episodic) {
        parts.push(`  [${m.importance}★] ${m.content} (${m.timestamp}, tags: ${m.tags.join(", ")})`);
      }
    }

    // Active goals
    const goals = this.getGoals(true);
    if (goals.length > 0) {
      parts.push("Active goals:");
      for (const g of goals) {
        parts.push(`  [P${g.priority}] ${g.goal}`);
      }
    }

    return parts.join("\n");
  }
}

// ─── Deserializers ─────────────────────────────────────────────

function deserializeEpisodic(row: any): EpisodicMemory {
  return {
    id: row.id,
    content: row.content,
    tags: JSON.parse(row.tags || "[]"),
    importance: row.importance,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}

function deserializeSemantic(row: any): SemanticMemory {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    category: row.category,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeWorkingMemory(row: any): WorkingMemoryItem {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Tool Definitions ──────────────────────────────────────────

export function createMemoryTools(memoryManager: MemoryManager): AutomatonTool[] {
  const remember: AutomatonTool = {
    name: "remember",
    description: "Store a memory (episodic event or semantic fact) with tags and importance (1-5)",
    category: "vm",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["episodic", "semantic"], description: "Memory type" },
        content: { type: "string", description: "For episodic: the event description. For semantic: the value." },
        key: { type: "string", description: "For semantic memory: the fact key" },
        category: { type: "string", description: "For semantic memory: category (e.g. 'skills', 'contacts', 'config')" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for episodic memories" },
        importance: { type: "number", description: "Importance score 1-5 (5=critical)" },
      },
      required: ["type", "content"],
    },
    execute: async (args) => {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const importance = Math.max(1, Math.min(5, Number(args.importance) || 3));

      if (args.type === "episodic") {
        const tags = (args.tags as string[]) || [];
        memoryManager.storeEpisodic({
          id,
          content: args.content as string,
          tags,
          importance,
          timestamp: new Date().toISOString(),
        });
        return `Stored episodic memory (${id}) with importance ${importance}, tags: [${tags.join(", ")}]`;
      } else if (args.type === "semantic") {
        const key = (args.key as string) || args.content as string;
        const category = (args.category as string) || "general";
        memoryManager.storeSemantic({
          id,
          key,
          value: args.content as string,
          category,
          importance,
        });
        return `Stored semantic memory (${id}) key="${key}" category="${category}" importance=${importance}`;
      }
      return "Error: type must be 'episodic' or 'semantic'";
    },
  };

  const recall: AutomatonTool = {
    name: "recall",
    description: "Search memories by query, tags, category, time range, or importance",
    category: "vm",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword search" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
        category: { type: "string", description: "Filter semantic memories by category" },
        type: { type: "string", enum: ["episodic", "semantic"], description: "Filter by memory type" },
        min_importance: { type: "number", description: "Minimum importance (1-5)" },
        since: { type: "string", description: "ISO timestamp lower bound" },
        until: { type: "string", description: "ISO timestamp upper bound" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    execute: async (args) => {
      const results = memoryManager.search({
        query: args.query as string | undefined,
        tags: args.tags as string[] | undefined,
        category: args.category as string | undefined,
        type: args.type as MemoryType | undefined,
        minImportance: args.min_importance as number | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: args.limit as number | undefined,
      });

      if (results.length === 0) return "No memories found matching your query.";

      return results.map((m) => {
        if ("content" in m) {
          const em = m as EpisodicMemory;
          return `[episodic ${em.importance}★] ${em.content} (${em.timestamp}, tags: ${em.tags.join(", ")})`;
        } else {
          const sm = m as SemanticMemory;
          return `[semantic ${sm.importance}★] ${sm.key}: ${sm.value} (category: ${sm.category})`;
        }
      }).join("\n");
    },
  };

  const set_goal: AutomatonTool = {
    name: "set_goal",
    description: "Set or update a goal in working memory",
    category: "vm",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The goal description" },
        priority: { type: "number", description: "Priority 1-5 (5=highest)" },
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "Goal status" },
        id: { type: "string", description: "Goal ID (for updates; auto-generated if omitted)" },
      },
      required: ["goal"],
    },
    execute: async (args) => {
      const id = (args.id as string) || `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const priority = Math.max(1, Math.min(5, Number(args.priority) || 3));
      const status = (args.status as "active" | "completed" | "abandoned") || "active";

      memoryManager.setGoal({ id, goal: args.goal as string, status, priority });
      return `Goal set (${id}): "${args.goal}" [P${priority}, ${status}]`;
    },
  };

  const get_goals: AutomatonTool = {
    name: "get_goals",
    description: "Read current goals from working memory",
    category: "vm",
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include completed/abandoned goals" },
      },
    },
    execute: async (args) => {
      const goals = memoryManager.getGoals(!(args.all as boolean));
      if (goals.length === 0) return "No goals set.";
      return goals.map((g) =>
        `[${g.status}] P${g.priority}: ${g.goal} (id: ${g.id}, updated: ${g.updatedAt})`
      ).join("\n");
    },
  };

  return [remember, recall, set_goal, get_goals];
}
