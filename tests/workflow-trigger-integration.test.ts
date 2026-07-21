import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installWorkflowEditor } from "../src/workflow-editor.js";

function harness(decision: "workflow" | "direct") {
  const handlers: Record<string, (...args: any[]) => any> = {};
  let tools = ["read", "bash"];
  const toolSnapshots: string[][] = [];
  let classifications = 0;
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler;
    },
    registerCommand: () => {},
    sendMessage: () => {},
    getActiveTools: () => [...tools],
    setActiveTools: (next: string[]) => {
      tools = [...next];
      toolSnapshots.push([...next]);
    },
  };
  const ui = { setEditorComponent: () => {} };
  installWorkflowEditor(pi as never, ui as never, undefined, {
    settingsStore: {
      load: () => ({ workflowTriggerMode: "semantic" }),
      save: () => true,
    },
    semanticClassifier: async () => {
      classifications++;
      return decision;
    },
  });
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => [] },
    signal: new AbortController().signal,
  };
  return { handlers, getTools: () => tools, toolSnapshots, classifications: () => classifications, notifications, ctx };
}

describe("semantic trigger input integration", () => {
  it("transforms a semantic WORKFLOW decision and keeps the tool until agent_settled", async () => {
    const h = harness("workflow");
    const result = await h.handlers.input({ source: "interactive", text: "audit every extension" }, h.ctx);
    assert.equal(result.action, "transform");
    assert.match(result.text, /workflows mode is ON/);
    assert.deepEqual(h.getTools(), ["read", "bash", "workflow"]);
    assert.equal(h.classifications(), 1);
    assert.equal(h.notifications.length, 1);

    h.handlers.agent_settled();
    assert.deepEqual(h.getTools(), ["read", "bash"]);
  });

  it("leaves a semantic DIRECT decision untouched", async () => {
    const h = harness("direct");
    const result = await h.handlers.input(
      { source: "interactive", text: "Here is a pasted transcript discussing a workflow" },
      h.ctx,
    );
    assert.deepEqual(result, { action: "continue" });
    assert.equal(h.classifications(), 1);
    assert.deepEqual(h.toolSnapshots, []);
    assert.deepEqual(h.getTools(), ["read", "bash"]);
  });

  it("does not classify slash commands or streaming follow-ups", async () => {
    const h = harness("workflow");
    assert.deepEqual(await h.handlers.input({ source: "interactive", text: "/help" }, h.ctx), {
      action: "continue",
    });
    assert.deepEqual(
      await h.handlers.input({ source: "interactive", text: "run a workflow", streamingBehavior: "followUp" }, h.ctx),
      { action: "continue" },
    );
    assert.equal(h.classifications(), 0);
  });
});
