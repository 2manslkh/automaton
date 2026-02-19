/**
 * Skill Marketplace
 *
 * Discover, publish, rate, and install skills from other automatons.
 * Uses agent cards (ERC-8004) for discovery and Conway social relay for metadata sharing.
 */

import type {
  Skill,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  AutomatonConfig,
  DiscoveredAgent,
  AgentCard,
} from "../types.js";
import { parseSkillMd } from "./format.js";
// Lazy imports to avoid pulling in ABI parsing at module load time
const getDiscovery = () => import("../registry/discovery.js");

// ─── Types ─────────────────────────────────────────────────────

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  authorAddress: string;
  publishedAt: string;
  updatedAt: string;
  downloads: number;
  rating: number;
  ratingCount: number;
  tags: string[];
  dependencies: SkillDependency[];
  sourceUrl?: string;
  skillMdUrl?: string;
}

export interface SkillDependency {
  type: "tool" | "package" | "env" | "bin";
  name: string;
  version?: string;
  optional?: boolean;
}

export interface SkillRating {
  id: string;
  skillId: string;
  raterAddress: string;
  score: number; // 1-5
  comment: string;
  timestamp: string;
}

export interface SkillVersion {
  version: string;
  publishedAt: string;
  changelog?: string;
  skillMdHash?: string;
}

export interface PublishOptions {
  name: string;
  description: string;
  version: string;
  tags?: string[];
  dependencies?: SkillDependency[];
  changelog?: string;
}

export interface BrowseOptions {
  query?: string;
  tags?: string[];
  author?: string;
  sortBy?: "rating" | "downloads" | "recent";
  limit?: number;
  offset?: number;
}

// ─── Marketplace Registry (KV-backed) ─────────────────────────

const MARKETPLACE_PREFIX = "marketplace:";
const RATINGS_PREFIX = "marketplace_rating:";
const VERSIONS_PREFIX = "marketplace_version:";

/**
 * Generate a deterministic skill ID from author address + skill name.
 */
export function generateSkillId(authorAddress: string, name: string): string {
  const normalized = `${authorAddress.toLowerCase()}:${name.toLowerCase().replace(/\s+/g, "-")}`;
  // Simple hash — deterministic and collision-resistant enough for our needs
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `skill_${Math.abs(hash).toString(36)}`;
}

/**
 * Publish a local skill to the marketplace.
 * Stores metadata in the DB KV store and optionally announces via social relay.
 */
export async function publishSkill(
  skill: Skill,
  options: PublishOptions,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<MarketplaceSkill> {
  const skillId = generateSkillId(identity.address, options.name);

  // Check for existing publication
  const existingRaw = db.getKV(`${MARKETPLACE_PREFIX}${skillId}`);
  const existing: MarketplaceSkill | null = existingRaw ? JSON.parse(existingRaw) : null;

  const now = new Date().toISOString();

  const marketplaceSkill: MarketplaceSkill = {
    id: skillId,
    name: options.name,
    description: options.description,
    version: options.version,
    author: identity.name,
    authorAddress: identity.address,
    publishedAt: existing?.publishedAt || now,
    updatedAt: now,
    downloads: existing?.downloads || 0,
    rating: existing?.rating || 0,
    ratingCount: existing?.ratingCount || 0,
    tags: options.tags || [],
    dependencies: options.dependencies || [],
    sourceUrl: skill.path,
    skillMdUrl: skill.path,
  };

  // Store in KV
  db.setKV(`${MARKETPLACE_PREFIX}${skillId}`, JSON.stringify(marketplaceSkill));

  // Store version entry
  const versionEntry: SkillVersion = {
    version: options.version,
    publishedAt: now,
    changelog: options.changelog,
  };
  const versionsKey = `${VERSIONS_PREFIX}${skillId}`;
  const existingVersions: SkillVersion[] = JSON.parse(db.getKV(versionsKey) || "[]");
  existingVersions.push(versionEntry);
  db.setKV(versionsKey, JSON.stringify(existingVersions));

  // Add to the marketplace index
  const indexRaw = db.getKV(`${MARKETPLACE_PREFIX}index`);
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(skillId)) {
    index.push(skillId);
    db.setKV(`${MARKETPLACE_PREFIX}index`, JSON.stringify(index));
  }

  return marketplaceSkill;
}

/**
 * Browse skills in the marketplace.
 */
export async function browseSkills(
  options: BrowseOptions,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<MarketplaceSkill[]> {
  const indexRaw = db.getKV(`${MARKETPLACE_PREFIX}index`);
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  let skills: MarketplaceSkill[] = [];

  for (const skillId of index) {
    const raw = db.getKV(`${MARKETPLACE_PREFIX}${skillId}`);
    if (!raw) continue;
    try {
      skills.push(JSON.parse(raw));
    } catch {
      // skip corrupt entries
    }
  }

  // Filter by query
  if (options.query) {
    const q = options.query.toLowerCase();
    skills = skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  // Filter by tags
  if (options.tags && options.tags.length > 0) {
    const tags = options.tags.map((t) => t.toLowerCase());
    skills = skills.filter((s) =>
      tags.some((t) => s.tags.map((st) => st.toLowerCase()).includes(t)),
    );
  }

  // Filter by author
  if (options.author) {
    const author = options.author.toLowerCase();
    skills = skills.filter(
      (s) =>
        s.author.toLowerCase().includes(author) ||
        s.authorAddress.toLowerCase() === author,
    );
  }

  // Sort
  const sortBy = options.sortBy || "recent";
  if (sortBy === "rating") {
    skills.sort((a, b) => b.rating - a.rating);
  } else if (sortBy === "downloads") {
    skills.sort((a, b) => b.downloads - a.downloads);
  } else {
    skills.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  // Pagination
  const offset = options.offset || 0;
  const limit = options.limit || 20;
  return skills.slice(offset, offset + limit);
}

/**
 * Get a single marketplace skill by ID.
 */
export function getMarketplaceSkill(
  skillId: string,
  db: AutomatonDatabase,
): MarketplaceSkill | null {
  const raw = db.getKV(`${MARKETPLACE_PREFIX}${skillId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Rate a skill in the marketplace.
 */
export async function rateSkill(
  skillId: string,
  score: number,
  comment: string,
  raterAddress: string,
  db: AutomatonDatabase,
): Promise<SkillRating> {
  if (score < 1 || score > 5) {
    throw new Error("Rating score must be between 1 and 5");
  }

  const skill = getMarketplaceSkill(skillId, db);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const ratingId = `${skillId}:${raterAddress}`;
  const now = new Date().toISOString();

  const rating: SkillRating = {
    id: ratingId,
    skillId,
    raterAddress,
    score,
    comment,
    timestamp: now,
  };

  // Store rating
  db.setKV(`${RATINGS_PREFIX}${ratingId}`, JSON.stringify(rating));

  // Update rating index for this skill
  const ratingsIndexKey = `${RATINGS_PREFIX}index:${skillId}`;
  const ratingsIndex: string[] = JSON.parse(db.getKV(ratingsIndexKey) || "[]");
  if (!ratingsIndex.includes(ratingId)) {
    ratingsIndex.push(ratingId);
    db.setKV(ratingsIndexKey, JSON.stringify(ratingsIndex));
  }

  // Recalculate average rating
  let totalScore = 0;
  let count = 0;
  for (const rid of ratingsIndex) {
    const r = db.getKV(`${RATINGS_PREFIX}${rid}`);
    if (r) {
      try {
        const parsed: SkillRating = JSON.parse(r);
        totalScore += parsed.score;
        count++;
      } catch { /* skip */ }
    }
  }

  skill.rating = count > 0 ? totalScore / count : 0;
  skill.ratingCount = count;
  db.setKV(`${MARKETPLACE_PREFIX}${skillId}`, JSON.stringify(skill));

  return rating;
}

/**
 * Get all ratings for a skill.
 */
export function getSkillRatings(
  skillId: string,
  db: AutomatonDatabase,
): SkillRating[] {
  const ratingsIndexKey = `${RATINGS_PREFIX}index:${skillId}`;
  const ratingsIndex: string[] = JSON.parse(db.getKV(ratingsIndexKey) || "[]");

  const ratings: SkillRating[] = [];
  for (const rid of ratingsIndex) {
    const r = db.getKV(`${RATINGS_PREFIX}${rid}`);
    if (r) {
      try {
        ratings.push(JSON.parse(r));
      } catch { /* skip */ }
    }
  }

  return ratings.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

/**
 * Get version history for a skill.
 */
export function getSkillVersions(
  skillId: string,
  db: AutomatonDatabase,
): SkillVersion[] {
  const versionsKey = `${VERSIONS_PREFIX}${skillId}`;
  return JSON.parse(db.getKV(versionsKey) || "[]");
}

/**
 * Check for updates to installed skills.
 */
export async function checkSkillUpdates(
  db: AutomatonDatabase,
): Promise<Array<{ skill: Skill; currentVersion: string; latestVersion: string; hasUpdate: boolean }>> {
  const installedSkills = db.getSkills();
  const results: Array<{ skill: Skill; currentVersion: string; latestVersion: string; hasUpdate: boolean }> = [];

  // Get the marketplace index
  const indexRaw = db.getKV(`${MARKETPLACE_PREFIX}index`);
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  for (const skill of installedSkills) {
    // Find matching marketplace skill
    let marketplaceSkill: MarketplaceSkill | null = null;
    for (const skillId of index) {
      const raw = db.getKV(`${MARKETPLACE_PREFIX}${skillId}`);
      if (!raw) continue;
      try {
        const ms: MarketplaceSkill = JSON.parse(raw);
        if (ms.name.toLowerCase() === skill.name.toLowerCase()) {
          marketplaceSkill = ms;
          break;
        }
      } catch { /* skip */ }
    }

    if (!marketplaceSkill) continue;

    const installedVersion = db.getKV(`skill_version:${skill.name}`) || "0.0.0";
    const latestVersion = marketplaceSkill.version;

    results.push({
      skill,
      currentVersion: installedVersion,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, installedVersion) > 0,
    });
  }

  return results;
}

/**
 * Check if skill dependencies are satisfied.
 */
export async function checkDependencies(
  dependencies: SkillDependency[],
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<Array<{ dep: SkillDependency; satisfied: boolean; detail: string }>> {
  const results: Array<{ dep: SkillDependency; satisfied: boolean; detail: string }> = [];

  for (const dep of dependencies) {
    let satisfied = false;
    let detail = "";

    switch (dep.type) {
      case "bin": {
        const result = await conway.exec(`which ${dep.name}`, 5000);
        satisfied = result.exitCode === 0;
        detail = satisfied ? `Found: ${result.stdout.trim()}` : `Binary not found: ${dep.name}`;
        break;
      }
      case "package": {
        const result = await conway.exec(`npm list -g ${dep.name} 2>/dev/null || npm list ${dep.name} 2>/dev/null`, 10000);
        satisfied = result.exitCode === 0;
        detail = satisfied ? `Package installed` : `Package not found: ${dep.name}`;
        break;
      }
      case "env": {
        satisfied = !!process.env[dep.name];
        detail = satisfied ? `Environment variable set` : `Missing env var: ${dep.name}`;
        break;
      }
      case "tool": {
        const tools = db.getInstalledTools();
        satisfied = tools.some((t) => t.name === dep.name && t.enabled);
        detail = satisfied ? `Tool available` : `Tool not installed: ${dep.name}`;
        break;
      }
    }

    if (dep.optional && !satisfied) {
      detail += " (optional)";
    }

    results.push({ dep, satisfied, detail });
  }

  return results;
}

/**
 * Install a skill from the marketplace by ID.
 */
export async function installFromMarketplace(
  skillId: string,
  db: AutomatonDatabase,
  conway: ConwayClient,
  skillsDir: string,
): Promise<Skill | null> {
  const marketplaceSkill = getMarketplaceSkill(skillId, db);
  if (!marketplaceSkill) {
    throw new Error(`Skill not found in marketplace: ${skillId}`);
  }

  // Check dependencies
  if (marketplaceSkill.dependencies.length > 0) {
    const depResults = await checkDependencies(marketplaceSkill.dependencies, conway, db);
    const unsatisfied = depResults.filter((r) => !r.satisfied && !r.dep.optional);
    if (unsatisfied.length > 0) {
      throw new Error(
        `Unsatisfied dependencies: ${unsatisfied.map((u) => `${u.dep.type}:${u.dep.name}`).join(", ")}`,
      );
    }
  }

  // If the skill has a source URL (git), clone it
  if (marketplaceSkill.sourceUrl && marketplaceSkill.sourceUrl.endsWith(".git")) {
    const { installSkillFromGit } = await import("./registry.js");
    const skill = await installSkillFromGit(
      marketplaceSkill.sourceUrl,
      marketplaceSkill.name,
      skillsDir,
      db,
      conway,
    );
    if (skill) {
      // Track installed version
      db.setKV(`skill_version:${skill.name}`, marketplaceSkill.version);
      // Increment download count
      marketplaceSkill.downloads++;
      db.setKV(`${MARKETPLACE_PREFIX}${skillId}`, JSON.stringify(marketplaceSkill));
    }
    return skill;
  }

  // If it has a skillMdUrl, fetch it
  if (marketplaceSkill.skillMdUrl) {
    const { installSkillFromUrl } = await import("./registry.js");
    const skill = await installSkillFromUrl(
      marketplaceSkill.skillMdUrl,
      marketplaceSkill.name,
      skillsDir,
      db,
      conway,
    );
    if (skill) {
      db.setKV(`skill_version:${skill.name}`, marketplaceSkill.version);
      marketplaceSkill.downloads++;
      db.setKV(`${MARKETPLACE_PREFIX}${skillId}`, JSON.stringify(marketplaceSkill));
    }
    return skill;
  }

  // Create from marketplace metadata as a self-authored skill
  const { createSkill } = await import("./registry.js");
  const skill = await createSkill(
    marketplaceSkill.name,
    marketplaceSkill.description,
    `Installed from marketplace (${marketplaceSkill.author})`,
    skillsDir,
    db,
    conway,
  );

  db.setKV(`skill_version:${skill.name}`, marketplaceSkill.version);
  marketplaceSkill.downloads++;
  db.setKV(`${MARKETPLACE_PREFIX}${skillId}`, JSON.stringify(marketplaceSkill));

  return skill;
}

/**
 * Simple semver comparison. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ─── Remote Skill Discovery ───────────────────────────────────

export interface RemoteSkillListing {
  name: string;
  description: string;
  version: string;
  tags: string[];
  dependencies: SkillDependency[];
  skillMdUrl: string;
}

export interface RemoteSkillCatalog {
  agent: string;
  agentAddress: string;
  agentUri: string;
  skills: RemoteSkillListing[];
  fetchedAt: string;
}

/**
 * Discover skills from remote automatons on the network.
 * Scans agent cards for a "skills" service endpoint, then fetches their catalog.
 */
export async function discoverRemoteSkills(
  options: {
    query?: string;
    tags?: string[];
    limit?: number;
    network?: "mainnet" | "testnet";
  } = {},
): Promise<RemoteSkillCatalog[]> {
  const { discoverAgents, fetchAgentCard } = await getDiscovery();
  const agents = await discoverAgents(options.limit || 30, options.network || "mainnet");
  const catalogs: RemoteSkillCatalog[] = [];

  for (const agent of agents) {
    try {
      const card = await fetchAgentCard(agent.agentURI);
      if (!card || !card.services) continue;

      // Look for a "skills" service endpoint
      const skillsService = card.services.find(
        (s) => s.name === "skills" || s.name === "skill-marketplace",
      );
      if (!skillsService) continue;

      const catalog = await fetchRemoteCatalog(
        agent,
        card,
        skillsService.endpoint,
      );
      if (!catalog || catalog.skills.length === 0) continue;

      // Apply filters
      let filtered = catalog.skills;

      if (options.query) {
        const q = options.query.toLowerCase();
        filtered = filtered.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.tags.some((t) => t.toLowerCase().includes(q)),
        );
      }

      if (options.tags && options.tags.length > 0) {
        const tags = options.tags.map((t) => t.toLowerCase());
        filtered = filtered.filter((s) =>
          tags.some((t) => s.tags.map((st) => st.toLowerCase()).includes(t)),
        );
      }

      if (filtered.length > 0) {
        catalogs.push({ ...catalog, skills: filtered });
      }
    } catch {
      // Skip agents that fail
    }
  }

  return catalogs;
}

/**
 * Fetch a remote automaton's skill catalog from their skills endpoint.
 */
export async function fetchRemoteCatalog(
  agent: DiscoveredAgent,
  card: AgentCard,
  endpoint: string,
): Promise<RemoteSkillCatalog | null> {
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data = await response.json() as { skills?: RemoteSkillListing[] };

    if (!data.skills || !Array.isArray(data.skills)) return null;

    // Validate each listing has required fields
    const validSkills = data.skills.filter(
      (s: any) => s.name && s.description && s.version && s.skillMdUrl,
    );

    return {
      agent: card.name || agent.agentId,
      agentAddress: agent.owner,
      agentUri: agent.agentURI,
      skills: validSkills.map((s: any) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        tags: Array.isArray(s.tags) ? s.tags : [],
        dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
        skillMdUrl: s.skillMdUrl,
      })),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Install a skill from a remote automaton's catalog.
 * Fetches the SKILL.md from the remote endpoint and installs locally.
 */
export async function installRemoteSkill(
  listing: RemoteSkillListing,
  sourceAgent: string,
  db: AutomatonDatabase,
  conway: ConwayClient,
  skillsDir: string,
): Promise<Skill | null> {
  // Check dependencies first
  if (listing.dependencies.length > 0) {
    const depResults = await checkDependencies(listing.dependencies, conway, db);
    const unsatisfied = depResults.filter((r) => !r.satisfied && !r.dep.optional);
    if (unsatisfied.length > 0) {
      throw new Error(
        `Unsatisfied dependencies: ${unsatisfied.map((u) => `${u.dep.type}:${u.dep.name}`).join(", ")}`,
      );
    }
  }

  // Fetch and install via URL
  const { installSkillFromUrl } = await import("./registry.js");
  const skill = await installSkillFromUrl(
    listing.skillMdUrl,
    listing.name,
    skillsDir,
    db,
    conway,
  );

  if (skill) {
    // Track version and source
    db.setKV(`skill_version:${skill.name}`, listing.version);
    db.setKV(`skill_source:${skill.name}`, JSON.stringify({
      agent: sourceAgent,
      url: listing.skillMdUrl,
      installedAt: new Date().toISOString(),
    }));
  }

  return skill;
}

/**
 * Generate the local skill catalog for serving to other automatons.
 * Returns the JSON response that should be served at the /skills endpoint.
 */
export function generateLocalCatalog(
  db: AutomatonDatabase,
  identity: AutomatonIdentity,
): { agent: string; address: string; skills: RemoteSkillListing[] } {
  const indexRaw = db.getKV(`${MARKETPLACE_PREFIX}index`);
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  const skills: RemoteSkillListing[] = [];

  for (const skillId of index) {
    const raw = db.getKV(`${MARKETPLACE_PREFIX}${skillId}`);
    if (!raw) continue;
    try {
      const ms: MarketplaceSkill = JSON.parse(raw);
      // Only expose skills authored by this automaton
      if (ms.authorAddress !== identity.address) continue;

      skills.push({
        name: ms.name,
        description: ms.description,
        version: ms.version,
        tags: ms.tags,
        dependencies: ms.dependencies,
        skillMdUrl: ms.skillMdUrl || ms.sourceUrl || "",
      });
    } catch {
      // skip corrupt entries
    }
  }

  return {
    agent: identity.name,
    address: identity.address,
    skills,
  };
}
