/**
 * Tests for model-tier-config.ts
 *
 * Covers:
 * 1. buildDefaultTierConfig — every tier pins to the current model (HARNESS
 *    FORK: the upstream substring "capability" ranker is removed; tiers are
 *    never guessed from model names, and the registry is ignored)
 * 2. resolveTierModel logic
 * 3. save/load round-trip + all validation/error paths (scoped to a temp dir)
 * 4. sortedTierNames helper
 *
 * All tier configs are single-model-per-tier (Record<string, string>).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.js");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model when no models are available", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      // Explicitly inject an empty registry so this exercises the "no models
      // known" fallback rather than depending on whatever registry happens to
      // be configured in the environment running the tests.
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      assert.deepEqual(cfg.tiers, {
        small: "openai/gpt-4.1",
        medium: "openai/gpt-4.1",
        big: "openai/gpt-4.1",
      });
    });

    it("each tier holds a single string", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      for (const [name, model] of Object.entries(cfg.tiers)) {
        assert.equal(typeof model, "string", `${name} tier should hold a string`);
      }
    });

    it("always produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1", []);
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
    });

    it("pins every tier to the current model even when a rich registry is available (ranker removed)", async () => {
      // HARNESS FORK regression guard: upstream would rank these by name
      // substring ("opus"/"mini") and spread them across tiers. The fork must
      // IGNORE the registry entirely — a model's name says nothing about its
      // capability (gemini-2.5-pro landed in `big` for containing "pro").
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("litellm/current", ["claude-3-opus", "gpt-4o-mini", "gemini-2.5-pro"]);
      assert.deepEqual(cfg.tiers, {
        small: "litellm/current",
        medium: "litellm/current",
        big: "litellm/current",
      });
    });

    it("never assigns a model from the registry to any tier", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const registry = ["a-nano", "b-neutral", "c-ultra", "vendor/plus-model"];
      const cfg = buildDefaultTierConfig("session-model", registry);
      for (const [name, model] of Object.entries(cfg.tiers)) {
        assert.ok(!registry.includes(model), `${name} tier must not be name-ranked from the registry (got ${model})`);
      }
    });

    it("with no available models and no current model, all tiers are empty strings", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, []);
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
      for (const val of Object.values(cfg.tiers)) {
        assert.equal(val, "");
      }
    });

    it("the no-argument path is safe and produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig();
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
      for (const val of Object.values(cfg.tiers)) {
        assert.equal(val, "");
      }
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = {
        tiers: { small: "openai/gpt-4.1-mini", medium: "openai/gpt-4.1", big: "openai/gpt-5" },
      };
      assert.equal(resolveTierModel("small", config), "openai/gpt-4.1-mini");
      assert.equal(resolveTierModel("medium", config), "openai/gpt-4.1");
      assert.equal(resolveTierModel("big", config), "openai/gpt-5");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("nonexistent", { tiers: { small: "gpt-4.1-mini" } }), undefined);
    });

    it("returns empty string when tier exists but no model is assigned", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("medium", { tiers: { small: "gpt-4.1-mini", medium: "" } }), "");
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig (scoped to tmpdir)", () => {
    it("round-trips a valid config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = {
        tiers: { small: "gpt-4.1-mini", medium: "gpt-4.1", big: "gpt-5" },
      };
      saveModelTierConfig(config, cfgPath);
      const loaded = loadModelTierConfig(cfgPath);
      assert.deepEqual(loaded, config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "nonexistent-test-file.json")), null);
    });

    it("returns null for corrupted JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, "{invalid json", "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for non-object JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '"just a string"', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when tiers is not an object", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": "not-an-object"}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when a tier value is not a string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": ["gpt-4.1-mini"]}}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null, "array values should be rejected");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts a config where a tier value is a valid string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": "gpt-4.1-mini"}}', "utf-8");
      const result = loadModelTierConfig(cfgPath);
      assert.equal(result?.tiers.small, "gpt-4.1-mini");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("returns names sorted: small < medium < big", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { big: "gpt-5", small: "gpt-4.1-mini", medium: "gpt-4.1" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "big"]);
    });

    it("places custom tier names alphabetically after the standard ones", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { xlarge: "gpt-5", medium: "gpt-4.1", small: "gpt-4.1-mini" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "xlarge"]);
    });
  });
});
