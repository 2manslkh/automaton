/**
 * Skill Marketplace Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDb,
  createTestIdentity,
  MockConwayClient,
} from "./mocks.js";
import {
  publishSkill,
  browseSkills,
  rateSkill,
  checkSkillUpdates,
  checkDependencies,
  getMarketplaceSkill,
  getSkillRatings,
  getSkillVersions,
  compareVersions,
  generateSkillId,
  installFromMarketplace,
} from "../skills/marketplace.js";
import type { Skill, AutomatonDatabase } from "../types.js";

let db: AutomatonDatabase;
let conway: MockConwayClient;
let identity: ReturnType<typeof createTestIdentity>;

function makeSkill(name: string): Skill {
  return {
    name,
    description: `A ${name} skill`,
    autoActivate: true,
    instructions: `Instructions for ${name}`,
    source: "self",
    path: `/tmp/skills/${name}/SKILL.md`,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  db = createTestDb();
  conway = new MockConwayClient();
  identity = createTestIdentity();
});

afterEach(() => {
  db.close();
});

describe("compareVersions", () => {
  it("compares semver correctly", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("generateSkillId", () => {
  it("generates deterministic IDs", () => {
    const id1 = generateSkillId("0x123", "my-skill");
    const id2 = generateSkillId("0x123", "my-skill");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^skill_/);
  });

  it("generates different IDs for different inputs", () => {
    const id1 = generateSkillId("0x123", "skill-a");
    const id2 = generateSkillId("0x123", "skill-b");
    expect(id1).not.toBe(id2);
  });
});

describe("publishSkill", () => {
  it("publishes a skill to the marketplace", async () => {
    const skill = makeSkill("web-scraper");
    const published = await publishSkill(
      skill,
      { name: "web-scraper", description: "Scrapes the web", version: "1.0.0", tags: ["web", "scraping"] },
      identity,
      db,
      conway,
    );

    expect(published.id).toMatch(/^skill_/);
    expect(published.name).toBe("web-scraper");
    expect(published.version).toBe("1.0.0");
    expect(published.author).toBe(identity.name);
    expect(published.tags).toEqual(["web", "scraping"]);
    expect(published.downloads).toBe(0);
    expect(published.rating).toBe(0);
  });

  it("updates an existing publication", async () => {
    const skill = makeSkill("web-scraper");
    await publishSkill(
      skill,
      { name: "web-scraper", description: "v1", version: "1.0.0" },
      identity, db, conway,
    );
    const updated = await publishSkill(
      skill,
      { name: "web-scraper", description: "v2", version: "1.1.0", changelog: "Bug fixes" },
      identity, db, conway,
    );

    expect(updated.version).toBe("1.1.0");
    expect(updated.description).toBe("v2");
    // Should have 2 version entries
    const versions = getSkillVersions(updated.id, db);
    expect(versions).toHaveLength(2);
  });
});

describe("browseSkills", () => {
  it("lists all published skills", async () => {
    const s1 = makeSkill("skill-a");
    const s2 = makeSkill("skill-b");
    await publishSkill(s1, { name: "skill-a", description: "First", version: "1.0.0", tags: ["util"] }, identity, db, conway);
    await publishSkill(s2, { name: "skill-b", description: "Second", version: "1.0.0", tags: ["web"] }, identity, db, conway);

    const results = await browseSkills({}, db, conway);
    expect(results).toHaveLength(2);
  });

  it("filters by query", async () => {
    await publishSkill(makeSkill("web-scraper"), { name: "web-scraper", description: "Scrapes web", version: "1.0.0" }, identity, db, conway);
    await publishSkill(makeSkill("math-helper"), { name: "math-helper", description: "Does math", version: "1.0.0" }, identity, db, conway);

    const results = await browseSkills({ query: "web" }, db, conway);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("web-scraper");
  });

  it("filters by tags", async () => {
    await publishSkill(makeSkill("a"), { name: "a", description: "A", version: "1.0.0", tags: ["web"] }, identity, db, conway);
    await publishSkill(makeSkill("b"), { name: "b", description: "B", version: "1.0.0", tags: ["math"] }, identity, db, conway);

    const results = await browseSkills({ tags: ["math"] }, db, conway);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("b");
  });

  it("sorts by rating", async () => {
    const p1 = await publishSkill(makeSkill("low"), { name: "low", description: "Low rated", version: "1.0.0" }, identity, db, conway);
    const p2 = await publishSkill(makeSkill("high"), { name: "high", description: "High rated", version: "1.0.0" }, identity, db, conway);

    await rateSkill(p1.id, 2, "meh", "0xrater1", db);
    await rateSkill(p2.id, 5, "great", "0xrater1", db);

    const results = await browseSkills({ sortBy: "rating" }, db, conway);
    expect(results[0].name).toBe("high");
    expect(results[1].name).toBe("low");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await publishSkill(makeSkill(`s${i}`), { name: `s${i}`, description: `Skill ${i}`, version: "1.0.0" }, identity, db, conway);
    }
    const results = await browseSkills({ limit: 2 }, db, conway);
    expect(results).toHaveLength(2);
  });
});

describe("rateSkill", () => {
  it("rates a skill and updates average", async () => {
    const published = await publishSkill(
      makeSkill("test"),
      { name: "test", description: "Test", version: "1.0.0" },
      identity, db, conway,
    );

    await rateSkill(published.id, 4, "Good skill", "0xrater1", db);
    await rateSkill(published.id, 2, "Needs work", "0xrater2", db);

    const updated = getMarketplaceSkill(published.id, db);
    expect(updated!.rating).toBe(3); // (4+2)/2
    expect(updated!.ratingCount).toBe(2);

    const ratings = getSkillRatings(published.id, db);
    expect(ratings).toHaveLength(2);
  });

  it("rejects invalid scores", async () => {
    const published = await publishSkill(
      makeSkill("test"),
      { name: "test", description: "Test", version: "1.0.0" },
      identity, db, conway,
    );

    await expect(rateSkill(published.id, 0, "bad", "0x1", db)).rejects.toThrow("between 1 and 5");
    await expect(rateSkill(published.id, 6, "bad", "0x1", db)).rejects.toThrow("between 1 and 5");
  });

  it("rejects rating nonexistent skill", async () => {
    await expect(rateSkill("nonexistent", 3, "ok", "0x1", db)).rejects.toThrow("not found");
  });

  it("allows updating a rating from the same rater", async () => {
    const published = await publishSkill(
      makeSkill("test"),
      { name: "test", description: "Test", version: "1.0.0" },
      identity, db, conway,
    );

    await rateSkill(published.id, 3, "OK", "0xrater1", db);
    await rateSkill(published.id, 5, "Actually great", "0xrater1", db);

    const updated = getMarketplaceSkill(published.id, db);
    // Same rater ID overwrites, so only 1 entry in index but KV is overwritten
    expect(updated!.ratingCount).toBe(1);
    expect(updated!.rating).toBe(5);
  });
});

describe("checkSkillUpdates", () => {
  it("detects when an update is available", async () => {
    const skill = makeSkill("updatable");
    db.upsertSkill(skill);
    db.setKV("skill_version:updatable", "1.0.0");

    await publishSkill(skill, { name: "updatable", description: "Test", version: "2.0.0" }, identity, db, conway);

    const updates = await checkSkillUpdates(db);
    expect(updates).toHaveLength(1);
    expect(updates[0].hasUpdate).toBe(true);
    expect(updates[0].currentVersion).toBe("1.0.0");
    expect(updates[0].latestVersion).toBe("2.0.0");
  });

  it("reports up to date when versions match", async () => {
    const skill = makeSkill("current");
    db.upsertSkill(skill);
    db.setKV("skill_version:current", "1.0.0");

    await publishSkill(skill, { name: "current", description: "Test", version: "1.0.0" }, identity, db, conway);

    const updates = await checkSkillUpdates(db);
    expect(updates).toHaveLength(1);
    expect(updates[0].hasUpdate).toBe(false);
  });
});

describe("checkDependencies", () => {
  it("checks environment variable dependencies", async () => {
    process.env.TEST_MARKETPLACE_VAR = "hello";
    const results = await checkDependencies(
      [
        { type: "env", name: "TEST_MARKETPLACE_VAR" },
        { type: "env", name: "NONEXISTENT_VAR_12345" },
      ],
      conway,
      db,
    );

    expect(results).toHaveLength(2);
    expect(results[0].satisfied).toBe(true);
    expect(results[1].satisfied).toBe(false);
    delete process.env.TEST_MARKETPLACE_VAR;
  });

  it("marks optional deps appropriately", async () => {
    const results = await checkDependencies(
      [{ type: "env", name: "NONEXISTENT_VAR_12345", optional: true }],
      conway,
      db,
    );
    expect(results[0].satisfied).toBe(false);
    expect(results[0].detail).toContain("optional");
  });
});

describe("versioning", () => {
  it("tracks multiple versions", async () => {
    const skill = makeSkill("versioned");
    const p1 = await publishSkill(skill, { name: "versioned", description: "v1", version: "1.0.0" }, identity, db, conway);
    await publishSkill(skill, { name: "versioned", description: "v2", version: "1.1.0", changelog: "Added features" }, identity, db, conway);
    await publishSkill(skill, { name: "versioned", description: "v3", version: "2.0.0", changelog: "Breaking changes" }, identity, db, conway);

    const versions = getSkillVersions(p1.id, db);
    expect(versions).toHaveLength(3);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[2].version).toBe("2.0.0");
    expect(versions[2].changelog).toBe("Breaking changes");
  });
});
