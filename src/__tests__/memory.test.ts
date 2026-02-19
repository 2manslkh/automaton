import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MemoryManager, MEMORY_MIGRATION, createMemoryTools } from "../agent/memory.js";
import type { EpisodicMemory, SemanticMemory } from "../agent/memory.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(MEMORY_MIGRATION);
  return db;
}

describe("MemoryManager", () => {
  let db: ReturnType<typeof Database>;
  let mm: MemoryManager;

  beforeEach(() => {
    db = createTestDb();
    mm = new MemoryManager(db);
  });

  // ─── Episodic Memory ────────────────────────────────────────

  describe("episodic memory", () => {
    it("stores and retrieves episodic memories", () => {
      const mem = mm.storeEpisodic({
        id: "ep1",
        content: "Deployed web server successfully",
        tags: ["deployment", "server"],
        importance: 4,
        timestamp: "2026-01-15T10:00:00Z",
      });

      expect(mem.id).toBe("ep1");
      expect(mem.createdAt).toBeTruthy();

      const retrieved = mm.getEpisodicById("ep1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe("Deployed web server successfully");
      expect(retrieved!.tags).toEqual(["deployment", "server"]);
      expect(retrieved!.importance).toBe(4);
    });

    it("clamps importance to 1-5", () => {
      mm.storeEpisodic({ id: "ep_low", content: "low", tags: [], importance: 0, timestamp: "2026-01-01T00:00:00Z" });
      mm.storeEpisodic({ id: "ep_high", content: "high", tags: [], importance: 10, timestamp: "2026-01-01T00:00:00Z" });

      expect(mm.getEpisodicById("ep_low")!.importance).toBe(1);
      expect(mm.getEpisodicById("ep_high")!.importance).toBe(5);
    });
  });

  // ─── Semantic Memory ────────────────────────────────────────

  describe("semantic memory", () => {
    it("stores and retrieves by key", () => {
      mm.storeSemantic({
        id: "sem1",
        key: "creator_name",
        value: "Alice",
        category: "contacts",
        importance: 5,
      });

      const retrieved = mm.getSemanticByKey("creator_name");
      expect(retrieved).toBeDefined();
      expect(retrieved!.value).toBe("Alice");
      expect(retrieved!.category).toBe("contacts");
    });

    it("upserts semantic memory on same id", () => {
      mm.storeSemantic({ id: "sem1", key: "fact", value: "old", category: "general", importance: 3 });
      mm.storeSemantic({ id: "sem1", key: "fact", value: "new", category: "general", importance: 4 });

      const retrieved = mm.getSemanticByKey("fact");
      expect(retrieved!.value).toBe("new");
      expect(retrieved!.importance).toBe(4);
    });
  });

  // ─── Working Memory / Goals ─────────────────────────────────

  describe("working memory", () => {
    it("sets and retrieves goals", () => {
      mm.setGoal({ id: "g1", goal: "Earn $10 revenue", status: "active", priority: 5 });
      mm.setGoal({ id: "g2", goal: "Install monitoring", status: "active", priority: 3 });

      const goals = mm.getGoals(true);
      expect(goals).toHaveLength(2);
      expect(goals[0].goal).toBe("Earn $10 revenue"); // higher priority first
    });

    it("filters by active status", () => {
      mm.setGoal({ id: "g1", goal: "Done task", status: "completed", priority: 5 });
      mm.setGoal({ id: "g2", goal: "Active task", status: "active", priority: 3 });

      const active = mm.getGoals(true);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("g2");

      const all = mm.getGoals(false);
      expect(all).toHaveLength(2);
    });

    it("updates goal status", () => {
      mm.setGoal({ id: "g1", goal: "Test goal", status: "active", priority: 3 });
      mm.updateGoalStatus("g1", "completed");

      const active = mm.getGoals(true);
      expect(active).toHaveLength(0);

      const all = mm.getGoals(false);
      expect(all[0].status).toBe("completed");
    });
  });

  // ─── Search ─────────────────────────────────────────────────

  describe("search", () => {
    beforeEach(() => {
      mm.storeEpisodic({ id: "e1", content: "Deployed API server", tags: ["deploy"], importance: 4, timestamp: "2026-01-10T00:00:00Z" });
      mm.storeEpisodic({ id: "e2", content: "Fixed critical bug", tags: ["bugfix", "critical"], importance: 5, timestamp: "2026-01-15T00:00:00Z" });
      mm.storeEpisodic({ id: "e3", content: "Routine maintenance", tags: ["maintenance"], importance: 2, timestamp: "2026-01-05T00:00:00Z" });
      mm.storeSemantic({ id: "s1", key: "server_ip", value: "10.0.0.1", category: "config", importance: 3 });
      mm.storeSemantic({ id: "s2", key: "api_key_name", value: "my-key", category: "config", importance: 4 });
    });

    it("searches by keyword", () => {
      const results = mm.search({ query: "server" });
      expect(results.length).toBeGreaterThanOrEqual(2); // episodic + semantic
    });

    it("searches by tags", () => {
      const results = mm.search({ tags: ["critical"], type: "episodic" });
      expect(results).toHaveLength(1);
      expect((results[0] as EpisodicMemory).content).toBe("Fixed critical bug");
    });

    it("searches by min importance", () => {
      const results = mm.search({ minImportance: 4 });
      expect(results.length).toBe(3); // e1(4), e2(5), s2(4)
    });

    it("searches by time range", () => {
      const results = mm.search({ since: "2026-01-08T00:00:00Z", type: "episodic" });
      expect(results).toHaveLength(2); // e1 and e2
    });

    it("searches by category (semantic only)", () => {
      const results = mm.search({ category: "config", type: "semantic" });
      expect(results).toHaveLength(2);
    });

    it("respects limit", () => {
      const results = mm.search({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // ─── Memory Decay ──────────────────────────────────────────

  describe("decay", () => {
    it("prunes old low-importance memories when over limit", () => {
      // Insert 15 memories with varying importance
      for (let i = 0; i < 15; i++) {
        mm.storeEpisodic({
          id: `decay_${i}`,
          content: `Memory ${i}`,
          tags: [],
          importance: i < 10 ? 2 : 4, // first 10 low importance, last 5 high
          timestamp: new Date(2026, 0, i + 1).toISOString(),
        });
      }

      const pruned = mm.decay(10);
      expect(pruned).toBe(5);

      // High importance memories should survive
      for (let i = 10; i < 15; i++) {
        expect(mm.getEpisodicById(`decay_${i}`)).toBeDefined();
      }
    });

    it("does nothing when under limit", () => {
      mm.storeEpisodic({ id: "e1", content: "test", tags: [], importance: 2, timestamp: "2026-01-01T00:00:00Z" });
      const pruned = mm.decay(100);
      expect(pruned).toBe(0);
    });

    it("never prunes high importance memories (4-5)", () => {
      for (let i = 0; i < 10; i++) {
        mm.storeEpisodic({
          id: `hi_${i}`,
          content: `Important ${i}`,
          tags: [],
          importance: 5,
          timestamp: new Date(2026, 0, i + 1).toISOString(),
        });
      }

      const pruned = mm.decay(5);
      // Can't prune any because all are importance 5
      expect(pruned).toBe(0);
    });
  });

  // ─── Context Injection ────────────────────────────────────

  describe("getRelevantMemories", () => {
    it("returns formatted memory context", () => {
      mm.storeEpisodic({ id: "e1", content: "Launched API", tags: ["launch"], importance: 5, timestamp: "2026-01-15T00:00:00Z" });
      mm.setGoal({ id: "g1", goal: "Earn revenue", status: "active", priority: 4 });

      const context = mm.getRelevantMemories();
      expect(context).toContain("Key memories:");
      expect(context).toContain("Launched API");
      expect(context).toContain("Active goals:");
      expect(context).toContain("Earn revenue");
    });

    it("returns empty string when no memories", () => {
      const context = mm.getRelevantMemories();
      expect(context).toBe("");
    });

    it("uses context hint for relevance", () => {
      mm.storeEpisodic({ id: "e1", content: "Server deployed", tags: [], importance: 3, timestamp: "2026-01-01T00:00:00Z" });
      mm.storeEpisodic({ id: "e2", content: "Bug fixed in API", tags: [], importance: 3, timestamp: "2026-01-02T00:00:00Z" });

      const context = mm.getRelevantMemories("API");
      expect(context).toContain("Bug fixed in API");
    });
  });

  // ─── Tools ────────────────────────────────────────────────

  describe("memory tools", () => {
    it("creates 4 tools", () => {
      const tools = createMemoryTools(mm);
      expect(tools).toHaveLength(4);
      expect(tools.map(t => t.name)).toEqual(["remember", "recall", "set_goal", "get_goals"]);
    });

    it("remember tool stores episodic memory", async () => {
      const tools = createMemoryTools(mm);
      const remember = tools[0];
      const result = await remember.execute(
        { type: "episodic", content: "Test event", tags: ["test"], importance: 4 },
        {} as any,
      );
      expect(result).toContain("Stored episodic memory");

      const memories = mm.search({ tags: ["test"] });
      expect(memories).toHaveLength(1);
    });

    it("remember tool stores semantic memory", async () => {
      const tools = createMemoryTools(mm);
      const remember = tools[0];
      const result = await remember.execute(
        { type: "semantic", content: "192.168.1.1", key: "server_ip", category: "config", importance: 3 },
        {} as any,
      );
      expect(result).toContain("Stored semantic memory");

      const mem = mm.getSemanticByKey("server_ip");
      expect(mem!.value).toBe("192.168.1.1");
    });

    it("recall tool searches memories", async () => {
      const tools = createMemoryTools(mm);
      mm.storeEpisodic({ id: "e1", content: "Found a bug", tags: ["bug"], importance: 4, timestamp: "2026-01-01T00:00:00Z" });

      const recall = tools[1];
      const result = await recall.execute({ query: "bug" }, {} as any);
      expect(result).toContain("Found a bug");
    });

    it("set_goal and get_goals tools work", async () => {
      const tools = createMemoryTools(mm);
      const setGoal = tools[2];
      const getGoals = tools[3];

      await setGoal.execute({ goal: "Build revenue stream", priority: 5 }, {} as any);
      const result = await getGoals.execute({}, {} as any);
      expect(result).toContain("Build revenue stream");
      expect(result).toContain("P5");
    });
  });
});
