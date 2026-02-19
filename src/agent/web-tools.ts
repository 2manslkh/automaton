/**
 * Web Browsing Tools — web_fetch and web_search
 *
 * Includes injection defense, rate limiting, and content sanitization.
 */

import type { AutomatonTool } from "../types.js";
import { getQuotaManager } from "../utils/quota-manager.js";

// ─── Rate Limiter (unified) ───────────────────────────────────

export function checkRateLimit(): string | null {
  return getQuotaManager().checkWebFetch();
}

export function checkSearchRateLimit(): string | null {
  return getQuotaManager().checkWebSearch();
}

/** Reset rate limiter (for testing) */
export function resetRateLimit(): void {
  const { resetQuotaManager } = require("../utils/quota-manager.js");
  resetQuotaManager();
}

// ─── Content Sanitization / Injection Defense ──────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /system\s*:\s*/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<<\s*SYS\s*>>/gi,
  /<<\s*\/SYS\s*>>/gi,
  /\bHuman:\s/g,
  /\bAssistant:\s/g,
];

export function sanitizeContent(raw: string): string {
  let sanitized = raw;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

export function wrapUntrusted(content: string, url: string): string {
  return `═══ UNTRUSTED WEB CONTENT from ${url} ═══\n${content}\n═══ END UNTRUSTED WEB CONTENT ═══`;
}

// ─── HTML → Text Extraction ────────────────────────────────────

export function htmlToText(html: string): string {
  let text = html;
  // Remove script/style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ─── Constants ─────────────────────────────────────────────────

const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Automaton/1.0 (Conway AI Agent)";

// ─── Tools ─────────────────────────────────────────────────────

export function createWebTools(): AutomatonTool[] {
  return [
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return the content as readable text. Handles HTML (extracts text), JSON (pretty prints), and plain text. Rate limited to 10 requests/minute.",
      category: "web" as any,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch (must start with http:// or https://)",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (default: ${FETCH_TIMEOUT_MS})`,
          },
        },
        required: ["url"],
      },
      execute: async (args, _ctx) => {
        const url = args.url as string;

        // Validate URL
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return "Error: URL must start with http:// or https://";
        }

        // Rate limit check
        const rateLimitError = checkRateLimit();
        if (rateLimitError) return rateLimitError;

        const timeoutMs = (args.timeout_ms as number) || FETCH_TIMEOUT_MS;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "text/html,application/json,text/plain,*/*",
            },
            redirect: "follow",
          });

          clearTimeout(timer);

          if (!response.ok) {
            return `Error: HTTP ${response.status} ${response.statusText}`;
          }

          const contentType = response.headers.get("content-type") || "";
          let body = await response.text();

          // Truncate to max size
          if (body.length > MAX_RESPONSE_SIZE) {
            body = body.slice(0, MAX_RESPONSE_SIZE) + "\n... [truncated at 100KB]";
          }

          let result: string;

          if (contentType.includes("application/json")) {
            try {
              result = JSON.stringify(JSON.parse(body), null, 2);
            } catch {
              result = body;
            }
          } else if (contentType.includes("text/html")) {
            result = htmlToText(body);
          } else {
            result = body;
          }

          // Sanitize and wrap
          result = sanitizeContent(result);
          return wrapUntrusted(result, url);
        } catch (err: any) {
          if (err.name === "AbortError") {
            return `Error: Request timed out after ${timeoutMs}ms`;
          }
          return `Error: ${err.message}`;
        }
      },
    },
    {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns results as title + URL + snippet. Rate limited to 10 requests/minute.",
      category: "web" as any,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results (default: 5, max: 10)",
          },
        },
        required: ["query"],
      },
      execute: async (args, _ctx) => {
        const query = args.query as string;
        const maxResults = Math.min((args.max_results as number) || 5, 10);

        // Rate limit check
        const rateLimitError = checkSearchRateLimit();
        if (rateLimitError) return rateLimitError;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

          // Use DuckDuckGo HTML search
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "text/html",
            },
          });

          clearTimeout(timer);

          if (!response.ok) {
            return `Error: Search failed with HTTP ${response.status}`;
          }

          const html = await response.text();
          const results = parseDuckDuckGoResults(html, maxResults);

          if (results.length === 0) {
            return `No results found for: "${query}"`;
          }

          const formatted = results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
            )
            .join("\n\n");

          return wrapUntrusted(
            sanitizeContent(`Search results for: "${query}"\n\n${formatted}`),
            searchUrl,
          );
        } catch (err: any) {
          if (err.name === "AbortError") {
            return `Error: Search timed out`;
          }
          return `Error: ${err.message}`;
        }
      },
    },
  ];
}

// ─── DuckDuckGo HTML Parser ────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <div class="result"> blocks
  // Each has <a class="result__a"> for title/url and <a class="result__snippet"> for snippet
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i]!;

    // Extract title and URL from result__a
    const titleMatch = block.match(
      /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!titleMatch) continue;

    let url = titleMatch[1] || "";
    const title = htmlToText(titleMatch[2] || "").trim();

    // DuckDuckGo wraps URLs in a redirect — extract actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]!);
    }

    // Extract snippet
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/,
    );
    const snippet = snippetMatch
      ? htmlToText(snippetMatch[1] || "").trim()
      : "";

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}
