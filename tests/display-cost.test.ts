/**
 * Tests for the HARNESS FORK cost-split formatting (display.ts):
 * api-billed vs subscription-covered dollars in run summaries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCostSplit, formatUsd } from "../src/display.js";

describe("formatUsd", () => {
  it("uses 4 decimals under a dollar, 2 above", () => {
    assert.equal(formatUsd(0.0231), "$0.0231");
    assert.equal(formatUsd(1.234), "$1.23");
    assert.equal(formatUsd(0), "$0.0000");
  });
});

describe("formatCostSplit", () => {
  it("splits api + sub when both are present", () => {
    assert.equal(
      formatCostSplit({ cost: 0.03, apiCost: 0.02, subCost: 0.01 }),
      " · $0.0300 (api $0.0200 + sub $0.0100)",
    );
  });

  it("labels a pure-api run", () => {
    assert.equal(formatCostSplit({ cost: 0.02, apiCost: 0.02, subCost: 0 }), " · $0.0200 api");
  });

  it("labels a pure-sub run", () => {
    assert.equal(formatCostSplit({ cost: 0.05, apiCost: 0, subCost: 0.05 }), " · $0.0500 sub");
  });

  it("falls back to the unlabeled total for pre-split persisted runs", () => {
    assert.equal(formatCostSplit({ cost: 0.04 }), " · $0.0400");
  });

  it("returns empty when there is nothing to report", () => {
    assert.equal(formatCostSplit({}), "");
    assert.equal(formatCostSplit({ cost: 0, apiCost: 0, subCost: 0 }), "");
  });
});
