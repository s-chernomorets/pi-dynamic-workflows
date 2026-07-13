/**
 * HARNESS FORK: route every workflow agent() spawn through the harness router
 * (harness repo docs/router.md §1.2, chokepoint (b)).
 *
 * Workflow agent() calls createAgentSession directly inside the script
 * closure — they never pass through the parent session's tool_call hook, so
 * the subagent-guard chokepoint (a) structurally cannot see them. This module
 * resolves each spawn's engine via the shared resolver
 * (harness extensions/lib/routing.ts): caller-declared operation/size ×
 * write-capability (from the agent def's tools) × floors/ceilings, emitting a
 * concrete "provider/id[:thinking]" spec that overrides the old tier system
 * downstream (agent.ts resolveAgentModelSpec returns options.model first).
 *
 * FAIL-OPEN: a missing bridge, a missing/disabled router config, or any
 * resolution error → null → the spawn keeps its original spec, exactly as
 * upstream. Routing failure is never a spawn failure — but it IS logged
 * through the harness logger (harness-log.jsonl + /logs), not just stderr:
 * stderr-only reporting is how a total routing outage once stayed invisible
 * under the TUI.
 *
 * NO IMPORT of the harness lib, deliberately — the resolver arrives via a
 * globalThis bridge set by the harness `workflow-router-bridge` extension
 * (same process; globals cross jiti's per-extension module instances):
 *   - a dynamic `import()` of a .ts module that itself has relative .ts
 *     imports DEADLOCKS jiti when executed from inside a jiti-loaded
 *     extension in a live Pi session (verified 2026-07-13 by bisection: a
 *     dep-free stub imports fine; one nested `./config.ts` import hangs the
 *     workflow forever);
 *   - a static absolute-path import drags the harness lib into this
 *     package's tsc program and hard-couples it to an on-disk path.
 * If the bridge extension isn't loaded (fork used outside the harness, unit
 * tests), the global is absent → upstream behavior, with a one-time notice.
 */

/** Set by the harness workflow-router-bridge extension at session start. */
interface HarnessRouterBridge {
  loadRouterConfig: () => any;
  resolve: (rcfg: any, input: any) => any;
  writeRoutingRecord: (rcfg: any, record: any) => void;
  tripwireCheck: (rcfg: any, key: string, now: number) => boolean;
  promptRef: (prompt: string) => any;
  getLogger: (name: string) => { error: (m: string) => void; warn: (m: string) => void };
}

const WRITE_TOOLS = new Set(["write", "edit", "bash", "workflow"]);
const GRADES = ["light", "research", "coder", "heavy", "max"];
const TIER_TO_GRADE: Record<string, string> = { small: "light", medium: "research", big: "heavy" };

let harnessLogger: { error: (m: string) => void; warn: (m: string) => void } | undefined;
let warnedNoBridge = false;

function bridge(): HarnessRouterBridge | undefined {
  return (globalThis as any).__harnessWorkflowRouter;
}

function routerLog(level: "error" | "warn", msg: string): void {
  try {
    if (!harnessLogger) harnessLogger = bridge()?.getLogger("workflow-router");
    if (harnessLogger) {
      harnessLogger[level](msg);
      return;
    }
  } catch {
    // fall through to stderr
  }
  console.error(`[workflow-router] ${msg}`);
}

/**
 * Resolve the engine for one workflow agent spawn. Returns a
 * "provider/id[:thinking]" spec, or null to keep the spawn's original spec
 * (fail-open / routing disabled / nothing configured).
 *
 * `currentSpec` is the post-upstream-resolution model request (explicit model
 * / phase model / undefined for tier-or-session-default). A grade word routes
 * as a grade REQUEST; anything else as a raw-model request. A tier-only spawn
 * (no model, no operation) bridges its tier to a grade request
 * (small→light, medium→research, big→heavy) so authored intent survives —
 * operation, when declared, stays primary.
 */
export async function resolveWorkflowAgentModel(
  agentOptions: any,
  agentDef: any,
  currentSpec: string | undefined,
  prompt: string,
  runId: string,
): Promise<string | null> {
  // Kill-switch: unit tests (and any embedder that wants upstream behavior)
  // set PI_HARNESS_ROUTER=off so spawns are never routed against the live
  // harness config — routing here would make tests config-dependent and write
  // test garbage into the real routing.jsonl audit log.
  const killSwitch = process.env.PI_HARNESS_ROUTER;
  if (killSwitch === "off" || killSwitch === "0") return null;
  const b = bridge();
  if (!b) {
    if (!warnedNoBridge) {
      warnedNoBridge = true;
      console.error(
        "[workflow-router] harness bridge not found — workflow spawns un-routed (expected only outside the harness setup; check workflow-router-bridge in settings.json packages)",
      );
    }
    return null;
  }
  try {
    const rcfg = b.loadRouterConfig();
    if (!rcfg || rcfg.enabled === false) return null;
    // Write-capability from the shape's tools (undefined = default full toolset = write-capable, D3).
    const toolNames = agentDef?.tools;
    const writeCapable = Array.isArray(toolNames)
      ? toolNames.some((t: any) => WRITE_TOOLS.has(String(t).trim()))
      : undefined;
    // Strip any :thinking suffix before classifying the request.
    const raw = typeof currentSpec === "string" && currentSpec.trim() ? currentSpec.trim().split(":")[0] : undefined;
    let asGrade = raw && GRADES.includes(raw.toLowerCase()) ? raw.toLowerCase() : undefined;
    if (!asGrade && !raw && !agentOptions?.operation && agentOptions?.tier) {
      asGrade = TIER_TO_GRADE[String(agentOptions.tier).toLowerCase()];
    }
    const res = b.resolve(rcfg, {
      // Namespace workflow agentType under wf: so an author naming a type
      // "reviewer" can't inherit chokepoint (a)'s canonical shape floor
      // (harness audit L2). Workflow spawns declare operation explicitly, so
      // losing shape-inheritance here is intended.
      shape: agentOptions?.agentType ? `wf:${agentOptions.agentType}` : undefined,
      operation: agentOptions?.operation,
      size: agentOptions?.size,
      writeCapable,
      requestedGrade: asGrade,
      requestedModel: asGrade ? undefined : raw,
      hotPathText: typeof prompt === "string" ? prompt : undefined,
    });
    let tripwireFired = false;
    if (res.grade === "heavy" || res.grade === "max") {
      // Key on runId (per-run bucket), not a constant — else all workflows
      // share one tripwire counter on the shared globalThis.
      try {
        tripwireFired = b.tripwireCheck(rcfg, `wf:${typeof runId === "string" ? runId : "unknown"}`, Date.now());
      } catch {
        // Advisory only.
      }
      if (tripwireFired) {
        routerLog("warn", "tripwire: rapid heavy+ spawns in this run — check the fan-out or declare a bigger opts.size.");
      }
    }
    try {
      b.writeRoutingRecord(rcfg, {
        chokepoint: "workflow-fork",
        traceTag: process.env.PI_TRACE_TAG,
        agentType: agentOptions?.agentType,
        declared: { operation: agentOptions?.operation, size: agentOptions?.size },
        shape: { writeCapable, toolNames: Array.isArray(toolNames) ? toolNames : undefined },
        flags: { hotPath: res.hotPath },
        requestedGrade: asGrade,
        requestedModel: asGrade ? undefined : raw,
        resolvedGrade: res.grade,
        engineGrade: res.engineGrade,
        engine: res.model ? { model: res.model, thinking: res.thinking, provider: res.model.split("/")[0] } : undefined,
        // The spec the router EMITTED, not a post-resolution confirmation (harness audit M5).
        resolvedModelSpec: res.model || undefined,
        ruleFired: res.ruleFired,
        fallbackOccurred: res.fallbackOccurred,
        tripwireFired,
        // E10 — same shape as chokepoint (a).
        promptRef: b.promptRef ? b.promptRef(prompt) : undefined,
      });
    } catch {
      // Accounting never blocks a spawn.
    }
    for (const w of res.warnings ?? []) {
      routerLog("warn", String(w));
    }
    if (!res.model) return null; // nothing configured → keep the old spec (fail-open)
    return res.thinking ? `${res.model}:${res.thinking}` : res.model;
  } catch (e: any) {
    routerLog("error", `resolve failed (${e?.message ?? e}); spawn un-routed`);
    return null;
  }
}
