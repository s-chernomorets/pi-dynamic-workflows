/**
 * HARNESS FORK: extension whitelist for workflow agent sessions.
 *
 * Upstream spawns workflow agents with the DEFAULT resource loader, so every
 * child session loads ALL of the user's extensions — main-session machinery
 * (mask, digest, inspect), orchestration tools (subagents, nested workflow
 * spawning), everything. This module builds a filtered resource loader that
 * keeps only the extensions named in the "workflow-extensions" section of the
 * harness repo's config:
 *
 *   { "workflow-extensions": { "enabled": true, "allow": ["guard", "trace", ...] } }
 *
 * The config is read PER SPAWN, so editing the list needs no restart.
 * Fail-open: a missing/disabled/broken config returns null and the caller
 * keeps the default loader — children load all extensions, exactly as
 * upstream. Debug: PI_WF_EXT_DEBUG=1 prints kept/dropped per spawn.
 */

import { readFileSync } from "node:fs";
import { DefaultResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";

/** Overridable for tests / a relocated harness repo. */
const HARNESS_CONFIG_PATH = process.env.PI_HARNESS_CONFIG ?? "/Users/sergey/work/harness/harness.config.json";

let warnedBrokenConfig = false;

/**
 * The allow-list from harness.config.json, or null when filtering is off
 * (section absent, disabled, unreadable, or malformed — all fail-open).
 */
function extensionAllowList(): string[] | null {
  try {
    const cfg = JSON.parse(readFileSync(HARNESS_CONFIG_PATH, "utf8"));
    const sec = cfg["workflow-extensions"];
    if (!sec || sec.enabled === false) return null;
    if (!Array.isArray(sec.allow)) {
      if (!warnedBrokenConfig) {
        warnedBrokenConfig = true;
        console.warn("[workflow-ext-whitelist] 'allow' is not an array; loading all extensions");
      }
      return null;
    }
    return sec.allow.filter((e: unknown): e is string => typeof e === "string" && e.length > 0);
  } catch (err) {
    if (!warnedBrokenConfig) {
      warnedBrokenConfig = true;
      console.warn(
        `[workflow-ext-whitelist] config unreadable (${err instanceof Error ? err.message : err}); loading all extensions`,
      );
    }
    return null;
  }
}

/**
 * Whether an extension matches an allow-list entry. An entry containing "/"
 * matches as a scoped-name substring (e.g. "@gotgenes/pi-permission-system");
 * otherwise it matches a whole path segment or the basename minus extension.
 */
function extensionMatches(ext: { path?: string; resolvedPath?: string }, allow: string[]): boolean {
  const candidates = [ext.path, ext.resolvedPath].filter((p): p is string => typeof p === "string");
  for (const entry of allow) {
    for (const raw of candidates) {
      const p = raw.replace(/\\/g, "/");
      if (entry.includes("/")) {
        if (p.includes(entry)) return true;
        continue;
      }
      const segs = p.replace(/^npm:/, "").split("/").filter(Boolean);
      if (segs.includes(entry)) return true;
      const base = segs[segs.length - 1] ?? "";
      if (base.replace(/\.(ts|js|mjs|cjs)$/, "") === entry) return true;
    }
  }
  return false;
}

/**
 * Build a resource loader whose extension set is filtered by the harness
 * whitelist, or null when filtering is off (caller keeps the default loader).
 */
export async function createFilteredResourceLoader(
  cwd: string | undefined,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<DefaultResourceLoader | null> {
  const allow = extensionAllowList();
  if (!allow) return null;
  // An EMPTY allow-list would filter out every extension — including the model
  // provider — leaving the child session silently broken. Treat it as a broken
  // config: fail open like the other degenerate branches.
  if (allow.length === 0) {
    if (!warnedBrokenConfig) {
      warnedBrokenConfig = true;
      console.warn("[workflow-ext-whitelist] 'allow' is empty; loading all extensions");
    }
    return null;
  }
  const loader = new DefaultResourceLoader({
    // createAgentSession defaults an absent cwd to process.cwd(); mirror that.
    cwd: cwd ?? process.cwd(),
    agentDir,
    settingsManager,
    extensionsOverride: (base) => {
      const kept = base.extensions.filter((e) => extensionMatches(e, allow));
      if (process.env.PI_WF_EXT_DEBUG) {
        const dropped = base.extensions.filter((e) => !kept.includes(e));
        console.error(
          `[workflow-ext-whitelist] kept ${kept.length}/${base.extensions.length}: ${kept.map((e) => e.path).join(", ")}`,
        );
        console.error(`[workflow-ext-whitelist] dropped: ${dropped.map((e) => e.path).join(", ")}`);
      }
      return { ...base, extensions: kept };
    },
  });
  await loader.reload();
  return loader;
}
