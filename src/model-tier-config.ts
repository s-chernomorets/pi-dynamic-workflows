/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string (e.g. "openai/gpt-4.1-mini" or "openai-codex/gpt-5.5:xhigh").
 * When an agent() call specifies opts.tier, that single model is resolved with
 * Pi CLI-style parsing and used as the subagent's model/thinking level (unless
 * an explicit opts.model is given, which always wins — see agent.ts).
 *
 * This augments the phase-pattern routing in model-routing.ts: phase routing
 * maps workflow phases → models via the script's meta; tiers give scripts a
 * coarse, user-configurable small/medium/big knob that is independent of any
 * concrete provider/model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_TIERS_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to a single model spec string (e.g. "gpt-4.1-mini", "openai/gpt-4.1-mini",
 * or "openai-codex/gpt-5.5:xhigh").
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Build a default tier config: every tier is the current Pi model.
 *
 * HARNESS FORK: the upstream substring "capability" ranker is REMOVED. It
 * guessed tier placement from model NAMES (`opus`/`pro`/`ultra`/`large`/`plus`
 * ranked highest, `mini`/`flash`/`haiku`/`nano`/`small` lowest), which crowned
 * gemini-2.5-pro as `big` purely for containing "pro" and silently made it the
 * workflow build model. Tiers must be predefined, never guessed from a name.
 *
 * Real tier values live in ~/.pi/workflows/model-tiers.json, deployed from the
 * harness repo (workflows/model-tiers.json) by `npm run deploy`. This default
 * only applies when that file is missing (fresh install) or on a
 * `/workflows-models` reset — and then it pins everything to the session's
 * current model: predictable, never name-ranked.
 *
 * `_availableModels` is kept in the signature for caller compatibility and is
 * deliberately ignored.
 */
export function buildDefaultTierConfig(currentModelSpec?: string, _availableModels?: string[]): ModelTierConfig {
  const fallback = currentModelSpec ?? "";
  return {
    tiers: {
      small: fallback,
      medium: fallback,
      big: fallback,
    },
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the model tier config from disk. Returns null if the file does not
 * exist or is unparseable (callers fall back to a default).
 */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tiers || typeof parsed.tiers !== "object") return null;
    for (const val of Object.values(parsed.tiers)) {
      if (typeof val !== "string") return null;
    }
    return parsed as ModelTierConfig;
  } catch {
    return null;
  }
}

/**
 * Save a model tier config to disk. Creates parent directories if needed.
 */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve / helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tier name to its configured model spec, or undefined if the tier
 * is not configured.
 */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  return config.tiers[tier];
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
