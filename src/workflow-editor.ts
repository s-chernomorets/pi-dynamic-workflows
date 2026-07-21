/**
 * "Workflows mode" input affordance, à la a smart input box:
 *
 *  - While the editor text contains the word `workflow`/`workflows`, those letters
 *    render as a flowing rainbow, signalling that submitting will engage a workflow.
 *  - Pressing Backspace immediately after such a word toggles the highlight OFF
 *    (the word stays, but turns plain white) — a non-destructive "don't run a
 *    workflow after all". Re-typing a fresh trigger word turns it back on.
 *  - When the highlight is ON at submit time, the user's message is transformed to
 *    instruct Pi to actually run the workflow tool.
 *
 * Implementation: we replace the core editor with a thin subclass of the exported
 * `CustomEditor` (which itself extends pi-tui's `Editor`), overriding only
 * `render()` (to colorize) and `handleInput()` (for the Backspace toggle). All
 * other editor behavior — history, autocomplete, paste, undo, multiline — is
 * inherited untouched.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.js";
import { type EffortState, effortDirective, isSubstantive } from "./effort-command.js";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
  type WorkflowTriggerMode,
} from "./workflow-settings.js";
import {
  classifyWorkflowSemantically,
  isReferentialWorkflowRequest,
  recentContextMentionsWorkflow,
  resolveWorkflowTriggerMode,
  type SemanticWorkflowClassifier,
  shouldClassifyWorkflow,
} from "./workflow-trigger.js";

// A keyword trigger is a configured literal term. The default `workflow`
// trigger keeps legacy substring behavior and plural support (`workflows`) while
// custom trigger words match only that exact term. Slash commands like
// `/workflows` or `/pi-workflow` are left alone (not colored, not armed).
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function triggerSource(triggerWord: string): string {
  const escaped = escapeRegExp(triggerWord);
  if (triggerWord.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD) return `(?<!\\/)${escaped}s?`;
  return `(?<![/A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`;
}

function triggerRegex(triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD, flags = "i", atEnd = false): RegExp {
  const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
  return new RegExp(`${triggerSource(word)}${atEnd ? "$" : ""}`, flags);
}

/** 256-color ring cycling through the spectrum — shifted by a tick to "flow". */
export const RAINBOW = [
  196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45, 39, 33, 27, 21, 57,
  93, 129, 165, 201, 198, 197,
];

export function hasTrigger(text: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord).test(text);
}

export function endsWithTrigger(textBeforeCursor: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord, "i", true).test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
  triggerMode?: WorkflowTriggerMode;
  /** Legacy compatibility mirror: true only in keyword mode. */
  keywordTriggerEnabled: boolean;
  keywordTriggerWord?: string;
  suppressedKeywordText?: string;
}

export interface InstallWorkflowEditorOptions {
  settingsStore?: WorkflowSettingsStore;
  /** Test seam; production uses the configured stateless classifier. */
  semanticClassifier?: SemanticWorkflowClassifier;
}

interface AnsiToken {
  esc?: string;
  ch?: string;
}

/**
 * Split a rendered line into ANSI-escape tokens (passed through verbatim) and
 * single visible-character tokens. Handles CSI sequences (`\x1b[…m`, e.g. the
 * cursor's inverse-video) and APC/OSC string sequences (e.g. the zero-width
 * `CURSOR_MARKER` = `\x1b_pi:c\x07`) so colorization never corrupts them.
 */
export function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      let j = i + 1;
      const next = line[j];
      if (next === "[") {
        // CSI: ends at a final byte in 0x40–0x7e.
        j++;
        while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
        j++;
      } else if (next === "]" || next === "_" || next === "P" || next === "^") {
        // String sequence: ends at BEL (\x07) or ST (\x1b\\).
        j++;
        while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
        if (line[j] === "\x07") j++;
        else if (line[j] === "\x1b") j += 2;
      } else {
        j++; // lone ESC + one byte
      }
      tokens.push({ esc: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ ch: line[i] });
      i++;
    }
  }
  return tokens;
}

/**
 * Colorize every `workflow`/`workflows` occurrence in a rendered line with a
 * flowing rainbow, leaving all ANSI escapes (cursor, markers) intact. Returns the
 * line unchanged when it contains no trigger.
 */
export function colorizeWorkflow(
  line: string,
  tick: number,
  palette: number[] = RAINBOW,
  triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD,
): string {
  const tokens = tokenizeAnsi(line);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  if (!hasTrigger(visible, triggerWord)) return line;

  const ranges: Array<[number, number]> = [];
  const globalTrigger = triggerRegex(triggerWord, "gi");
  for (let m = globalTrigger.exec(visible); m; m = globalTrigger.exec(visible)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const inRange = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);

  let out = "";
  let vi = 0;
  for (const t of tokens) {
    if (t.esc !== undefined) {
      out += t.esc;
      continue;
    }
    if (inRange(vi)) {
      const color = palette[(vi + tick) % palette.length];
      // Reset only the foreground (39) afterwards so a surrounding inverse-video
      // (the cursor) is preserved.
      out += `\x1b[38;5;${color}m${t.ch}\x1b[39m`;
    } else {
      out += t.ch ?? "";
    }
    vi++;
  }
  return out;
}

/** Backspace arrives as DEL (0x7f) or BS (0x08) depending on the terminal. */
function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

/**
 * Editor that paints the trigger words and owns the on/off toggle. Reads/writes
 * `state.active` so the extension's `input` handler can decide whether to force a
 * workflow at submit time.
 */
export class WorkflowEditor extends CustomEditor {
  private tick = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** Toggled off by Backspace-after-word; re-armed when a fresh trigger appears. */
  private disabled = false;
  private wasTriggered = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly modeState: WorkflowModeState,
  ) {
    super(tui, theme, keybindings);
  }

  /** Highlighted/armed: a trigger is present and the user hasn't toggled it off. */
  isActive(): boolean {
    return (
      (this.modeState.triggerMode ?? (this.modeState.keywordTriggerEnabled ? "keyword" : "off")) === "keyword" &&
      !this.disabled &&
      hasTrigger(this.getText(), this.modeState.keywordTriggerWord)
    );
  }

  override handleInput(data: string): void {
    // First Backspace right after a trigger word disarms (non-destructive).
    if (isBackspace(data) && this.isActive() && this.cursorAfterTrigger()) {
      this.disabled = true;
      this.modeState.suppressedKeywordText = this.getText().trim();
      this.syncState();
      this.tui.requestRender();
      return;
    }
    const before = this.getText();
    super.handleInput(data);
    const after = this.getText();
    if (after !== before) {
      const now = hasTrigger(after, this.modeState.keywordTriggerWord);
      const normalizedAfter = after.trim();
      const suppressionCleared =
        this.modeState.suppressedKeywordText !== undefined &&
        normalizedAfter !== "" &&
        normalizedAfter !== this.modeState.suppressedKeywordText;
      if (suppressionCleared) {
        this.modeState.suppressedKeywordText = undefined;
      }
      // A freshly typed trigger re-arms a previously disabled box.
      if (now && (!this.wasTriggered || suppressionCleared)) this.disabled = false;
      this.wasTriggered = now;
    }
    this.syncState();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // Keep the shared state current even for non-keystroke changes (history
    // recall, programmatic setText) so the submit hook reads the right value.
    this.syncState();
    this.reconcileAnimation();
    if (!this.isActive() || lines.length === 0) return lines;
    // First and last lines are the editor's horizontal borders; only the text
    // lines in between are colorized.
    return lines.map((ln, i) =>
      i === 0 || i === lines.length - 1
        ? ln
        : colorizeWorkflow(ln, this.tick, RAINBOW, this.modeState.keywordTriggerWord),
    );
  }

  /** Absolute text before the cursor, used to detect "right after the word". */
  private cursorAfterTrigger(): boolean {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, col);
    return endsWithTrigger(before, this.modeState.keywordTriggerWord);
  }

  private syncState(): void {
    this.modeState.active = this.isActive();
  }

  private reconcileAnimation(): void {
    const shouldRun = this.isActive() && this.focused;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => {
        this.tick = (this.tick + 1) % (RAINBOW.length * 6);
        this.tui.requestRender();
      }, 90);
      // Don't keep the process alive for the animation.
      (this.timer as { unref?: () => void }).unref?.();
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The directive appended to a submitted message when workflows mode is armed.
 * `extraDirective` (e.g. an effort-tier nudge) is appended when present.
 */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[workflows mode is ON for this message]",
    "You MUST handle this request by calling the tool named exactly `workflow` (Pi's",
    "deterministic JavaScript workflow-orchestration tool from pi-dynamic-workflows).",
    "Write a workflow script that fans the task out across subagents via",
    "agent()/parallel()/pipeline().",
    "",
    "The ONLY acceptable action is a `workflow` tool call. Do NOT instead:",
    "- answer directly or in prose,",
    "- call the `subagent` tool yourself,",
    "- use any skill or command (e.g. pi-subagents, /code-review, deep-research),",
    '- or interpret the word "workflow/workflows" loosely as some other parallel/audit approach.',
    "Even for a small task, wrap it in a minimal `workflow` call with at least one agent().",
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/**
 * Install the workflows-mode editor and the submit-time forcing hook.
 * Call once with the UI context (e.g. in `session_start`).
 */
/** The exact name of the workflow tool that workflows mode forces. */
export const WORKFLOW_TOOL_NAME = "workflow";

function setTriggerMode(state: WorkflowModeState, mode: WorkflowTriggerMode): void {
  state.triggerMode = mode;
  state.keywordTriggerEnabled = mode === "keyword";
  state.active = false;
  state.suppressedKeywordText = undefined;
}

export function registerWorkflowTriggerCommand(
  pi: ExtensionAPI,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-trigger", {
    description: "Workflow auto-selection: semantic | keyword | off | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const raw = args.trim();
      const [command = "status", ...rest] = raw.split(/\s+/);
      const arg = command.toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-trigger", content, display: true });
      if (arg === "on" || arg === "semantic" || arg === "auto") {
        setTriggerMode(state, "semantic");
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          workflowTriggerMode: "semantic",
          keywordTriggerEnabled: true,
        });
        await say(
          saved
            ? "Semantic workflow trigger on — a small model now decides whether the current request benefits from workflow fan-out. Saved for new sessions."
            : "Semantic workflow trigger on for this session, but the preference could not be saved.",
        );
        return;
      }
      if (arg === "keyword") {
        setTriggerMode(state, "keyword");
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          workflowTriggerMode: "keyword",
          keywordTriggerEnabled: true,
        });
        await say(
          saved
            ? `Legacy keyword trigger on — mentioning ${triggerDisplayName(state.keywordTriggerWord)} forces a workflow. Saved for new sessions.`
            : "Legacy keyword trigger on for this session, but the preference could not be saved.",
        );
        return;
      }
      if (arg === "off") {
        setTriggerMode(state, "off");
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          workflowTriggerMode: "off",
          keywordTriggerEnabled: false,
        });
        await say(
          saved
            ? "Automatic workflow triggering off. Explicit /effort modes and manual workflow calls still work. Saved for new sessions."
            : "Automatic workflow triggering off for this session, but the preference could not be saved.",
        );
        return;
      }
      if (arg === "set") {
        const keywordTriggerWord = normalizeKeywordTriggerWord(rest.join(" "));
        if (!keywordTriggerWord) {
          await say(
            'Invalid trigger word. Use a non-empty term with no spaces and no leading "/", e.g. /workflows-trigger set pi-workflow',
          );
          return;
        }
        state.keywordTriggerWord = keywordTriggerWord;
        setTriggerMode(state, "keyword");
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          workflowTriggerMode: "keyword",
          keywordTriggerEnabled: true,
          keywordTriggerWord,
        });
        await say(
          saved
            ? `Legacy keyword trigger set to "${keywordTriggerWord}" and enabled. Saved for new sessions.`
            : `Legacy keyword trigger set to "${keywordTriggerWord}" for this session, but the preference could not be saved.`,
        );
        return;
      }
      if (arg === "reset") {
        state.keywordTriggerWord = DEFAULT_KEYWORD_TRIGGER_WORD;
        const saved = persistWorkflowTriggerSettings(settingsStore, {
          keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD,
        });
        await say(
          saved
            ? 'Legacy keyword reset to "workflow"; the current trigger mode was not changed.'
            : 'Legacy keyword reset to "workflow" for this session, but the preference could not be saved.',
        );
        return;
      }
      const mode = state.triggerMode ?? (state.keywordTriggerEnabled ? "keyword" : "off");
      await say(
        `Workflow trigger mode is ${mode}; legacy keyword is "${resolvedTriggerWord(state.keywordTriggerWord)}". Semantic classification is the default. Usage: /workflows-trigger semantic | keyword | off | set <word> | reset | status`,
      );
    },
  });
}

/**
 * Register the bottom progress-panel preference commands:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress-max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (arg === "compact" || arg === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: arg });
        await say(
          saved
            ? `Workflow progress panel set to ${arg} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${arg} for this session, but the preference could not be saved.`,
        );
        return;
      }
      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}. Usage: /workflows-progress compact | detailed | status`,
      );
    },
  });

  pi.registerCommand?.("workflows-progress-max", {
    description: "Max agents shown per phase in detailed progress mode (1-1000)",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (!arg) {
        await say(
          `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress-max <1-1000>`,
        );
        return;
      }
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) {
        await say(`Invalid value "${arg}". Usage: /workflows-progress-max <1-1000> (a whole number ≥ 1).`);
        return;
      }
      const clamped = Math.min(1000, n);
      const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
      await say(
        saved
          ? `Detailed progress now shows up to ${clamped} agents per phase.`
          : `Set to ${clamped} for this session, but the preference could not be saved.`,
      );
    },
  });
}

export function installWorkflowEditor(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  effort?: EffortState,
  options: InstallWorkflowEditorOptions = {},
): WorkflowModeState {
  const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
  const initialSettings = loadInitialWorkflowSettings(settingsStore);
  const semanticClassifier = options.semanticClassifier ?? classifyWorkflowSemantically;
  const triggerMode = resolveWorkflowTriggerMode(initialSettings);
  const state: WorkflowModeState = {
    active: false,
    triggerMode,
    keywordTriggerEnabled: triggerMode === "keyword",
    keywordTriggerWord: initialSettings.keywordTriggerWord ?? DEFAULT_KEYWORD_TRIGGER_WORD,
  };

  if (!ui.getEditorComponent?.()) {
    ui.setEditorComponent((tui, theme, keybindings) => new WorkflowEditor(tui, theme, keybindings, state));
  }
  registerWorkflowTriggerCommand(pi, state, settingsStore);
  registerWorkflowProgressCommands(pi, settingsStore);

  // Track only the tool this trigger adds. Restoring a stale full array would
  // overwrite unrelated tool changes made by other extensions during the turn.
  let addedWorkflowTool = false;

  // The input hook is async: semantic mode asks a small stateless model for a
  // conservative binary decision. Effort and legacy keyword modes remain explicit
  // deterministic overrides. Any classifier failure returns DIRECT.
  pi.on(
    "input",
    (event: { source?: string; text?: string; streamingBehavior?: "steer" | "followUp" }, ctx: ExtensionContext) => {
      if (event.source !== "interactive" || !event.text) return { action: "continue" } as const;
      const inputText = event.text;
      const normalizedText = inputText.trim();
      const suppressed = state.suppressedKeywordText === normalizedText;
      if (suppressed) state.suppressedKeywordText = undefined;

      const mode = state.triggerMode ?? (state.keywordTriggerEnabled ? "keyword" : "off");
      const byKeyword = mode === "keyword" && !suppressed && hasTrigger(inputText, state.keywordTriggerWord);
      const byEffort = !byKeyword && !!effort && effort.level !== "off" && isSubstantive(inputText);

      const force = (bySemantic: boolean) => {
        try {
          if (!addedWorkflowTool) {
            const current = pi.getActiveTools?.() ?? [];
            if (!current.includes(WORKFLOW_TOOL_NAME)) {
              pi.setActiveTools?.([...current, WORKFLOW_TOOL_NAME]);
              addedWorkflowTool = true;
            }
          }
        } catch {
          // Tool activation is best-effort; the directive still explains the required action.
        }
        if (bySemantic) ctx.ui.notify("Workflow selected by semantic trigger", "info");
        const extra = byEffort && effort ? effortDirective(effort.level) : undefined;
        return { action: "transform", text: buildForcedWorkflowPrompt(inputText, extra) } as const;
      };

      if (byKeyword || byEffort) return force(false);
      const semanticCandidate =
        shouldClassifyWorkflow(inputText, event.streamingBehavior) ||
        (isReferentialWorkflowRequest(inputText) &&
          !event.streamingBehavior &&
          recentContextMentionsWorkflow(ctx));
      if (mode !== "semantic" || !semanticCandidate) return { action: "continue" } as const;
      return semanticClassifier(inputText, ctx, initialSettings).then((decision) =>
        decision === "workflow" ? force(true) : ({ action: "continue" } as const),
      );
    },
  );

  // Keep the workflow tool available across all model/tool rounds, then remove only
  // the capability this trigger added after the complete agent loop settles.
  pi.on("agent_settled", () => {
    if (!addedWorkflowTool) return;
    addedWorkflowTool = false;
    try {
      const current = pi.getActiveTools?.() ?? [];
      pi.setActiveTools?.(current.filter((name) => name !== WORKFLOW_TOOL_NAME));
    } catch {
      // Best-effort cleanup; never disrupt completion for a UI/tool-state failure.
    }
  });

  return state;
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function loadInitialWorkflowSettings(settingsStore: WorkflowSettingsStore): WorkflowSettings {
  try {
    const settings = settingsStore.load();
    return {
      workflowTriggerMode: settings.workflowTriggerMode,
      keywordTriggerEnabled: settings.keywordTriggerEnabled,
      keywordTriggerWord: normalizeKeywordTriggerWord(settings.keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD,
      workflowTriggerModel: settings.workflowTriggerModel,
      workflowTriggerTimeoutMs: settings.workflowTriggerTimeoutMs,
    };
  } catch {
    return { workflowTriggerMode: "semantic", keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD };
  }
}

function persistWorkflowTriggerSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function resolvedTriggerWord(keywordTriggerWord: string | undefined): string {
  return normalizeKeywordTriggerWord(keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
}

function triggerDisplayName(keywordTriggerWord: string | undefined): string {
  const word = resolvedTriggerWord(keywordTriggerWord);
  return word.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "workflow/workflows" : `"${word}"`;
}

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
