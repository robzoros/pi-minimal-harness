/**
 * Smoke test for .pi/extensions/harness.ts (project-local Pi extension).
 *
 * Run with:  node tests/harness.test.mjs
 *
 * Platform: Windows, macOS and Linux. Paths come from `os.tmpdir()` and the
 * extension is imported through `pathToFileURL`, so no WSL/Posix-only path is
 * assumed. Node releases before 22.18 cannot import the TypeScript extension
 * without a flag, so the test re-runs itself with it instead of failing.
 *
 * Drives the registered commands, events and tool with fakes and asserts the
 * pipeline, footer status, question short-circuit, final-report guarantee,
 * decision handling, validation and the dispatch seams. Never touches the real
 * harness.config.yaml: everything runs against a temp copy of the project.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

// Node < 22.18 needs --experimental-strip-types to import harness.ts. Re-run
// the whole smoke test once with the flag, keeping the documented command.
if (!process.features?.typescript && !process.env.PI_HARNESS_TS_RESPAWN) {
  const respawn = spawnSync(process.execPath, ["--experimental-strip-types", SELF], {
    stdio: "inherit",
    env: { ...process.env, PI_HARNESS_TS_RESPAWN: "1" },
  });
  if (respawn.error) {
    console.error(`FAIL cannot re-run with --experimental-strip-types — ${respawn.error.message}`);
    process.exit(1);
  }
  process.exit(respawn.status ?? 1);
}

const mod = await import(pathToFileURL(path.join(ROOT, ".pi", "extensions", "harness.ts")).href);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// --- temp project: config (forced state) + prompts + contract ---------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-test-"));
const cfgPath = path.join(tmp, "harness.config.yaml");
let cfgText = await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8");
// Force the flags this test depends on, so it never depends on live config state.
cfgText = cfgText
  .replace(/^ {2}workflow_mode: .*$/m, "  workflow_mode: full-dry-run")
  .replace(/^ {2}auto_harness: .*$/m, "  auto_harness: true")
  .replace(/^ {2}analysis_routing: .*$/m, "  analysis_routing: true")
  .replace(/^ {2}allow_dispatch: .*$/m, "  allow_dispatch: true")
  .replace(/^ {2}strict_decision_marker: .*$/m, "  strict_decision_marker: true")
  .replace(/^ {2}preflight_policy: .*$/m, "  preflight_policy: advisory")
  // Keep the smoke test independent of the operator's live model choices.
  .replace(/^ {4}model: .*$/gm, "    model: opencode-go/gpt-5.1")
  .replace(/(^  orchestrator:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^  architect:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}explorer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}critic:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^ {2}implementer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}delivery:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1low");
await fs.writeFile(cfgPath, cfgText);
await fs.cp(path.join(ROOT, "prompts"), path.join(tmp, "prompts"), { recursive: true });
await fs.cp(path.join(ROOT, ".agents"), path.join(tmp, ".agents"), { recursive: true });
await fs.copyFile(path.join(ROOT, "pi-minimal-harness.md"), path.join(tmp, "pi-minimal-harness.md"));

// --- fakes -------------------------------------------------------------------
const events = {};
const commands = {};
const tools = {};
const sent = [];
const setModelCalls = [];
const thinkingCalls = [];
const notifies = [];
const statuses = [];
const widgets = [];
const branchArr = [];
const assistantScript = [];
const toolErrors = [];
/** ctx.abort() calls recorded by command contexts in stop/end tests. */
const aborts = [];
/** Tool call to emit on the next assistant turn: { name, params, text }. */
let pendingToolCall = null;
/**
 * Stop reason the next scripted assistant turn ends with. Reset by `reset()`;
 * a scripted `{ text, stopReason }` entry sets it (REQ-016). The pipeline reads
 * it through the branch, exactly as the real runtime reports it.
 */
let assistantStopReason = "end";
let assistantTextOverride = null;
let turnN = 0;
let assistantTurns = 0;
let idle = true;
let activeCtx = null;

const nextAssistantText = (turn = 0) => {
  // A scripted entry may be an object, to script the stop reason as well as the
  // text: REQ-016 retries a step whose turn ends in `error`, and the pipeline
  // path had no way to produce one before this. The reason is latched into
  // `assistantStopReason` and consumed by the turn that carries the text, so a
  // scripted `{ text, stopReason }` describes the turn it is paired with.
  if (assistantScript.length > 0) {
    const entry = assistantScript.shift();
    if (entry && typeof entry === "object") {
      if (entry.stopReason) assistantStopReason = entry.stopReason;
      if (entry.tool) pendingToolCall = null; // consumed above, before the turn
      return entry.text ?? "";
    }
    return entry;
  }
  if (assistantTextOverride) return assistantTextOverride;
  turnN++;
  // The first assistant turn is the orchestrator: it must declare a decision on
  // its last line or the pipeline fails closed.
  if (turn === 1) return `output-of-turn-1\n\nHARNESS-DECISION: PIPELINE`;
  return `output-of-turn-${turnN}\n\nHARNESS-DONE`;
};

const models = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", provider: "opencode-go", reasoning: false },
  { id: "mimo-v2.6-flash", name: "MiMo v2.6 Flash", provider: "opencode-go", reasoning: true },
  {
    id: "gpt-5.1",
    name: "GPT 5.1",
    provider: "opencode-go",
    reasoning: true,
    thinkingLevelMap: { xhigh: null, max: "max" },
  },
  { id: "gpt-5.1-mini", name: "GPT 5.1 Mini", provider: "opencode-go", reasoning: true },
];
const originalModel = { id: "orig", provider: "orig-p" };

const fakePi = {
  registerCommand: (name, opts) => (commands[name] = opts),
  registerTool: (tool) => (tools[tool.name] = tool),
  on: (event, handler) => {
    events[event] = handler;
    return () => {};
  },
  // Durable state the harness persists, written the way Pi writes it: a custom
  // entry in the branch, excluded from the model context. `session_start` reads
  // it back through `getBranch()`, which is exactly how the real reload path
  // finds it.
  appendEntry: (customType, data) => {
    branchArr.push({ type: "custom", customType, data });
  },
  sendUserMessage: (text) => {
    sent.push(text);
    branchArr.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    idle = false;
    setTimeout(async () => {
      assistantTurns++;
      // A scripted entry may carry the tool call it wants on this turn. Read
      // here, before `pendingToolCall` is consumed: REQ-015's repair round needs
      // several steps to each report their own checks, and a FIFO script cannot
      // express "turn 5 calls the tool, turns 2-4 do not" otherwise.
      const scripted = assistantScript.length > 0 ? assistantScript[0] : null;
      if (scripted && typeof scripted === "object" && scripted.tool) pendingToolCall = scripted.tool;
      const call = pendingToolCall;
      pendingToolCall = null;
      if (call) {
        // A tool turn, as the runtime really produces it: the assistant
        // message carrying the tool call is emitted first (message_end runs
        // before the tool executes), then the tool runs, then the follow-up
        // text message arrives.
        const callId = `call-${assistantTurns}`;
        const toolMessage = {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            ...(call.text ? [{ type: "text", text: call.text }] : []),
            { type: "toolCall", id: callId, name: call.name, arguments: call.params },
          ],
        };
        const toolHandler = events["message_end"];
        if (toolHandler) {
          try {
            const result = await toolHandler({ type: "message_end", message: toolMessage }, activeCtx);
            if (result && result.message) Object.assign(toolMessage, result.message);
          } catch {
            // keep the original message if the handler fails
          }
        }
        branchArr.push({ type: "message", message: toolMessage });
        await new Promise((r) => setTimeout(r, 20));
        const tool = tools[call.name];
        if (tool) {
          try {
            await tool.execute(callId, call.params, undefined, undefined, activeCtx);
          } catch (error) {
            toolErrors.push(String(error));
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      // Order matters: the text is drawn first, because a scripted object entry
      // latches the stop reason for the turn it belongs to. The latch is then
      // consumed, so the turn after it ends normally unless it is scripted too.
      const turnText = nextAssistantText(assistantTurns);
      const turnStopReason = assistantStopReason;
      assistantStopReason = "end";
      let message = {
        role: "assistant",
        stopReason: turnStopReason,
        errorMessage: turnStopReason === "error" ? "simulated model error" : undefined,
        content: [{ type: "text", text: turnText }],
      };
      const handler = events["message_end"];
      if (handler) {
        try {
          const result = await handler({ type: "message_end", message }, activeCtx);
          if (result && result.message) message = result.message;
        } catch {
          // keep the original message if the handler fails
        }
      }
      branchArr.push({ type: "message", message });
      idle = true;
    }, 60);
  },
  setModel: async (m) => {
    setModelCalls.push(`${m.provider}/${m.id}`);
    return true;
  },
  setThinkingLevel: (lvl) => thinkingCalls.push(lvl),
  getThinkingLevel: () => "high",
};

const makeCtx = (cwd, isCommand) => {
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    model: originalModel,
    modelRegistry: { getAvailable: () => models, getAll: () => [] },
    sessionManager: { getBranch: () => [...branchArr] },
    isIdle: () => idle,
    ui: {
      notify: (m, t) => notifies.push(`[${t ?? "info"}] ${m}`),
      setStatus: (k, v) => statuses.push(v),
      setWidget: (k, v) => widgets.push(v),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    ...(isCommand ? { waitForIdle: async () => { await new Promise((r) => setTimeout(r, 140)); } } : {}),
  };
  activeCtx = ctx;
  return ctx;
};

await mod.default(fakePi);

const waitTurn = async () => {
  await new Promise((r) => setTimeout(r, 140));
  return true;
};
const reset = () => {
  sent.length = 0;
  notifies.length = 0;
  statuses.length = 0;
  setModelCalls.length = 0;
  thinkingCalls.length = 0;
  assistantScript.length = 0;
  assistantTextOverride = null;
  assistantStopReason = "end";
  assistantTurns = 0;
  pendingToolCall = null;
  toolErrors.length = 0;
  aborts.length = 0;
  // The wait now reads idleness from the session: a leftover `false` would
  // send the next test into the wait's bound, so the flag is restored here.
  idle = true;
  // The design session is persisted by writing an entry to the branch, and
  // `session_start` reads it back from there. Without clearing it, a session
  // opened by one test would be restored into the next — so the test that exists
  // to prove persistence would be reading its own leftovers. Note this clears
  // the persisted copy only: it does not close a session that is open in memory,
  // because several tests deliberately keep one open across a reset. Those close
  // it with /harness-end, as a user would.
  branchArr.length = 0;
};

// --- registration ------------------------------------------------------------
check(
  "factory registers commands",
  ["harness-config", "harness-mode", "harness-model", "harness-run", "harness-stop", "harness-delivery", "harness-auto"].every((c) => c in commands),
  Object.keys(commands).join(","),
);
check(
  "factory registers session_start + input + message_end",
  "session_start" in events && "input" in events && "message_end" in events,
);
check("factory registers dispatch tool", !!tools["harness-dispatch"] && typeof tools["harness-dispatch"].execute === "function");

// --- helpers -----------------------------------------------------------------
const lines = cfgText.split(/\r?\n/);

check("getWorkflowSteps(analysis)", JSON.stringify(mod.getWorkflowSteps(lines, "analysis")) === '["orchestrator","architect"]');
check("getWorkflowSteps(full-dry-run)", JSON.stringify(mod.getWorkflowSteps(lines, "full-dry-run")) === '["orchestrator","explorer","critic"]');
check("getWorkflowSteps(missing) -> null", mod.getWorkflowSteps(lines, "nope") === null);
check("isAutoHarness true", mod.isAutoHarness(lines) === true);
check(
  "setAutoHarness off/on roundtrip",
  mod.isAutoHarness(mod.setAutoHarness(lines, false)) === false &&
    mod.isAutoHarness(mod.setAutoHarness(mod.setAutoHarness(lines, false), true)) === true,
);
const withoutAnalysisRouting = (extra) =>
  lines.map((l) => {
    if (l.startsWith("  analysis_routing:")) return extra === undefined ? "" : `  analysis_routing: ${extra}`;
    if (l.startsWith("  question_short_circuit:")) return extra === undefined ? "" : `  question_short_circuit: ${extra}`;
    return l;
  });
check("isAnalysisRouting true from the configured key", mod.isAnalysisRouting(lines) === true);
check(
  "isAnalysisRouting false when the key is false",
  mod.isAnalysisRouting(lines.map((l) => (l.startsWith("  analysis_routing:") ? "  analysis_routing: false" : l))) === false,
);
check(
  "isAnalysisRouting falls back to a legacy question_short_circuit: false",
  mod.isAnalysisRouting(withoutAnalysisRouting(false)) === false,
  "the new key wins; without it the old key still decides",
);
check(
  "isAnalysisRouting defaults to true with neither key present",
  mod.isAnalysisRouting(withoutAnalysisRouting(undefined)) === true,
);
check("getRequirementsFile default", mod.getRequirementsFile(lines) === "REQUIREMENTS.md");
check(
  "listWorkflows reports the declared modes",
  JSON.stringify(mod.listWorkflows(lines)) === JSON.stringify(["full-dry-run", "full", "analysis"]),
  JSON.stringify(mod.listWorkflows(lines)),
);
check("isAllowDispatch true", mod.isAllowDispatch(lines) === true);
check("getDefaultString reads a configured key", mod.getDefaultString(lines, "workflow_mode", "fallback") === "full-dry-run");
check("getDefaultString fallback", mod.getDefaultString(lines, "no_such_key", "fallback") === "fallback");

// --- contract resolution for dispatched subagents -----------------------------
// The installer copies the contract to the project root as
// `pi-minimal-harness.md` and only points at it from AGENTS.md, so that file is
// the first candidate after a configured key. A project that pasted the
// contract by hand, or that still carries the old file name, must still be able
// to dispatch. A configured key that points at a deleted file is the state a
// project is left in after replacing it, and it must fall through instead of
// failing.
const contractRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-contract-"));
const contractCfg = path.join(contractRoot, "harness.config.yaml");
const BASE_LINES = ["defaults:", "  allow_dispatch: true", ""];
const WITH_STALE_KEY = [...BASE_LINES.slice(0, 1), "  subagent_context_file: pi-minimal-harness.md", ...BASE_LINES.slice(1)];
const WITH_LIVE_KEY = [...BASE_LINES.slice(0, 1), "  subagent_context_file: contracts/harness.md", ...BASE_LINES.slice(1)];
const MARKED_AGENTS = ["# Project", "", "<!-- BEGIN pi-minimal-harness -->", "## pi-minimal-harness instructions", "<!-- END pi-minimal-harness -->", ""].join("\n");
const BARE_AGENTS = ["# Project", "", "Nothing harness-specific here.", ""].join("\n");

await fs.writeFile(path.join(contractRoot, "pi-minimal-harness.md"), "contract\n", "utf8");
const onlyStandalone = mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot);
check(
  "contract: the installed pi-minimal-harness.md resolves",
  onlyStandalone.path === path.join(contractRoot, "pi-minimal-harness.md") && onlyStandalone.source === "pi-minimal-harness.md",
);
check("contract: no key configured means no stale config", onlyStandalone.staleConfig === null);

await fs.writeFile(path.join(contractRoot, "AGENTS.md"), MARKED_AGENTS, "utf8");
const both = mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot);
check(
  "contract: the contract file is preferred over the AGENTS.md that points at it",
  both.path === path.join(contractRoot, "pi-minimal-harness.md") && both.source === "pi-minimal-harness.md",
);

await fs.rm(path.join(contractRoot, "pi-minimal-harness.md"));
const pastedOnly = mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot);
check(
  "contract: an AGENTS.md carrying the harness block resolves on its own",
  pastedOnly.path === path.join(contractRoot, "AGENTS.md") && pastedOnly.source === "AGENTS.md",
);
const staleOnly = mod.resolveContractPath(WITH_STALE_KEY, contractCfg, contractRoot);
check(
  "contract: a configured key that no longer exists falls back to AGENTS.md",
  staleOnly.path === path.join(contractRoot, "AGENTS.md") &&
    staleOnly.staleConfig === path.join(contractRoot, "pi-minimal-harness.md"),
);

// The legacy file name is a last resort: it only resolves when nothing better
// does, so a project that has the block in its AGENTS.md is served by that.
await fs.writeFile(path.join(contractRoot, "AGENTS.md"), BARE_AGENTS, "utf8");
await fs.writeFile(path.join(contractRoot, "AGENTS-addition.md"), "legacy contract\n", "utf8");
const legacyOnly = mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot);
check(
  "contract: a legacy AGENTS-addition.md still resolves",
  legacyOnly.source === "AGENTS-addition.md" && legacyOnly.path === path.join(contractRoot, "AGENTS-addition.md"),
);

await fs.rm(path.join(contractRoot, "AGENTS-addition.md"));
const bareOnly = mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot);
check("contract: an AGENTS.md without the harness block is not a contract", bareOnly.path === null);
check(
  "contract: every candidate is reported when nothing resolves",
  bareOnly.candidates.length === 3 &&
    bareOnly.candidates[0].endsWith("pi-minimal-harness.md") &&
    bareOnly.candidates[1].endsWith("AGENTS.md"),
);
const staleAndBare = mod.resolveContractPath(WITH_STALE_KEY, contractCfg, contractRoot);
check("contract: a stale key with nothing else is unresolved, not fatal", staleAndBare.path === null && !!staleAndBare.staleConfig);
check(
  "contract: nothing configured and nothing present is unresolved",
  mod.resolveContractPath(BASE_LINES, contractCfg, contractRoot).path === null,
);

await fs.mkdir(path.join(contractRoot, "contracts"), { recursive: true });
await fs.writeFile(path.join(contractRoot, "contracts", "harness.md"), "contract\n", "utf8");
const liveKey = mod.resolveContractPath(WITH_LIVE_KEY, contractCfg, contractRoot);
check(
  "contract: a configured file that exists wins",
  liveKey.path === path.join(contractRoot, "contracts", "harness.md") && liveKey.source === "defaults.subagent_context_file",
);
await fs.writeFile(path.join(contractRoot, "AGENTS.md"), MARKED_AGENTS, "utf8");
check(
  "contract: the configured file is preferred over AGENTS.md",
  mod.resolveContractPath(WITH_LIVE_KEY, contractCfg, contractRoot).path === liveKey.path &&
    mod.resolveContractPath(WITH_LIVE_KEY, contractCfg, contractRoot).staleConfig === null,
);
await fs.rm(contractRoot, { recursive: true, force: true });
check(
  "findModelRef exact + bare",
  mod.findModelRef("opencode-go/gpt-5.1", { getAvailable: () => models, getAll: () => [] })?.id === "gpt-5.1" &&
    mod.findModelRef("gpt-5.1-mini", { getAvailable: () => models, getAll: () => [] })?.id === "gpt-5.1-mini",
);
check("findModelRef unknown -> undefined", mod.findModelRef("no/such-model", { getAvailable: () => models, getAll: () => [] }) === undefined);
const repositoryRunner = async (command, args) => {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: "/tmp/repo" };
  if (command === "git" && args[0] === "status") return { ok: true, stdout: " M README.md" };
  if (command === "git" && args[0] === "branch") return { ok: true, stdout: "feature\n" };
  if (command === "git" && args[1]?.includes("--abbrev-ref")) return { ok: true, stdout: "origin/feature\n" };
  if (command === "git" && args[0] === "rev-list") return { ok: true, stdout: "1 2\n" };
  if (command === "gh") return { ok: true, stdout: JSON.stringify({ state: "OPEN", number: 7, url: "https://github.com/example/repo/pull/7" }) };
  return { ok: false, stdout: "" };
};
const repositoryState = await mod.checkRepositoryState("/tmp/repo", repositoryRunner);
check(
  "repository preflight detects dirty, divergent, and open PR state",
  repositoryState.dirty && repositoryState.ahead === 1 && repositoryState.behind === 2 && repositoryState.pullRequest?.number === 7,
  JSON.stringify(repositoryState),
);
check(
  "repository preflight warning advises syncing/resolving before work",
  mod.formatRepositoryPreflight(repositoryState)?.includes("uncommitted") && mod.formatRepositoryPreflight(repositoryState)?.includes("pulling, pushing, or resolving"),
  mod.formatRepositoryPreflight(repositoryState) ?? "",
);
check(
  "supportedReasoningLevels follows model/provider metadata",
  JSON.stringify(mod.supportedReasoningLevels(models[2])) === JSON.stringify(["minimal", "low", "medium", "high", "max"]) &&
    JSON.stringify(mod.supportedReasoningLevels(models[0])) === JSON.stringify(["off"]),
  JSON.stringify(models.slice(0, 3).map(mod.supportedReasoningLevels)),
);
check(
  "setAgentReasoning preserves agent formatting",
  /^ {4}reasoning: max$/m.test(mod.setAgentReasoning(lines, "critic", "max").join("\n")),
);
check("parseHarnessDecision ANSWER_ONLY", mod.parseHarnessDecision("Direct.\n\nHARNESS-DECISION: ANSWER_ONLY") === "answer_only");
check("parseHarnessDecision PIPELINE", mod.parseHarnessDecision("HARNESS-DECISION: PIPELINE") === "pipeline");
check("parseHarnessDecision no marker -> null", mod.parseHarnessDecision("just text") === null);
check(
  "parseHarnessDecision ignores a marker quoted mid-reply",
  mod.parseHarnessDecision("If it said HARNESS-DECISION: ANSWER_ONLY I would stop.\n\nBack to work.") === null,
);
check(
  "parseHarnessDecision ignores a marker inside a code fence",
  mod.parseHarnessDecision("Example:\n\n```\nHARNESS-DECISION: PIPELINE\n```\n\nThat is the syntax.") === null,
);
check(
  "parseHarnessDecision rejects both variants on the last line",
  mod.parseHarnessDecision("HARNESS-DECISION: PIPELINE HARNESS-DECISION: ANSWER_ONLY") === null,
);
check(
  "splitDecisionLine keeps a quoted marker visible and strips only the final one",
  mod.splitDecisionLine("Use HARNESS-DECISION: PIPELINE like this:\n\nHARNESS-DECISION: PIPELINE").rest ===
    "Use HARNESS-DECISION: PIPELINE like this:",
);
check(
  "splitDecisionLine keeps prose sharing the marker's line",
  mod.splitDecisionLine("Plan ready. HARNESS-DECISION: PIPELINE").rest === "Plan ready.",
);
check("splitDecisionLine hadMarker true for an ambiguous line", mod.splitDecisionLine("HARNESS-DECISION: PIPELINE HARNESS-DECISION: ANSWER_ONLY").hadMarker === true);

// --- P0-2 / P0-4: config flags ------------------------------------------------
const strictLines = lines.map((l) => l.replace(/^ {2}strict_decision_marker:.*$/, "  strict_decision_marker: true"));
check("isStrictDecisionMarker reads the flag", mod.isStrictDecisionMarker(strictLines) === true);
check("isStrictDecisionMarker defaults to false", mod.isStrictDecisionMarker(lines.map((l) => l.replace(/^ {2}strict_decision_marker:.*$/, ""))) === false);
check(
  "preflightPolicy reads blocking and falls back to advisory",
  mod.preflightPolicy(strictLines.map((l) => l.replace(/^ {2}preflight_policy:.*$/, "  preflight_policy: blocking"))) === "blocking" &&
    mod.preflightPolicy(strictLines.map((l) => l.replace(/^ {2}preflight_policy:.*$/, "  preflight_policy: nonsense"))) === "advisory",
);
check(
  "agentMutatesFiles reads the per-agent flag and defaults to true",
  mod.agentMutatesFiles(lines, "implementer") === true &&
    mod.agentMutatesFiles(lines, "orchestrator") === false &&
    mod.agentMutatesFiles(lines, "unknown-agent") === true,
);
check(
  "formatBlockingPreflight blocks a dirty tree and an open PR only",
  mod.formatBlockingPreflight(repositoryState).length === 2 &&
    mod.formatBlockingPreflight({ ...repositoryState, dirty: false }).length === 1 &&
    mod.formatBlockingPreflight({ ...repositoryState, dirty: false, pullRequest: null }).length === 0 &&
    mod.formatBlockingPreflight({ ...repositoryState, dirty: false, ahead: 0, behind: 4, pullRequest: null }).length === 0,
  JSON.stringify(mod.formatBlockingPreflight(repositoryState)),
);
check(
  "formatBlockingPreflight is empty without git",
  mod.formatBlockingPreflight({ available: false, dirty: false, branch: null, upstream: null, ahead: 0, behind: 0, pullRequest: null }).length === 0,
);
// REQ-019: the requirements file the architect wrote is the harness's own
// output, so it does not count as a dirty tree. Any other path does.
check(
  "preflight: pathsBeyondRequirements excuses only the configured requirements file",
  mod.pathsBeyondRequirements(["REQUIREMENTS.md"], "REQUIREMENTS.md").length === 0 &&
    mod.pathsBeyondRequirements(["requirements.md"], "REQUIREMENTS.md").length === 0 &&
    mod.pathsBeyondRequirements(["./REQUIREMENTS.md"], "REQUIREMENTS.md").length === 0 &&
    mod.pathsBeyondRequirements(["docs/REQ.md"], "REQ.md").length === 0 &&
    mod.pathsBeyondRequirements(["pkg/REQUIREMENTS.md"], "REQUIREMENTS.md").length === 0,
);
check(
  "preflight: any other changed path keeps the tree dirty",
  mod.pathsBeyondRequirements(["REQUIREMENTS.md", "src/a.ts"], "REQUIREMENTS.md").length === 1 &&
    mod.pathsBeyondRequirements(["README.md"], "REQUIREMENTS.md").length === 1 &&
    mod.pathsBeyondRequirements([], "REQUIREMENTS.md").length === 0,
);
const requirementsCleanState = { ...repositoryState, dirty: false, pullRequest: null, ahead: 0, behind: 0 };
check(
  "preflight: a requirements-only tree yields no warning and no dirty blocker (REQ-019)",
  mod.formatRepositoryPreflight(requirementsCleanState) === null &&
    mod.formatBlockingPreflight(requirementsCleanState).length === 0,
);
check(
  "preflight: an open PR still blocks when only the requirements file is dirty (REQ-019)",
  mod.formatBlockingPreflight({ ...requirementsCleanState, pullRequest: repositoryState.pullRequest }).length === 1,
);
check(
  "renderPrompt placeholders",
  mod.renderPrompt("Task: {{task}} mode={{mode}} agent={{agent}} step={{step}}/{{steps}} prev={{previous}}", {
    task: "X", mode: "full", agent: "a", step: "1", steps: "5", previous: "p",
  }) === "Task: X mode=full agent=a step=1/5 prev=p",
);
check("renderPrompt appends missing {{task}}", mod.renderPrompt("No task here", { task: "T" }).endsWith("## Task\nT"));

// --- validation --------------------------------------------------------------
const checks = await mod.validate(lines, cfgPath, tmp);
const failed = checks.filter((c) => !c.ok);
check(
  "validate: 0 failures",
  failed.length === 0,
  failed.map((f) => `${f.label} [${f.detail ?? ""}]`).join("; "),
);
check(
  "validate: flags the agents that do not declare mutates_files",
  (await mod.validate(lines.map((l) => l.replace(/^ {4}mutates_files:.*$/, "")), cfgPath, tmp)).some(
    (c) => c.label.includes('"implementer" declares mutates_files') && !c.ok,
  ),
);
check(
  "validate: rejects an unknown preflight_policy",
  (await mod.validate(lines.map((l) => l.replace(/^ {2}preflight_policy:.*$/, "  preflight_policy: whatever")), cfgPath, tmp)).some(
    (c) => c.label.includes("preflight_policy is advisory or blocking") && !c.ok,
  ),
);
check(
  "validate includes workflow + template checks",
  checks.some((c) => c.label.includes('workflows has an entry for mode "full-dry-run"')) &&
    checks.some((c) => c.label.includes("prompt_template file exists")),
);
const catalogChecks = await mod.validate(lines, cfgPath, tmp, { getAvailable: () => models, getAll: () => [] });
check(
  "validate checks model and supported reasoning against catalog",
  catalogChecks.filter((c) => !c.ok).length === 0 &&
    catalogChecks.some((c) => c.label.includes('model is in Pi\'s catalog')) &&
    catalogChecks.some((c) => c.label.includes("reasoning is supported by its model")),
  catalogChecks.filter((c) => !c.ok).map((c) => c.label).join("; "),
);
const implementerStart = lines.indexOf("  implementer:");
const deliveryStart = lines.indexOf("  delivery:");
const invalidEffortLines = lines.map((line, index) =>
  index > implementerStart && index < deliveryStart && /^ {4}reasoning:/.test(line)
    ? "    reasoning: xhigh"
    : line,
);
const invalidEffortChecks = await mod.validate(invalidEffortLines, cfgPath, tmp, { getAvailable: () => models, getAll: () => [] });
check(
  "validate rejects reasoning unsupported by configured model",
  invalidEffortChecks.some((c) => c.label === 'agent "implementer" reasoning is supported by its model' && !c.ok),
);
check("validate includes the contract-file check (present)", checks.some((c) => c.label === "contract file for dispatched subagents exists" && c.ok));
await fs.rm(path.join(tmp, "pi-minimal-harness.md"));
const checksMissing = await mod.validate(lines, cfgPath, tmp);
const missingCheck = checksMissing.find((c) => c.label === "contract file for dispatched subagents exists");
check("validate: contract file missing -> fail", !!missingCheck && missingCheck.ok === false);
check(
  "validate: the failure names every candidate it tried",
  !!missingCheck && /pi-minimal-harness\.md/.test(missingCheck.detail ?? "") && /AGENTS\.md/.test(missingCheck.detail ?? ""),
);
// The reported failure mode: the key still names a file that was deleted after
// pasting, which must stay green through the AGENTS.md fallback.
const staleLines = cfgText.split(/\r?\n/);
staleLines.splice(staleLines.indexOf("defaults:") + 1, 0, "  subagent_context_file: pi-minimal-harness.md");
await fs.writeFile(path.join(tmp, "AGENTS.md"), MARKED_AGENTS, "utf8");
const staleChecks = await mod.validate(staleLines, cfgPath, tmp);
check(
  "validate: a stale subagent_context_file does not turn the contract check red",
  staleChecks.some((c) => c.label === "contract file for dispatched subagents exists" && c.ok),
);
check(
  "validate: a stale subagent_context_file is reported on its own check",
  staleChecks.some((c) => c.label === "defaults.subagent_context_file points at an existing file" && !c.ok),
);
await fs.rm(path.join(tmp, "AGENTS.md"));
await fs.copyFile(path.join(ROOT, "pi-minimal-harness.md"), path.join(tmp, "pi-minimal-harness.md"));

// --- model + effort command ---------------------------------------------------
const cfgBeforeModelCommand = await fs.readFile(cfgPath, "utf8");
let explicitSelects = 0;
const explicitCtx = makeCtx(tmp, true);
explicitCtx.ui.select = async () => {
  explicitSelects++;
  return undefined;
};
await commands["harness-model"].handler("implementer opencode-go/gpt-5.1 low", explicitCtx);
let configured = await fs.readFile(cfgPath, "utf8");
check(
  "/harness-model explicit model + effort persists both without reopening a menu",
  explicitSelects === 0 && configured.includes("    model: opencode-go/gpt-5.1\n    reasoning: low"),
  configured.slice(configured.indexOf("  implementer:"), configured.indexOf("  implementer:") + 100),
);

const loopingCtx = makeCtx(tmp, true);
const loopingTitles = [];
let loopingAgentMenus = 0;
loopingCtx.ui.select = async (title, options) => {
  loopingTitles.push(title);
  if (title === "Select agent") {
    loopingAgentMenus++;
    if (loopingAgentMenus === 1) return options.find((option) => option.startsWith("implementer "));
    if (loopingAgentMenus === 2) return options.find((option) => option.startsWith("explorer "));
    return "Cancel";
  }
  if (title.includes('Model for "implementer"')) {
    return options.find((option) => option.startsWith("opencode-go/gpt-5.1"));
  }
  if (title.includes('Reasoning effort for "opencode-go/gpt-5.1"')) return "high";
  if (title.includes('Model for "explorer"')) {
    return options.find((option) => option.startsWith("opencode-go/deepseek-v4.1-flash"));
  }
  return undefined;
};
await commands["harness-model"].handler("", loopingCtx);
configured = await fs.readFile(cfgPath, "utf8");
check(
  "/harness-model returns to agent menu after every saved change",
  loopingAgentMenus === 3 && configured.includes("    model: opencode-go/gpt-5.1\n    reasoning: high") &&
    configured.includes("    model: opencode-go/deepseek-v4.1-flash\n    reasoning: off"),
  loopingTitles.join(" -> "),
);

const beforeMenuCancel = await fs.readFile(cfgPath, "utf8");
const menuCancelCtx = makeCtx(tmp, true);
let menuCancelSelects = 0;
menuCancelCtx.ui.select = async (title, options) => {
  menuCancelSelects++;
  return title === "Select agent" && options.includes("Cancel") ? "Cancel" : undefined;
};
await commands["harness-model"].handler("", menuCancelCtx);
check(
  "/harness-model Cancel closes the agent menu",
  menuCancelSelects === 1 && (await fs.readFile(cfgPath, "utf8")) === beforeMenuCancel,
);

const configMenuCtx = makeCtx(tmp, true);
const configMenuTitles = [];
configMenuCtx.ui.select = async (title, options) => {
  configMenuTitles.push(title);
  if (title === "Corpustory harness configuration") return "3. Change an agent model and effort";
  if (title === "Select agent" && options.includes("Cancel")) return "Cancel";
  return undefined;
};
await commands["harness-config"].handler("", configMenuCtx);
check(
  "/harness-config model option reuses the looping agent menu",
  JSON.stringify(configMenuTitles) === JSON.stringify(["Corpustory harness configuration", "Select agent"]),
  configMenuTitles.join(" -> "),
);

const interactiveCtx = makeCtx(tmp, true);
const selectionTitles = [];
interactiveCtx.ui.select = async (title, options) => {
  selectionTitles.push(title);
  if (selectionTitles.length === 1) return options.find((option) => option.startsWith("opencode-go/gpt-5.1"));
  return options.find((option) => option === "high" || option === "high (current)");
};
await commands["harness-model"].handler("implementer", interactiveCtx);
configured = await fs.readFile(cfgPath, "utf8");
check(
  "/harness-model menu asks for model then supported effort",
  selectionTitles.length === 2 && /Reasoning effort for "opencode-go\/gpt-5.1"/.test(selectionTitles[1]) &&
    configured.includes("    model: opencode-go/gpt-5.1\n    reasoning: high"),
  selectionTitles.join(" -> "),
);

await commands["harness-model"].handler("explorer opencode-go/deepseek-v4.1-flash", makeCtx(tmp, true));
configured = await fs.readFile(cfgPath, "utf8");
check(
  "/harness-model non-reasoning model stores off without a second picker",
  configured.includes("    model: opencode-go/deepseek-v4.1-flash\n    reasoning: off"),
);

const beforeCancelledEffort = await fs.readFile(cfgPath, "utf8");
const cancelledCtx = makeCtx(tmp, true);
let cancelledSelects = 0;
cancelledCtx.ui.select = async (_title, options) => {
  cancelledSelects++;
  return cancelledSelects === 1 ? options.find((option) => option.startsWith("opencode-go/gpt-5.1")) : undefined;
};
await commands["harness-model"].handler("implementer", cancelledCtx);
check(
  "/harness-model effort cancellation leaves config unchanged",
  cancelledSelects === 2 && (await fs.readFile(cfgPath, "utf8")) === beforeCancelledEffort,
);

const beforeInvalidEffort = await fs.readFile(cfgPath, "utf8");
await commands["harness-model"].handler("explorer opencode-go/deepseek-v4.1-flash high", makeCtx(tmp, true));
check(
  "/harness-model rejects unsupported effort atomically",
  (await fs.readFile(cfgPath, "utf8")) === beforeInvalidEffort && notifies.at(-1)?.includes("not supported"),
  notifies.at(-1) ?? "",
);
await fs.writeFile(cfgPath, cfgBeforeModelCommand);

// --- on-demand delivery command ------------------------------------------------
const cfgBeforeDelivery = await fs.readFile(cfgPath, "utf8");
reset();
const deliveryCommandCtx = makeCtx(tmp, true);
deliveryCommandCtx.waitForIdle = async () => new Promise((r) => setTimeout(r, 100));
await commands["harness-delivery"].handler("deliver the pending docs", deliveryCommandCtx);
await new Promise((r) => setTimeout(r, 150));
check(
  "/harness-delivery runs only delivery without changing workflow mode",
  sent.length === 1 && sent[0]?.includes("prompts/delivery.md") && !sent[0]?.includes("prompts/orchestrator.md") &&
    (await fs.readFile(cfgPath, "utf8")) === cfgBeforeDelivery,
  `sent=${sent.length}; mode=${(await fs.readFile(cfgPath, "utf8")).match(/^ {2}workflow_mode: .*$/m)?.[0] ?? "missing"}`,
);
reset();

// --- pipeline (explicit command path) ---------------------------------------
await mod.runPipeline(fakePi, makeCtx(tmp, true), "add a dark mode toggle", waitTurn);

check("pipeline: 3 prompts sent", sent.length === 3, `got ${sent.length}`);
check(
  "pipeline: step1 pointer names template, body hidden",
  sent[0]?.includes("prompts/orchestrator.md") &&
    sent[0]?.includes("add a dark mode toggle") &&
    !sent[0]?.includes("# Orchestrator"),
  String(sent[0]).slice(0, 90),
);
check(
  "pipeline: step2 pointer names template, body hidden",
  sent[1]?.includes("prompts/explorer.md") &&
    sent[1]?.includes("add a dark mode toggle") &&
    !sent[1]?.includes("# Explorer"),
  String(sent[1]).slice(0, 90),
);

const implMatch = /^ {4}model:\s*(\S+)/m.exec(cfgText.slice(cfgText.indexOf("  explorer:")));
const implModel = implMatch ? mod.findModelRef(implMatch[1], { getAvailable: () => models, getAll: () => [] }) : undefined;
const expectedImpl = implModel ? `${implModel.provider}/${implModel.id}` : null;
check(
  "pipeline: implementer model switched (or warned when unknown)",
  expectedImpl ? setModelCalls.includes(expectedImpl) : notifies.some((n) => n.startsWith("[warning]") && n.includes("not in catalog")),
  JSON.stringify(setModelCalls),
);
check("pipeline: original model restored", setModelCalls.at(-1) === "orig-p/orig", JSON.stringify(setModelCalls));
check(
  "pipeline: configured effort set per step",
  thinkingCalls.includes("medium") && thinkingCalls.includes("high"),
  JSON.stringify(thinkingCalls),
);
check("pipeline: thinking restored to original", thinkingCalls.at(-1) === "high", JSON.stringify(thinkingCalls));
check(
  "pipeline: step1 shows no invented total, step2 shows 2/3",
  statuses.includes("harness: full-dry-run · orchestrator · auto: on") &&
    statuses.includes("harness: full-dry-run · 2/3 explorer · decision: pipeline · auto: on"),
  statuses.join(" | "),
);
check("pipeline: footer ends at mode + decision + auto", statuses.at(-1) === "harness: full-dry-run · decision: pipeline · auto: on", String(statuses.at(-1)));
check(
  "pipeline: finished info (report present, no repair)",
  notifies.some((n) => n.includes('Pipeline "full-dry-run" finished: orchestrator -> explorer -> critic')),
  notifies.join(" | "),
);

reset();
const implementerReasoningBlock = /(^  explorer:\n    model: )opencode-go\/gpt-5\.1(\n    reasoning: )high/m;
const cfgUnsupportedEffort = cfgText.replace(
  implementerReasoningBlock,
  "$1opencode-go/deepseek-v4.1-flash$2high",
);
await fs.writeFile(cfgPath, cfgUnsupportedEffort);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "unsupported effort", waitTurn);
check(
  "pipeline: unsupported model effort warns and is not applied",
  JSON.stringify(thinkingCalls) === JSON.stringify(["medium", "medium", "high"]) &&
    notifies.some((n) => n.includes('effort "high" is not supported') && n.includes("available: off")),
  JSON.stringify({ thinkingCalls, notifies }),
);
const cfgOffEffort = cfgText.replace(
  implementerReasoningBlock,
  "$1opencode-go/deepseek-v4.1-flash$2off",
);
await fs.writeFile(cfgPath, cfgOffEffort);
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "off effort", waitTurn);
check(
  "pipeline: off effort still restores original thinking level",
  JSON.stringify(thinkingCalls) === JSON.stringify(["medium", "medium", "high"]),
  JSON.stringify(thinkingCalls),
);
await fs.writeFile(cfgPath, cfgText);

// --- footer refresh: session_start + /harness-auto toggle --------------------
await events["session_start"]({}, makeCtx(tmp, false));
check("session_start: footer shows mode + auto", statuses.at(-1) === "harness: full-dry-run · auto: on", String(statuses.at(-1)));
check("session_start: decision segment cleared", !String(statuses.at(-1)).includes("decision:"));

await commands["harness-auto"].handler("off", makeCtx(tmp, true));
check("/harness-auto off: footer refreshed", statuses.at(-1) === "harness: full-dry-run · auto: off", String(statuses.at(-1)));
await commands["harness-auto"].handler("on", makeCtx(tmp, true));
check("/harness-auto on: footer refreshed", statuses.at(-1) === "harness: full-dry-run · auto: on", String(statuses.at(-1)));

// --- routing to the architect: state path (message_end strips the marker) -----
reset();
assistantTextOverride = "This needs design.\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿cómo funciona el harness?", waitTurn);
check("routing: ANSWER_ONLY hands the turn to the architect", sent.length === 2, `got ${sent.length}`);
check("routing: step2 is the architect", sent[1]?.includes("prompts/architecture.md"), String(sent[1]).slice(0, 80));
check(
  "routing: it does not fall through to the explorer's steps",
  !sent[1]?.includes("prompts/explorer.md") && !sent[1]?.includes("prompts/critic.md"),
  String(sent[1]).slice(0, 80),
);
check("routing: announces the mode it switched to", notifies.some((n) => n.includes('Routed to "analysis"')), notifies.join(" | "));
check("routing: no stopped-pipeline warning", !notifies.some((n) => n.startsWith("[warning]") && n.includes("stopped")), notifies.join(" | "));

const lastAssistant = [...branchArr].reverse().find((e) => e.type === "message" && e.message.role === "assistant");
check("decision stripped from the visible reply", !JSON.stringify(lastAssistant).includes("HARNESS-DECISION"));
check("footer shows the recorded decision", statuses.some((s) => String(s).includes("decision: answer_only")), statuses.slice(-3).join(" | "));
check(
  "routed run shows the architect as the last step",
  statuses.includes("harness: full-dry-run · 2/2 architect · decision: answer_only · auto: on"),
  statuses.join(" | "),
);
// REQ-010: that architect turn left a design session open and only the user can
// close it. Close it here so the PIPELINE run below measures a closed session,
// which is the state a fresh task starts in.
await commands["harness-end"].handler("", makeCtx(tmp, true));

reset();
assistantTextOverride = "Plan.\n\nHARNESS-DONE\n\nHARNESS-DECISION: PIPELINE";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "implementa la feature", waitTurn);
check("routing: PIPELINE runs the configured steps", sent.length === 3, `got ${sent.length}`);
check(
  "pipeline run shows 1/3 orchestrator once decided",
  statuses.includes("harness: full-dry-run · 1/3 orchestrator · decision: pipeline · auto: on"),
  statuses.join(" | "),
);

// routing off -> ANSWER_ONLY ends the pipeline after the orchestrator
const cfgTextShort = await fs.readFile(cfgPath, "utf8");
await fs.writeFile(cfgPath, cfgTextShort.replace("  analysis_routing: true", "  analysis_routing: false"));
reset();
assistantTextOverride = "Direct answer.\n\nHARNESS-DONE\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿otra pregunta?", waitTurn);
check("routing: disabled key ends the pipeline after the orchestrator", sent.length === 1, `got ${sent.length}`);
check(
  "routing: disabled reports the direct answer",
  notifies.some((n) => n.includes("orchestrator answered directly")),
  notifies.join(" | "),
);
await fs.writeFile(cfgPath, cfgTextShort);
assistantTextOverride = null;

// --- routing: text fallback (no message_end handler) -------------------------
const savedMessageEnd = events["message_end"];
delete events["message_end"];
reset();
assistantTextOverride = "Needs design.\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿fallback?", waitTurn);
check("routing: text fallback routes without message_end", sent.length === 2 && sent[1]?.includes("prompts/architecture.md"), `got ${sent.length}`);
events["message_end"] = savedMessageEnd;
assistantTextOverride = null;

// --- final-report guarantee (fallo 1) ---------------------------------------
// Case 1: final step carries HARNESS-DONE -> no repair turn.
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task one", waitTurn);
check("report: marker present -> no repair turn", sent.length === 3, `got ${sent.length}`);
check("report: finished as info", notifies.some((n) => n.startsWith("[info]") && n.includes("finished:")), notifies.join(" | "));

// Case 2: final step omits it -> exactly one repair turn, then compliance.
reset();
assistantScript.push("orchestrator output\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("explorer output sin marca");
assistantScript.push("### Changes\n- none\n\n### Evidence\n- test\n\n### Notes for delivery\n- none\n\nHARNESS-DONE");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task two", waitTurn);
check("report: missing marker -> exactly one repair turn", sent.length === 4, `got ${sent.length}`);
check("report: repair prompt demands HARNESS-DONE", sent[2]?.includes("HARNESS-DONE"), String(sent[2]).slice(0, 60));
check(
  "report: repaired -> finish info, no missing-report warning",
  notifies.some((n) => n.startsWith("[info]") && n.includes("finished:")) && !notifies.some((n) => n.includes("final report is missing")),
  notifies.join(" | "),
);

// Case 3: the LAST step repairs and still omits it -> warning, one repair turn.
// The failing step has to be the last one, or the pipeline stops early and
// never reaches the completion warning this case is about.
reset();
assistantScript.push("orchestrator output\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("explorer output\n\nHARNESS-DONE");
assistantScript.push("critic sin marca");
assistantScript.push("reparación sin marca");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task three", waitTurn);
check("report: repair fails -> warning", notifies.some((n) => n.startsWith("[warning]") && n.includes("report is missing")), notifies.join(" | "));
check("report: still only one repair turn", sent.length === 4, `got ${sent.length}`);
check(
  "report: repair failure names the step and stops the pipeline",
  notifies.some((n) => n.includes("did not report") && n.includes("critic")),
  notifies.join(" | "),
);

// Decision segment clears again on session_start.
statuses.length = 0;
await events["session_start"]({}, makeCtx(tmp, false));
check("session_start after run: footer has no decision", statuses.at(-1) === "harness: full-dry-run · auto: on", String(statuses.at(-1)));

// --- dispatch seams ----------------------------------------------------------
const argvFull = mod.buildDispatchArgs({ systemPromptPath: "/tmp/s.md", model: "p/m", thinking: "high", brief: "do it" });
check(
  "buildDispatchArgs full argv",
  JSON.stringify(argvFull) ===
    JSON.stringify(["--mode", "json", "-p", "--no-session", "--append-system-prompt", "/tmp/s.md", "--model", "p/m", "--thinking", "high", "do it"]),
  argvFull.join(" "),
);
const argvMin = mod.buildDispatchArgs({ brief: "q?" });
check(
  "buildDispatchArgs minimal (brief last, no model)",
  argvMin.length === 5 && argvMin.at(-1) === "q?" && !argvMin.includes("--model") && !argvMin.includes("--append-system-prompt"),
  argvMin.join(" "),
);
const argvOff = mod.buildDispatchArgs({ model: "p/no-reasoning", thinking: "off", brief: "q?" });
check(
  "buildDispatchArgs accepts off for non-reasoning models",
  JSON.stringify(argvOff) === JSON.stringify(["--mode", "json", "-p", "--no-session", "--model", "p/no-reasoning", "--thinking", "off", "q?"]),
  argvOff.join(" "),
);

const makeSpawn = ({ text, code, stderrText, stopReason }) => () => ({
  stdout: {
    on: (ev, cb) => {
      if (ev === "data")
        setTimeout(
          () =>
            cb(
              Buffer.from(
                JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    stopReason: stopReason ?? "end",
                    content: [{ type: "text", text }],
                  },
                }) + "\n",
              ),
            ),
          5,
        );
    },
  },
  stderr: {
    on: (ev, cb) => {
      if (ev === "data" && stderrText) setTimeout(() => cb(Buffer.from(stderrText)), 5);
    },
  },
  on: (ev, cb) => {
    if (ev === "close") setTimeout(() => cb(code ?? 0), 12);
  },
  kill: () => {},
});

const rOk = await mod.runDispatchTask({ cwd: tmp, agent: "explorer", args: ["--mode", "json"], spawnFn: makeSpawn({ text: "found: src/app.ts" }) });
check("runDispatchTask collects final text", rOk.ok === true && rOk.text.includes("found: src/app.ts"), JSON.stringify(rOk));

const rFail = await mod.runDispatchTask({ cwd: tmp, agent: "critic", args: [], spawnFn: makeSpawn({ text: "", code: 1, stderrText: "boom" }) });
check("runDispatchTask reports failure (exit + stderr)", rFail.ok === false && rFail.exitCode === 1 && (rFail.stderr ?? "").includes("boom"), JSON.stringify(rFail));

const rBig = await mod.runDispatchTask({ cwd: tmp, agent: "explorer", args: [], spawnFn: makeSpawn({ text: "x".repeat(60 * 1024) }) });
check("runDispatchTask truncates output >50KB", rBig.truncated === true && rBig.text.includes("[Output truncated"), `len=${rBig.text.length}`);

// Dispatch tool gates (never spawn for real in tests).
// A failure must REJECT: the runtime only marks a thrown tool call as an error,
// so asserting an `isError` field on a returned result would test a fiction the
// fake happens to allow and real Pi silently ignores.
const tool = tools["harness-dispatch"];
const rejected = async (args, ctx) =>
  tool.execute("t", args, undefined, undefined, ctx ?? makeCtx(tmp, false)).then(
    (value) => ({ rejected: false, text: JSON.stringify(value) }),
    (error) => ({ rejected: true, text: String(error?.message ?? error) }),
  );

const cfgOriginal = await fs.readFile(cfgPath, "utf8");
await fs.writeFile(cfgPath, cfgOriginal.replace("  allow_dispatch: true", "  allow_dispatch: false"));
const rDisabled = await rejected({ tasks: [{ agent: "explorer", brief: "x" }] });
check("dispatch: disabled gate rejects", rDisabled.rejected && rDisabled.text.includes("disabled"), rDisabled.text);
await fs.writeFile(cfgPath, cfgOriginal);

const rUnknown = await rejected({ tasks: [{ agent: "nope", brief: "x" }] });
check("dispatch: unknown agent rejects", rUnknown.rejected && rUnknown.text.includes("Unknown agent"), rUnknown.text);

const rEmpty = await rejected({ tasks: [{ agent: "explorer", brief: "   " }] });
check("dispatch: empty brief rejects", rEmpty.rejected && rEmpty.text.toLowerCase().includes("empty brief"), rEmpty.text);

const rNoTasks = await rejected({ tasks: [] });
check("dispatch: empty task list rejects", rNoTasks.rejected && rNoTasks.text.includes("between 1 and"), rNoTasks.text);

// REQ-004: independence is computed from the declared file sets, so a declared
// overlap must be refused before anything is spawned — and a task that declares
// no files must not be punished for a field it was never required to send.
check(
  "dispatch: a declared file overlap is refused, naming the shared path",
  mod.dispatchOverlap([
    { agent: "explorer", files: ["src/a.ts", "src/shared.ts"] },
    { agent: "critic", files: ["src/b.ts", "src/shared.ts"] },
  ])?.includes("src/shared.ts"),
  String(mod.dispatchOverlap([{ agent: "explorer", files: ["src/shared.ts"] }, { agent: "critic", files: ["src/shared.ts"] }])),
);
check(
  "dispatch: disjoint file sets are allowed",
  mod.dispatchOverlap([{ agent: "explorer", files: ["src/a.ts"] }, { agent: "critic", files: ["src/b.ts"] }]) === null,
);
check(
  "dispatch: a task that declares no files is never treated as overlapping",
  mod.dispatchOverlap([{ agent: "explorer" }, { agent: "critic", files: ["src/a.ts"] }]) === null &&
    mod.dispatchOverlap([{ agent: "explorer" }, { agent: "critic" }]) === null,
);
const rOverlap = await rejected({
  tasks: [
    { agent: "explorer", brief: "a", files: ["src/shared.ts"] },
    { agent: "critic", brief: "b", files: ["src/shared.ts"] },
  ],
});
check("dispatch: the tool refuses the overlap before spawning", rOverlap.rejected && rOverlap.text.includes("src/shared.ts"), rOverlap.text);

// REQ-002: only "claimed passed and did not pass" stops delivery.
const runReturns = (actual) => async () => actual;
check(
  "check gate: a check claimed passed that does not pass is contradicted",
  (await mod.verifyDeclaredChecks([{ command: "node t.mjs", result: "passed" }], tmp, 1000, runReturns("failed")))[0].contradicted === true,
);
check(
  "check gate: a check claimed failed that passes is not contradicted — good news, not a block",
  (await mod.verifyDeclaredChecks([{ command: "node t.mjs", result: "failed" }], tmp, 1000, runReturns("passed")))[0].contradicted === false,
);
check(
  "check gate: a check claimed passed that could not be run is not contradicted either",
  (await mod.verifyDeclaredChecks([{ command: "node t.mjs", result: "passed" }], tmp, 1000, runReturns("skipped")))[0].contradicted === true,
  "skipped is not a pass: the implementer claimed it passed and it did not run",
);

// The shapes that matter here cannot be produced by a fake — that is why the
// classification lived inline and stayed untested. Every branch, covered here.
check("check failure: a timeout is skipped, not failed", mod.classifyCheckFailure({ killed: true, code: null }) === "skipped");
check("check failure: a POSIX missing command (127) is skipped", mod.classifyCheckFailure({ code: 127 }) === "skipped");
check("check failure: a bare ENOENT/EACCES is still skipped", mod.classifyCheckFailure({ code: "ENOENT" }) === "skipped" && mod.classifyCheckFailure({ code: "EACCES" }) === "skipped");
check("check failure: a real non-zero exit is failed", mod.classifyCheckFailure({ code: 3 }) === "failed");
check(
  // The deliberate asymmetry: exit 1 through cmd.exe could be a missing command
  // or a genuine failure, and guessing 'skipped' would let broken work through.
  "check failure: exit 1 stays failed, because skipped on a real failure would ship it as verified",
  mod.classifyCheckFailure({ code: 1 }) === "failed",
);
// One real spawn, so the execFile plumbing itself is proven and not only the
// classifier: the rest are covered above without paying for a process each.
const nodeExec = `"${process.execPath}"`;
check(
  "check run: a command that exits 0 is really run and really passes",
  (await mod.runDeclaredCheck(`${nodeExec} -e "process.exit(0)"`, tmp, 30000)) === "passed",
);
check(
  "check run: a command that exits 3 really fails",
  (await mod.runDeclaredCheck(`${nodeExec} -e "process.exit(3)"`, tmp, 30000)) === "failed",
);

// REQ-003: the discrepancy is a pure function of two path lists, so it can be
// tested without a git repository at all.
check(
  "plan diff: a path changed outside the plan is reported",
  mod.describePlanDiscrepancy(["src/a.ts"], ["src/a.ts", "src/b.ts"])?.includes("src/b.ts"),
);
check(
  "plan diff: a planned path never touched is reported",
  mod.describePlanDiscrepancy(["src/a.ts", "src/b.ts"], ["src/a.ts"])?.includes("src/b.ts"),
);
check(
  "plan diff: matching lists produce no discrepancy",
  mod.describePlanDiscrepancy(["src/a.ts"], ["src/a.ts"]) === null,
);
check(
  "plan diff: no expectation means nothing to compare",
  mod.describePlanDiscrepancy([], ["src/a.ts"]) === null,
);
check(
  "plan diff: line refs, quotes and case do not create a false mismatch",
  mod.describePlanDiscrepancy(["`src/a.ts:12`"], ["SRC/A.TS"]) === null,
  String(mod.describePlanDiscrepancy(["`src/a.ts:12`"], ["SRC/A.TS"])),
);
// Matching is normalised, but the message must name the string the step
// actually declared: `requirements.md` does not exist on a case-sensitive
// filesystem, and the reviewer would go looking for it.
const casedMessage = mod.describePlanDiscrepancy(["REQUIREMENTS.md"], ["harness.config.yaml"]) ?? "";
check(
  "plan diff: the message names the declared path, not the normalised one",
  casedMessage.includes("REQUIREMENTS.md") && !casedMessage.includes("requirements.md"),
  casedMessage,
);

// REQ-003 was blind to untracked files, because `git diff` cannot see a file
// the implementation created. Both failure directions at once: a new planned
// file read as "never touched", and a new unplanned file never flagged at all.
const fakeRunner = (trackedOut, untrackedOut) => async (command, args) => {
  const isUntracked = args[0] === "ls-files";
  return { ok: true, stdout: isUntracked ? untrackedOut : trackedOut };
};
check(
  "changed paths: untracked files are included, not just tracked ones",
  JSON.stringify(
    await mod.collectChangedPaths(
      tmp,
      fakeRunner("harness.config.yaml\n", "REQUIREMENTS.md\n"),
    ),
  ) === JSON.stringify(["harness.config.yaml", "REQUIREMENTS.md"]),
  JSON.stringify(
    await mod.collectChangedPaths(tmp, fakeRunner("harness.config.yaml\n", "REQUIREMENTS.md\n")),
  ),
);
check(
  "changed paths: windows separators are normalised and duplicates collapse",
  JSON.stringify(
    await mod.collectChangedPaths(tmp, fakeRunner("src\\a.ts\nsrc\\a.ts\n", "")),
  ) === JSON.stringify(["src/a.ts"]),
  JSON.stringify(await mod.collectChangedPaths(tmp, fakeRunner("src\\a.ts\nsrc\\a.ts\n", ""))),
);
check(
  "plan diff: a planned file that exists but is untracked is not a false positive",
  mod.describePlanDiscrepancy(["REQUIREMENTS.md"], ["REQUIREMENTS.md"]) === null,
  String(mod.describePlanDiscrepancy(["REQUIREMENTS.md"], ["REQUIREMENTS.md"])),
);
check(
  "plan diff: a new unplanned file IS flagged — the scope creep the check exists for",
  (mod.describePlanDiscrepancy(["harness.config.yaml"], ["harness.config.yaml", "src/new.ts"]) ?? "").includes(
    "src/new.ts",
  ),
);

// Anchored on the agent block: a plain first-match replace would land on
// whichever agent declares `high` first, not the one being dispatched.
const cfgUnsupported = cfgOriginal.replace(
  /(^  explorer:\n    model: )opencode-go\/gpt-5\.1(\n    reasoning: )high/m,
  "$1opencode-go/deepseek-v4.1-flash$2high",
);
await fs.writeFile(cfgPath, cfgUnsupported);
const rUnsupported = await rejected({ tasks: [{ agent: "explorer", brief: "x" }] });
check(
  "dispatch: unsupported model effort rejects",
  rUnsupported.rejected && rUnsupported.text.includes("not supported") && rUnsupported.text.includes("Available: off"),
  rUnsupported.text,
);
await fs.writeFile(cfgPath, cfgOriginal);

const noUiCtx = makeCtx(tmp, false);
noUiCtx.hasUI = false;
const rNoUi = await rejected({ tasks: [{ agent: "nope", brief: "x" }] }, noUiCtx);
check("dispatch: rejects with hasUI false", rNoUi.rejected);
check("dispatch: no widget written by gate failures", widgets.length === 0, `widgets=${widgets.length}`);

// The success/failure split is pure text, so it is tested directly: covering it
// through the tool would spawn a real `pi` subprocess, which this suite never
// does (the gate tests above all return before any spawn).
check(
  "dispatch: partial batch reports a resolved outcome",
  mod.formatDispatchOutcome(2, 1, ["### [explorer] ok", "### [critic] failed"]).startsWith("1/2 dispatched agents ok"),
  mod.formatDispatchOutcome(2, 1, []),
);
check(
  "dispatch: total failure reports 0 ok and keeps every per-agent summary",
  mod.formatDispatchOutcome(2, 2, ["### [explorer] failed", "### [critic] failed"]).includes("0/2 dispatched agents ok") &&
    mod.formatDispatchOutcome(2, 2, ["### [explorer] failed", "### [critic] failed"]).includes("### [critic] failed"),
  mod.formatDispatchOutcome(2, 2, ["### [explorer] failed"]),
);

// --- auto-harness input hook -------------------------------------------------
notifies.length = 0;
sent.length = 0;
setModelCalls.length = 0;
assistantScript.length = 0;
assistantTextOverride = null;
// The detached pipeline starts a fresh turn count: its first reply is the
// orchestrator and must declare a decision.
assistantTurns = 0;

const passthrough = await events["input"]({ text: "/harness-mode full", source: "interactive" }, makeCtx(tmp, false));
check("input: slash command passes through", passthrough.action === "continue");

const steering = await events["input"]({ text: "now tweak it", source: "interactive", streamingBehavior: "steer" }, makeCtx(tmp, false));
check("input: steering passes through", steering.action === "continue");

const started = await events["input"]({ text: "create onboarding scene templates", source: "interactive" }, makeCtx(tmp, false));
check("input: plain request handled", started.action === "handled");

await new Promise((r) => setTimeout(r, 3500));
check("input: pipeline ran detached (3 prompts)", sent.length === 3, `got ${sent.length}`);
check("input: task reached orchestrator", sent[0]?.includes("create onboarding scene templates"));

// auto OFF -> passthrough
await fs.writeFile(cfgPath, mod.setAutoHarness((await fs.readFile(cfgPath, "utf8")).split(/\r?\n/), false).join("\n"));
sent.length = 0;
const off = await events["input"]({ text: "just chat", source: "interactive" }, makeCtx(tmp, false));
check("input: auto off passes through", off.action === "continue" && sent.length === 0);

// --- P0-2 / P0-3 / P0-4: driver behaviour -------------------------------------
const forceFlags = (text, flags) =>
  Object.entries(flags).reduce((acc, [key, value]) => acc.replace(new RegExp(`^ {2}${key}: .*$`, "m"), `  ${key}: ${value}`), text);
const baseCfg = await fs.readFile(cfgPath, "utf8");

// P0-2: with the strict default, a reply without a usable marker stops the
// pipeline instead of being read as "PIPELINE".
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
reset();
assistantTextOverride = "A plan that forgot its decision marker.";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: missing decision marker stops the pipeline", sent.length === 1, `got ${sent.length}`);
check(
  "strict: missing marker is reported as an error",
  notifies.some((n) => n.startsWith("[error]") && n.includes("declared no decision")),
  notifies.join(" | "),
);

reset();
assistantTextOverride = "Both at once: HARNESS-DECISION: PIPELINE HARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: ambiguous decision stops the pipeline", sent.length === 1, `got ${sent.length}`);

reset();
// The marker is quoted but NOT on the last line, which is the only place a
// marker counts. Written on one line it would decide, quote or not.
assistantTextOverride = 'If it had written "HARNESS-DECISION: ANSWER_ONLY" I would stop.\nBut the last line is prose.';
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: a quoted marker off the last line does not decide", sent.length === 1, `got ${sent.length}`);

await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: false }));
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: disabled keeps the previous fail-open behaviour", sent.length === 3, `got ${sent.length}`);

// P0-3: an intermediate step owes its report too.
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("explorer sin informe");
assistantScript.push("el explorador sigue sin informe");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea", waitTurn, "full-dry-run");
check("report: an intermediate step is verified", sent.length === 3, `got ${sent.length}`);
check("report: the repair prompt names the step", sent[2]?.includes('"explorer"'), String(sent[2]).slice(0, 90));
// The repair turn must quote the sections the *step's own* prompt requires:
// an explorer owes `### Findings`, not the implementer's `### Changes`.
check(
  "report: the repair prompt names the step's own sections, not the implementer's",
  sent[2]?.includes("### Findings") && !sent[2]?.includes("### Evidence"),
  String(sent[2]).slice(0, 160),
);
check(
  "report: the pipeline stops when a step still omits the marker",
  notifies.some((n) => n.includes("did not report") && n.includes("explorer")),
  notifies.join(" | "),
);
check(
  "report: later steps never run after an unverified step",
  !sent.some((s) => s.includes("critic")),
  sent.map((s) => s.slice(0, 40)).join(" | "),
);

// P0-4: a real repository, with a dirty tree, in front of the file-mutating step.
const { execFileSync } = await import("node:child_process");
const gateRepo = path.join(tmp, "gate-repo");
let gateReady = false;
try {
  execFileSync("git", ["init", "-q", gateRepo], { stdio: "ignore" });
  await fs.writeFile(path.join(gateRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "blocking", workflow_mode: "full" }));
  await fs.cp(path.join(ROOT, "prompts"), path.join(gateRepo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(gateRepo, "uncommitted.txt"), "work in progress\n");
  gateReady = true;
} catch {
  gateReady = false;
}

if (gateReady) {
  // `full`, not the default mode: the blocking gate only guards a step that
  // declares `mutates_files`, and no step in the other modes does.
  reset();
  // Every step before the gate has to report, or the pipeline stops on the
  // report guarantee long before it reaches the mutating step the gate guards.
  assistantScript.push(
    "Plan.\n\nHARNESS-DONE\n\nHARNESS-DECISION: PIPELINE",
    "Explored.\n\nHARNESS-DONE",
    "Reviewed.\n\nHARNESS-DONE",
  );
  const noUiGate = makeCtx(gateRepo, true);
  noUiGate.hasUI = false;
  await mod.runPipeline(fakePi, noUiGate, "tarea", waitTurn);
  check("preflight: blocking stops the file-mutating step", sent.length === 3, `got ${sent.length}`);
  check(
    "preflight: without a TUI the block is an error, never a silent pass",
    notifies.some((n) => n.startsWith("[error]") && n.includes('Pipeline blocked before "implementer"')),
    notifies.join(" | "),
  );

  reset();
  const allowGate = makeCtx(gateRepo, true);
  let confirms = 0;
  allowGate.ui.confirm = async () => {
    confirms++;
    return true;
  };
  await mod.runPipeline(fakePi, allowGate, "tarea", waitTurn, "full");
  check(
    "preflight: the operator override runs the mutating steps, asking once",
    confirms === 1 && sent.length === 6,
    `confirms=${confirms} prompts=${sent.length}`,
  );

  await fs.writeFile(path.join(gateRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "advisory", workflow_mode: "full" }));
  reset();
  const advisoryGate = makeCtx(gateRepo, true);
  advisoryGate.ui.confirm = async () => {
    confirms++;
    return false;
  };
  await mod.runPipeline(fakePi, advisoryGate, "tarea", waitTurn);
  check(
    "preflight: advisory only warns and never asks",
    sent.length === 6 && confirms === 1 && notifies.some((n) => n.includes("uncommitted changes")),
    `prompts=${sent.length} confirms=${confirms} ${notifies.join(" | ")}`,
  );

  // A dirty tree is the normal state while a design is open, and each turn of a
  // design session is its own pipeline: gating the architect would ask on every
  // message of a conversation.
  await fs.writeFile(path.join(gateRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "blocking", workflow_mode: "analysis" }));
  reset();
  assistantScript.push("Needs design.\n\nHARNESS-DECISION: ANSWER_ONLY", "Here is the proposal.");
  let architectConfirms = 0;
  const architectGate = makeCtx(gateRepo, true);
  architectGate.ui.confirm = async () => {
    architectConfirms++;
    return true;
  };
  await mod.runPipeline(fakePi, architectGate, "idea", waitTurn);
  check(
    "preflight: the architect is exempt from the blocking gate",
    architectConfirms === 0 && sent.length === 2 && sent[1]?.includes("prompts/architecture.md"),
    `confirms=${architectConfirms} prompts=${sent.length}`,
  );
} else {
  console.log("SKIP preflight gate tests: git is unavailable in this environment");
}

// REQ-019 wiring, not only the pieces: the helper and the formatters are tested
// above in isolation, this drives `runPipeline` against a real repository to
// prove the driver recomputes `dirty` from them. A tree whose only changed path
// is the configured requirements file must raise no preflight at all.
const reqRepo = path.join(tmp, "req-repo");
let reqReady = false;
try {
  execFileSync("git", ["init", "-q", reqRepo], { stdio: "ignore" });
  await fs.writeFile(path.join(reqRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "advisory", workflow_mode: "full-dry-run" }));
  await fs.cp(path.join(ROOT, "prompts"), path.join(reqRepo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(reqRepo, "REQUIREMENTS.md"), "# Requirements\n\ncommitted\n");
  // Commit the config and prompts too: an untracked one would itself be a
  // changed path and the test would not be about the requirements file alone.
  execFileSync("git", ["-C", reqRepo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", reqRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { stdio: "ignore" });
  // Dirty the tree with that file alone.
  await fs.writeFile(path.join(reqRepo, "REQUIREMENTS.md"), "# Requirements\n\napproved\n");
  reqReady = true;
} catch {
  reqReady = false;
}

if (reqReady) {
  const scriptDryRun = () => {
    assistantScript.push("Plan.\n\nHARNESS-DONE\n\nHARNESS-DECISION: PIPELINE", "Explored.\n\nHARNESS-DONE", "Reviewed.\n\nHARNESS-DONE");
  };
  reset();
  scriptDryRun();
  await mod.runPipeline(fakePi, makeCtx(reqRepo, true), "tarea", waitTurn);
  check(
    "preflight integration: a tree dirty only by REQUIREMENTS.md raises no warning (REQ-019)",
    !notifies.some((n) => n.includes("Repository preflight")) && !sent.some((s) => s.includes("Repository preflight")),
    notifies.join(" | "),
  );

  // Positive control: the same repository with one more changed path must warn,
  // or the check above would pass merely because git never ran.
  await fs.mkdir(path.join(reqRepo, "src"), { recursive: true });
  await fs.writeFile(path.join(reqRepo, "src", "a.ts"), "export {};\n");
  reset();
  scriptDryRun();
  await mod.runPipeline(fakePi, makeCtx(reqRepo, true), "tarea", waitTurn);
  check(
    "preflight integration: one more changed path restores the warning (REQ-019)",
    notifies.some((n) => n.includes("Repository preflight") && n.includes("uncommitted changes")),
    notifies.join(" | "),
  );
} else {
  console.log("SKIP preflight integration tests: git is unavailable in this environment");
}

// --- P1-5: structured control tools -------------------------------------------
check("control tools are registered", !!tools["harness_decision"] && !!tools["harness_report"]);
check(
  "normalizeDecision accepts sloppy casing and rejects nonsense",
  mod.normalizeDecision("PIPELINE") === "pipeline" &&
    mod.normalizeDecision(" answer_only ") === "answer_only" &&
    mod.normalizeDecision("nope") === null &&
    mod.normalizeDecision(7) === null,
);
check("lastAssistantHasToolCall reads the newest assistant message", mod.lastAssistantHasToolCall(makeCtx(tmp, true)) === false);

const noPipelineCtx = makeCtx(tmp, true);
const inertDecision = await tools["harness_decision"].execute("c0", { decision: "PIPELINE" }, undefined, undefined, noPipelineCtx);
const inertReport = await tools["harness_report"].execute("c1", { changed_files: ["a.ts"] }, undefined, undefined, noPipelineCtx);
check(
  "control tools are inert outside a pipeline",
  inertDecision.content[0].text.includes("No harness pipeline") && inertReport.content[0].text.includes("No harness pipeline"),
  `${inertDecision.content[0].text} / ${inertReport.content[0].text}`,
);

const badDecision = await tools["harness_decision"]
  .execute("c2", { decision: "maybe" }, undefined, undefined, makeCtx(tmp, true))
  .then(() => "resolved", (error) => error);
check(
  "harness_decision throws on an unusable value (the runtime only marks throws as errors)",
  badDecision instanceof Error && badDecision.message.includes("ANSWER_ONLY"),
  String(badDecision),
);

// Tool decision on a multi-step pipeline: runs, no short-circuit, no repair.
const cfgControl = await fs.readFile(cfgPath, "utf8");
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "pipeline", reason: "files must change" } };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "cambiar algo", waitTurn);
check("tool: a decision call runs the whole pipeline", sent.length === 3, `got ${sent.length}`);
check("tool: no repair turn when the decision came from the tool", !sent.some((s) => s.includes("no usable decision")), sent.length + "");
check(
  "tool: the reason is surfaced for the operator",
  notifies.some((n) => n.includes("Orchestrator decision: pipeline") && n.includes("files must change")),
  notifies.join(" | "),
);
check("tool: sloppy casing is accepted", toolErrors.length === 0, toolErrors.join(" | "));

// ANSWER_ONLY through the tool routes to the architect, like the marker does.
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" } };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "una pregunta", waitTurn);
check("tool: ANSWER_ONLY routes to the architect", sent.length === 2 && sent[1]?.includes("prompts/architecture.md"), `got ${sent.length}`);
check(
  "tool: the routed footer names the architect and the decision",
  statuses.some((s) => String(s).includes("architect") && String(s).includes("decision: answer_only")),
  statuses.slice(-3).join(" | "),
);
// REQ-010: that architect turn left a design session open, and only the user
// can close it. Close it here, as a user would, so the footer and routing of the
// sections below are not measured through a session that happens to be open.
await commands["harness-end"].handler("", makeCtx(tmp, true));

// With routing off, the same decision ends the pipeline after the orchestrator.
reset();
await fs.writeFile(cfgPath, cfgControl.replace("  analysis_routing: true", "  analysis_routing: false"));
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" } };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "una pregunta", waitTurn);
check("tool: with routing off ANSWER_ONLY ends the pipeline", sent.length === 1, `got ${sent.length}`);
await fs.writeFile(cfgPath, cfgControl);

// The tool wins over a contradicting marker, thanks to the runtime ordering:
// message_end (which reads the marker) runs BEFORE the tool executes.
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" }, text: "Done.\n\nHARNESS-DECISION: PIPELINE" };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "contradicción", waitTurn);
check("tool: the tool beats a contradicting marker in the same message", sent.length === 2 && sent[1]?.includes("prompts/architecture.md"), `got ${sent.length}`);

// Lowercase decision must not stop the pipeline (the enum trap the critic flagged).
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" }, text: "Done.\n\nHARNESS-DECISION: PIPELINE" };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "contradicción invertida", waitTurn);
check("tool: lowercase decision is normalized, not rejected", sent.length === 2 && toolErrors.length === 0, `sent=${sent.length} ${toolErrors.join("|")}`);

// A report call satisfies the per-step guarantee with no HARNESS-DONE at all.
reset();
pendingToolCall = null;
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea con report tool", waitTurn, "full-dry-run");
check("report tool: the text marker still works as a fallback", sent.length === 3, `got ${sent.length}`);

// harness_report replaces HARNESS-DONE for the last step.
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
pendingToolCall = {
  name: "harness_report",
  params: {
    changed_files: ["a.ts", "b.ts"],
    checks: [{ command: "npm test", result: "passed" }],
    notes: "listo",
    lessons: ["npm test is the only gate here"],
  },
};
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea con report", waitTurn);
check("report tool: a harness_report call satisfies the step with no marker", sent.length === 3, `got ${sent.length}`);
check(
  "report tool: no repair turn and no missing-report warning",
  !notifies.some((n) => n.includes("did not report")) && !notifies.some((n) => n.includes("report is missing")),
  notifies.join(" | "),
);

// --- exploration and memory are reachable in the default mode ---------------

const cfgLines = (await fs.readFile(cfgPath, "utf8")).split("\n");
const simpleSteps = mod.getWorkflowSteps(cfgLines, "full") ?? [];
const implementerTools = mod.getAgentTools(cfgLines, "implementer");
check(
  "config: the implementer of the default mode is granted codegraph",
  simpleSteps.includes("implementer") && implementerTools.includes("codegraph"),
  `full=${simpleSteps.join("->")} tools=${implementerTools.join(",")}`,
);
// REQ-011: the router is granted no tools at all. Its control tools are
// registered by the extension and are not gated by this list, so routing still
// works with an empty one — the point is that it cannot reach a tool at all.
check(
  "config: the orchestrator is granted no tools, so it cannot analyse or reach GitHub",
  JSON.stringify(mod.getAgentTools(cfgLines, "orchestrator")) === "[]",
  mod.getAgentTools(cfgLines, "orchestrator").join(","),
);
check(
  "config: issues belong to the architect",
  mod.getAgentTools(cfgLines, "architect").includes("github"),
  mod.getAgentTools(cfgLines, "architect").join(","),
);
// REQ-017: `engram` reaches the four agents whose output depends on prior
// project knowledge. The set is named for reading, not for writing: the critic
// records no `mem_save`, so the old "agents that record findings" name would
// have been false the moment the critic joined.
const engramReaders = ["architect", "explorer", "implementer", "critic"];
check(
  "config: engram reaches the four agents that read it",
  engramReaders.every((a) => mod.getAgentTools(cfgLines, a).includes("engram")),
  engramReaders.filter((a) => !mod.getAgentTools(cfgLines, a).includes("engram")).join(",") || "all four hold it",
);
// The example config is what `init` copies, so the grant has to ship in it too.
// `exampleLines` is declared further down; read it here under its own name.
const exampleLinesForEngram = (await fs.readFile(path.join(ROOT, "harness.config.example.yaml"), "utf8")).split("\n");
check(
  "config: the shipped example grants engram to the critic too",
  engramReaders.every((a) => mod.getAgentTools(exampleLinesForEngram, a).includes("engram")),
  engramReaders.filter((a) => !mod.getAgentTools(exampleLinesForEngram, a).includes("engram")).join(",") ||
    "all four hold it",
);
check(
  "config: neither the router nor delivery holds engram",
  !mod.getAgentTools(cfgLines, "orchestrator").includes("engram") &&
    !mod.getAgentTools(cfgLines, "delivery").includes("engram"),
);
check(
  "config: an agent without a tools list still resolves to no tools (backward compatibility)",
  JSON.stringify(mod.getAgentTools(["agents:", "  x:", "    model: p/m"], "x")) === "[]" &&
    JSON.stringify(mod.getAgentTools(cfgLines, "no-such-agent")) === "[]",
);
// REQ-014: the tests are a step of their own, between the implementer and
// delivery. The order is the requirement, so it is asserted as a whole rather
// than as a membership test.
check(
  "config: the full workflow runs orchestrator -> explorer -> critic -> implementer -> tester -> delivery",
  JSON.stringify(simpleSteps) === JSON.stringify(["orchestrator", "explorer", "critic", "implementer", "tester", "delivery"]),
  simpleSteps.join(" -> "),
);
check(
  "config: the tester mutates files and holds the tools its duty needs",
  mod.agentMutatesFiles(cfgLines, "tester") === true &&
    ["filesystem", "shell", "tests", "engram", "codegraph"].every((t) =>
      mod.getAgentTools(cfgLines, "tester").includes(t),
    ),
  `mutates=${mod.agentMutatesFiles(cfgLines, "tester")} tools=${mod.getAgentTools(cfgLines, "tester").join(",")}`,
);
// REQ-014: `REQUIRED_AGENTS` is what makes validation demand the agent, so an
// installation that has not run `update` fails loudly instead of silently
// running a workflow whose tester step is missing.
const validateLabels = await mod.validate(cfgLines, cfgPath, tmp);
check(
  "config: validation requires the tester agent",
  validateLabels.some((c) => c.label === 'agent "tester" exists' && c.ok),
  validateLabels.filter((c) => c.label.includes("tester")).map((c) => `${c.label}=${c.ok}`).join(" | ") || "no tester check",
);
check(
  "config: the shipped example ships the tester step too",
  JSON.stringify(mod.getWorkflowSteps(exampleLinesForEngram, "full")) ===
    JSON.stringify(["orchestrator", "explorer", "critic", "implementer", "tester", "delivery"]),
  (mod.getWorkflowSteps(exampleLinesForEngram, "full") ?? []).join(" -> "),
);
// REQ-015: one predicate, two rules — it opens a repair round and it refuses
// delivery. Tested directly because neither rule is reachable without driving
// a pipeline, and a copy of this predicate in each would be how they diverge.
check(
  "declared failures: only a failed check counts, and a missing list is none",
  mod.declaredFailedChecks([{ command: "a", result: "passed" }, { command: "b", result: "failed" }]).length === 1 &&
    mod.declaredFailedChecks([{ command: "b", result: "failed" }])[0].command === "b" &&
    mod.declaredFailedChecks([{ command: "c", result: "skipped" }]).length === 0 &&
    mod.declaredFailedChecks(null).length === 0 &&
    mod.declaredFailedChecks([]).length === 0,
);
check(
  "config: requirements_format defaults to sections and reads req-n",
  mod.getRequirementsFormat(["defaults:", "  workflow_mode: full"]) === "sections" &&
    mod.getRequirementsFormat(["defaults:", "  requirements_format: req-n"]) === "req-n" &&
    // A typo must never break an install.
    mod.getRequirementsFormat(["defaults:", "  requirements_format: reqnn"]) === "sections",
);
check(
  "config: setRequirementsFormat rewrites the key and adds it when missing",
  mod.getRequirementsFormat(mod.setRequirementsFormat(cfgLines, "sections")) === "sections" &&
    mod.getRequirementsFormat(
      mod.setRequirementsFormat(["defaults:", "  workflow_mode: full"], "req-n"),
    ) === "req-n",
);
check(
  "config: the delivery agent declares the github-delivery skill",
  JSON.stringify(mod.getAgentSkills(cfgLines, "delivery")) === '["github-delivery"]' &&
    JSON.stringify(mod.getAgentSkills(cfgLines, "orchestrator")) === "[]",
  JSON.stringify(mod.getAgentSkills(cfgLines, "delivery")),
);
check(
  "config: a declared skill resolves to its SKILL.md",
  (mod.resolveSkillPath(tmp, cfgPath, "github-delivery", cfgLines) ?? "").endsWith(path.join("github-delivery", "SKILL.md")),
  String(mod.resolveSkillPath(tmp, cfgPath, "github-delivery", cfgLines)),
);
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
reset();
assistantTextOverride = "Plan.\n\nHARNESS-DONE\n\nHARNESS-DECISION: PIPELINE";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "entrega", waitTurn, "full");
assistantTextOverride = null;
check(
  // `full` is six steps since REQ-014 added the tester, so delivery is the
  // sixth prompt, not the fifth.
  "skills: the delivery step receives its declared skill content in the step message",
  sent.length === 6 && sent[5].includes("# GitHub Delivery"),
  `sent=${sent.length} has=${sent[5]?.includes("# GitHub Delivery")}`,
);
// The example config is what `init` copies into an adopting project.
const exampleLines = (await fs.readFile(path.join(ROOT, "harness.config.example.yaml"), "utf8")).split("\n");
check(
  "config: the shipped example grants codegraph to the implementer of the default mode, and to nobody else",
  (mod.getWorkflowSteps(exampleLines, "full") ?? []).includes("implementer") &&
    mod.getAgentTools(exampleLines, "implementer").includes("codegraph") &&
    !mod.getAgentTools(exampleLines, "orchestrator").includes("codegraph"),
  mod.getAgentTools(exampleLines, "implementer").join(","),
);

// The rendered prompt is what the model actually reads: the dependency check
// and the memory write have to survive rendering, not just live in the file.
const implementerPrompt = mod.renderPrompt(
  await fs.readFile(path.join(ROOT, "prompts", "implementer.md"), "utf8"),
  { task: "tarea", mode: "full", agent: "implementer", step: "4", steps: "5", previous: "" },
);
check(
  "prompt: the implementer is told to check dependents before editing a shared symbol",
  /depend/i.test(implementerPrompt) && implementerPrompt.includes("codegraph_explore") && /\bgrep\b|\brg\b/.test(implementerPrompt),
  implementerPrompt.slice(0, 0),
);
check("prompt: the implementer is told to record findings with mem_save", implementerPrompt.includes("mem_save"));
check("prompt: the local-change escape hatch is stated", /local,\s+obviously unreferenced/i.test(implementerPrompt));
check("prompt: the report format carries a lessons field", implementerPrompt.includes("### Lessons"));
check(
  "prompt: only the explorer and implementer record findings with mem_save, not the router",
  (await fs.readFile(path.join(ROOT, "prompts", "explorer.md"), "utf8")).includes("mem_save") &&
    !(await fs.readFile(path.join(ROOT, "prompts", "orchestrator.md"), "utf8")).includes("mem_save"),
);
check(
  "prompt: the router is told not to explore, and not to size the task",
  /do not explore/i.test(await fs.readFile(path.join(ROOT, "prompts", "orchestrator.md"), "utf8")),
);
// REQ-017: the read the write already had. Each of the four templates that owes
// one names it before it proposes or edits, and the two that must not read
// name neither the read nor the write.
const readTemplates = ["architecture.md", "explorer.md", "implementer.md", "critic.md"];
const readerBodies = Object.fromEntries(
  await Promise.all(readTemplates.map(async (f) => [f, await fs.readFile(path.join(ROOT, "prompts", f), "utf8")])),
);
const readTemplatesMissing = readTemplates.filter(
  (f) => !readerBodies[f].includes("mem_context") || !readerBodies[f].includes("mem_search"),
);
check(
  "prompt: the four readers name mem_context and mem_search before they work",
  readTemplatesMissing.length === 0,
  readTemplatesMissing.join(",") || readTemplates.join(", "),
);
check(
  "prompt: the read is never a gate — each reader says an absent memory does not stop it",
  readTemplates.every((f) => /never a gate/i.test(readerBodies[f])),
  readTemplates.filter((f) => !/never a gate/i.test(readerBodies[f])).join(",") || "all four say it",
);
const nonReaders = ["orchestrator.md", "delivery.md"];
check(
  "prompt: the router and delivery name neither the read nor the write",
  (await Promise.all(
    nonReaders.map((f) => fs.readFile(path.join(ROOT, "prompts", f), "utf8")),
  )).every((body) => !/mem_context|mem_search/.test(body)),
  nonReaders.join(", "),
);
// REQ-020: the architect's own prompt is the only channel it reads at step
// time, so the issue duty has to be named there, or the grant is decorative.
const architectPrompt = await fs.readFile(path.join(ROOT, "prompts", "architecture.md"), "utf8");
check(
  "prompt: the architect names the issue duty and the approving turn (REQ-020)",
  /owns? the issues/i.test(architectPrompt) && /harness-validate/.test(architectPrompt) && /separable/i.test(architectPrompt),
);
check(
  "contract and docs: the architect owns the issues (REQ-020)",
  /owns? the issues/i.test(await fs.readFile(path.join(ROOT, "pi-minimal-harness.md"), "utf8")) &&
    /owns? the issues/i.test(await fs.readFile(path.join(ROOT, "docs", "WORKFLOW.md"), "utf8")) &&
    /owns? the issues/i.test(await fs.readFile(path.join(ROOT, "README.md"), "utf8")),
);
check(
  "contract: the memory section states the read-before-work duty, and who does not read",
  /\*\*Read\*\* before working/.test(await fs.readFile(path.join(ROOT, "pi-minimal-harness.md"), "utf8")),
);
const reportTemplates = {};
for (const f of ["critic.md", "delivery.md", "explorer.md", "implementer.md"]) {
  reportTemplates[f] = await fs.readFile(path.join(ROOT, "prompts", f), "utf8");
}
check(
  "prompt: every template that owes a report names the lessons field",
  Object.values(reportTemplates).every((t) => t.includes("`lessons`")),
  Object.entries(reportTemplates)
    .filter(([, t]) => !t.includes("`lessons`"))
    .map(([f]) => f)
    .join(",") || "all four",
);

// --- report completeness: a missing field is repaired like a missing report --

const completeReport = {
  changedFiles: ["a.ts"],
  checks: [{ command: "node tests/harness.test.mjs", result: "passed" }],
  lessons: [],
  notes: "",
  verdict: null,
};
check("gaps: a complete report has no gaps", mod.reportGaps(completeReport, "").length === 0);
check("gaps: [] counts as a delivered field, not as a gap", mod.reportGaps(completeReport, "sin marker").length === 0);
check(
  "gaps: a report without lessons is a gap",
  JSON.stringify(mod.reportGaps({ ...completeReport, lessons: null }, "")) === '["lessons"]',
  JSON.stringify(mod.reportGaps({ ...completeReport, lessons: null }, "")),
);
check(
  "gaps: a report without changed_files or checks is a gap too",
  JSON.stringify(mod.reportGaps({ changedFiles: null, checks: null, lessons: [], notes: "" }, "")) ===
    '["changed_files","checks"]',
);
check("gaps: no report at all is a gap", JSON.stringify(mod.reportGaps(null, "")) === '["harness_report call"]');
check("gaps: the HARNESS-DONE fallback cannot be inspected, so it always counts", mod.reportGaps(null, "texto\n\nHARNESS-DONE").length === 0);
check(
  "gaps: a report without notes is a gap",
  JSON.stringify(mod.reportGaps({ ...completeReport, notes: null }, "")) === '["notes"]',
  JSON.stringify(mod.reportGaps({ ...completeReport, notes: null }, "")),
);
check(
  "gaps: HARNESS-DONE only counts on the last non-empty line",
  JSON.stringify(mod.reportGaps(null, "HARNESS-DONE\nmore text")) === '["harness_report call"]' &&
    mod.reportGaps(null, "texto\n\nHARNESS-DONE\n   ").length === 0,
);
check(
  "verdict: normalized case-insensitively, unknown reads as none",
  mod.normalizeVerdict("blocked") === "blocked" &&
    mod.normalizeVerdict("PROCEED WITH CHANGES") === "proceed_with_changes" &&
    mod.normalizeVerdict("Proceed") === "proceed" &&
    mod.normalizeVerdict("nope") === null &&
    mod.normalizeVerdict(42) === null,
);
check(
  "lessons: a bare string, blanks and a non-list are normalized",
  JSON.stringify(mod.normalizeLessons(" una")) === '["una"]' &&
    JSON.stringify(mod.normalizeLessons("  ")) === "null" &&
    JSON.stringify(mod.normalizeLessons([" a ", ""])) === '["a"]' &&
    JSON.stringify(mod.normalizeLessons(["", " "])) === "null" &&
    JSON.stringify(mod.normalizeLessons([])) === "[]" &&
    mod.normalizeLessons(undefined) === null &&
    mod.normalizeLessons(42) === null,
);

/** waitForTurn that injects a tool call on a chosen turn of the pipeline. */
const waitTurnInjecting = (injections) => async () => {
  while (injections.length > 0 && assistantTurns >= injections[0].after) {
    const next = injections.shift();
    if (next.call) pendingToolCall = next.call;
  }
  await new Promise((r) => setTimeout(r, 140));
  return true;
};

// A report that forgets `lessons` is incomplete: one repair turn, named field.
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE", "### Changes\n- a.ts", "### Changes\n- a.ts\n\n### Lessons\n- the root cause");
const withoutLessons = waitTurnInjecting([
  {
    after: 1,
    call: {
      name: "harness_report",
      params: { changed_files: ["a.ts"], checks: [{ command: "npm test", result: "passed" }], notes: "listo" },
    },
  },
  { after: 2, call: { name: "harness_report", params: { ...completeReport, changed_files: ["a.ts"] } } },
]);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "reporte sin lessons", withoutLessons);
check("lessons: a report missing lessons earns exactly one repair turn", sent.length === 4, `got ${sent.length}`);
check("lessons: the repair prompt names the missing field", sent[2]?.includes("lessons"), String(sent[2]).slice(0, 200));
check(
  "lessons: the completed repair finishes the pipeline",
  notifies.some((n) => n.includes("finished: orchestrator -> explorer -> critic")) && !notifies.some((n) => n.includes("did not report")),
  notifies.join(" | "),
);

// Still incomplete after the repair turn: the pipeline stops, naming the field.
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE", "### Changes\n- a.ts", "### Changes\n- a.ts");
const alwaysWithoutLessons = waitTurnInjecting([
  {
    after: 1,
    call: {
      name: "harness_report",
      params: { changed_files: ["a.ts"], checks: [{ command: "npm test", result: "passed" }], notes: "listo" },
    },
  },
  {
    after: 2,
    call: {
      name: "harness_report",
      params: { changed_files: ["a.ts"], checks: [{ command: "npm test", result: "passed" }], notes: "listo" },
    },
  },
]);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "reporte incompleto", alwaysWithoutLessons);
check(
  "lessons: a report still missing lessons after the repair stops the pipeline",
  sent.length === 3 && notifies.some((n) => n.includes("did not report") && n.includes("lessons")),
  `${sent.length} | ${notifies.join(" | ")}`,
);

// --- critic verdict: BLOCKED stops the pipeline before the mutating steps ----

reset();
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
const blockedRun = waitTurnInjecting([
  {
    after: 2,
    call: {
      name: "harness_report",
      params: { changed_files: [], checks: [], notes: "", lessons: [], verdict: "BLOCKED" },
    },
  },
]);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "plan bloqueado", blockedRun, "full");
check("verdict: BLOCKED stops the pipeline before the implementer", sent.length === 3, `got ${sent.length}`);
check(
  "verdict: the critic report is signalled as the final answer",
  notifies.some((n) => n.includes("BLOCKED") && n.includes("final answer")),
  notifies.join(" | "),
);
check(
  "verdict: no implementer or delivery step ran",
  !sent.some((s) => s.includes("implementer") || s.includes("delivery")),
  sent.map((s) => s.slice(0, 40)).join(" | "),
);

// --- step context: the previous step's reply is quoted, not assumed ----------

const explorerPrompt = await fs.readFile(path.join(tmp, "prompts", "explorer.md"), "utf8");
check(
  "sections: the explorer template yields its own report sections",
  mod.reportSectionsFromTemplate(explorerPrompt).join("|").includes("### Findings") &&
    !mod.reportSectionsFromTemplate(explorerPrompt).includes("### Changes"),
  mod.reportSectionsFromTemplate(explorerPrompt).join(" / "),
);
check(
  "previous: an absent previous reply says so explicitly",
  mod.formatPreviousStepOutput(null) === "none (this step has no prior output)" &&
    mod.formatPreviousStepOutput("   ") === "none (this step has no prior output)",
  mod.formatPreviousStepOutput(null),
);
const capped = mod.formatPreviousStepOutput("y".repeat(9000));
check(
  "previous: a long previous reply is bounded and says how much was omitted",
  capped.startsWith("y".repeat(4096)) && capped.includes("[") && capped.includes("chars omitted]"),
  `${capped.length} chars`,
);
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("### Changes\n- a.ts\n\nHARNESS-DONE");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea", waitTurn);
check(
  "previous: the second step is handed the first step's reply, not a literal",
  sent[1]?.includes("Plan.") && !sent[1]?.includes("{{previous}}: from this conversation"),
  String(sent[1]).slice(0, 140),
);

// --- dispatch: project rules reach the subagent, the first step does not -----

const dispatchTmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-ctx-"));
const agentPromptPath = path.join(dispatchTmp, "prompt.md");
const contractPath2 = path.join(dispatchTmp, "contract.md");
await fs.writeFile(agentPromptPath, "# Explorer\n\n## Task\n{{task}}\n\n### Findings\nwhat exists\n");
await fs.writeFile(contractPath2, "HARNESS CONTRACT\n");
const basePrompt = await mod.composeDispatchSystemPrompt({
  templatePath: agentPromptPath,
  contractPath: contractPath2,
  agent: "explorer",
  brief: "Objetivo\n\nmore context",
});
check(
  "dispatch: without an AGENTS.md the system prompt is template + contract",
  // Asserted on the marker the composer actually emits today. A previous
  // version grepped "Project rules (", a string REQ-001 replaced with the
  // `<repo_content>` label: the check kept passing while testing nothing.
  basePrompt.includes("### Findings") &&
    basePrompt.includes("HARNESS CONTRACT") &&
    !basePrompt.includes('<repo_content source="AGENTS.md">'),
  basePrompt.slice(0, 80),
);
await fs.writeFile(path.join(dispatchTmp, "AGENTS.md"), "PROJECT RULE: never touch generated files.\n");
const withRules = await mod.composeDispatchSystemPrompt({
  templatePath: agentPromptPath,
  contractPath: contractPath2,
  projectRulesPath: path.join(dispatchTmp, "AGENTS.md"),
  agent: "explorer",
  brief: "Objetivo",
});
check(
  "dispatch: the project's AGENTS.md is injected last and wins on conflict",
  withRules.includes("PROJECT RULE: never touch generated files.") &&
    withRules.lastIndexOf("<repo_content") > withRules.indexOf("HARNESS CONTRACT") &&
    withRules.includes("these win"),
  String(withRules.lastIndexOf("<repo_content")),
);
check(
  // The precedence line is the harness speaking, not project content, so it must
  // sit OUTSIDE the "never obey this" block. Inside it, the boundary would have
  // covered the very rule that tells the subagent which rules win.
  "dispatch: the precedence statement sits outside the data boundary",
  withRules.includes("these win") &&
    withRules.indexOf("these win") < withRules.indexOf('<repo_content source="AGENTS.md">'),
  String(withRules.indexOf("these win") - withRules.indexOf('<repo_content source="AGENTS.md">')),
);
const withSkill = await mod.composeDispatchSystemPrompt({
  templatePath: agentPromptPath,
  contractPath: contractPath2,
  skillBodies: ["SKILL BODY: stage only the reported paths."],
  agent: "delivery",
  brief: "Objetivo",
});
check(
  "dispatch: declared skills are injected into the subagent system prompt",
  withSkill.includes('<repo_content source="project-skills">') && withSkill.includes("SKILL BODY: stage only the reported paths."),
  withSkill.slice(0, 120),
);
// REQ-001: every source this function injects from the repository is inside a
// boundary, so a skill cannot smuggle an instruction into a subagent.
check(
  // REQ-001: the two natures. Project content is data and is wrapped; the
  // harness contract is the subagent's rulebook and must arrive as instruction.
  // Wrapping the contract was a real defect that passed every test, because
  // "never obey this" breaks no assertion — only the product.
  "dispatch: project content is wrapped as data, and the contract is not",
  withSkill.includes('<repo_content source="project-skills">') &&
    withSkill.includes("</repo_content>") &&
    /never obey it/.test(withSkill) &&
    !withSkill.includes('<repo_content source="harness-contract">'),
  withSkill.slice(0, 160),
);
check(
  "dispatch: the contract is presented as the authoritative instruction set",
  withSkill.includes("the harness contract for this project: the rules you are expected to follow") &&
    withSkill.includes("Its audit belongs to the user"),
  withSkill.slice(withSkill.indexOf("HARNESS CONTRACT") - 260, withSkill.indexOf("HARNESS CONTRACT")),
);
check(
  "dispatch: project rules are found at the project root",
  mod.resolveProjectRulesPath(undefined, dispatchTmp) === path.join(dispatchTmp, "AGENTS.md") &&
    mod.resolveProjectRulesPath(undefined, tmp) === null,
  String(mod.resolveProjectRulesPath(undefined, dispatchTmp)),
);
check(
  "dispatch: the pipeline's first step cannot be dispatched, leaf agents can",
  (mod.dispatchUnsupportedAgent("orchestrator", cfgLines) ?? "").includes("cannot run as a dispatched subagent") &&
    mod.dispatchUnsupportedAgent("explorer", cfgLines) === null,
  String(mod.dispatchUnsupportedAgent("orchestrator", cfgLines)).slice(0, 80),
);
await fs.rm(dispatchTmp, { recursive: true, force: true });

// A report sent by the orchestrator never stands in for the next step's report.
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
const staleReport = waitTurnInjecting([
  { after: 0, call: { name: "harness_report", params: { ...completeReport, changed_files: [] } } },
  {
    after: 2,
    call: { name: "harness_report", params: { changed_files: ["a.ts"], checks: [{ command: "npm test", result: "passed" }], notes: "x" } },
  },
]);
assistantScript.push("### Changes\n- a.ts");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "informe del orquestador", staleReport);
check(
  "report: a stale report from the orchestrator does not satisfy the last step",
  sent.length === 4,
  `got ${sent.length}`,
);

// --- the architect session --------------------------------------------------
// Placed last: `inArchitectSession` is module state for the whole process, and
// the block ends by closing the session again. Auto-harness was switched off
// earlier in this file, and the normal path needs it.
await fs.writeFile(cfgPath, (await fs.readFile(cfgPath, "utf8")).replace(/^ {2}auto_harness: .*$/m, "  auto_harness: true"));
// Earlier sections routed ANSWER_ONLY to the architect more than once, and
// REQ-010 makes every architect turn leave a session open. Close it here, as a
// user would, so this section starts from the closed state it is asserting.
await commands["harness-end"].handler("", makeCtx(tmp, true));
reset();
// `waitTurnInjecting` consumes its list with `shift()`, so a single injector
// cannot serve two runs. Build one per turn that needs a tool call.
const architectTurn = () =>
  waitTurnInjecting([{ after: 0, call: { name: "harness_decision", params: { decision: "answer_only" } } }]);
const openByTurn = architectTurn();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "diseñemos la API", openByTurn);
check(
  // REQ-010: no tool call in the architect's turn. The session is open because
  // the architect ran, which is the whole point — a model that forgets cannot
  // silently hand the conversation back to the orchestrator.
  "session: an architect turn alone opens the session, with nothing called",
  notifies.some((n) => n.includes("Architect session open")),
  notifies.join(" | "),
);
check(
  "session: the tool that used to open it is gone",
  !tools["harness_session"],
  Object.keys(tools).join(","),
);

reset();
sent.length = 0;
await events["input"]({ text: "y si fuera multi-idioma?", source: "interactive" }, makeCtx(tmp, false));
await new Promise((r) => setTimeout(r, 1500));
check(
  "session: the next plain input goes straight to the architect",
  sent.length === 1 && sent[0]?.includes("prompts/architecture.md"),
  `sent=${sent.length} ${String(sent[0]).slice(0, 70)}`,
);
check("session: the orchestrator is skipped while it is open", !sent[0]?.includes("prompts/orchestrator.md"));

// A slash command must still reach its own command, not the architect.
reset();
sent.length = 0;
const slash = await events["input"]({ text: "/harness-mode", source: "interactive" }, makeCtx(tmp, false));
check("session: a slash command is not swallowed by the session", slash.action === "continue" && sent.length === 0);

// REQ-009: the session survives a reload because it is written to the branch
// and read back in `session_start`. Close first, so the turn below is a real
// transition and therefore writes an entry that the restore can find.
await commands["harness-end"].handler("", makeCtx(tmp, true));
await commands["harness-end"].handler("", makeCtx(tmp, true));
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "diseño", architectTurn());
check(
  "session: an architect turn writes the session to the branch",
  branchArr.some((e) => e.type === "custom"),
  `sent=${sent.length} types=${JSON.stringify(branchArr.map((e) => e.type))} ${notifies.join(" | ")}`,
);
check(
  "session: session_start restores it from the branch after a reload",
  mod.readDesignSessionFromBranch(branchArr) === true,
  JSON.stringify(branchArr.filter((e) => e.type === "custom").map((e) => e.data)),
);
check(
  "session: an empty branch restores to closed, so no stale session survives a reload",
  mod.readDesignSessionFromBranch([]) === false,
);

// /harness-end is the user's gesture, and it is the only one. It must also clear
// the persisted entry, or the next reload would resurrect the closed session.
notifies.length = 0;
await commands["harness-end"].handler("", makeCtx(tmp, true));
check("session: /harness-end reports that it closed the session", notifies.some((n) => n.includes("Design session closed")), notifies.join(" | "));
check(
  "session: closing writes the closed state, so a reload cannot resurrect it",
  mod.readDesignSessionFromBranch(branchArr) === false,
  JSON.stringify(branchArr.filter((e) => e.type === "custom").map((e) => e.data)),
);

reset();
sent.length = 0;
await events["input"]({ text: "otra pregunta", source: "interactive" }, makeCtx(tmp, false));
await new Promise((r) => setTimeout(r, 1500));
check("session: after /harness-end the orchestrator routes again", sent[0]?.includes("prompts/orchestrator.md"), String(sent[0]).slice(0, 70));

notifies.length = 0;
await commands["harness-end"].handler("", makeCtx(tmp, true));
check(
  "session: /harness-end is harmless when no session is open",
  notifies.some((n) => n.includes("No design session is open")),
  notifies.join(" | "),
);

// The architect converses, so it owes no structured report.
reset();
assistantScript.push("This needs design.\n\nHARNESS-DECISION: ANSWER_ONLY");
assistantScript.push("Here is the proposal.");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "idea suelta", waitTurn);
check(
  "architect: a chat reply with no report earns no repair turn",
  sent.length === 2 && !sent.some((s) => s.includes("did not report") || s.includes("HARNESS-DONE")),
  `sent=${sent.length}`,
);

// The textual marker is gone: there is nothing to fall back to, and a stale
// `HARNESS-SESSION: START` in a reply must neither arm a session nor be eaten.
reset();
assistantScript.push("Needs design.\n\nHARNESS-DECISION: ANSWER_ONLY");
assistantScript.push("Opening the session.\n\nHARNESS-SESSION: START");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "volvamos a esto", waitTurn);
const lastWithSession = JSON.stringify([...branchArr].reverse().find((e) => e.type === "message" && e.message.role === "assistant"));
check(
  "session: a stale HARNESS-SESSION marker is inert and stays in the visible reply",
  lastWithSession.includes("HARNESS-SESSION"),
  lastWithSession.slice(-120),
);

// REQ-013: /harness-validate is the one path that writes the requirements file,
// so it gets its own coverage. With no session open there is nothing to approve
// and no pipeline may run at all — asserted by the absence of a step message,
// not by the wording of the notice. The block above left a session open (that
// run reached the architect), so close it first.
await commands["harness-end"].handler("", makeCtx(tmp, true));
reset();
notifies.length = 0;
sent.length = 0;
await commands["harness-validate"].handler("", makeCtx(tmp, true));
check(
  "validate: with no session open it refuses and runs no pipeline",
  sent.length === 0 && notifies.some((n) => n.includes("no open design session")),
  `sent=${sent.length} ${notifies.join(" | ")}`,
);

reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "diseño", architectTurn());
const sessionOpenBefore = mod.readDesignSessionFromBranch(branchArr);
check("validate: a session is open for the next case", sessionOpenBefore === true);

// With a session open it runs exactly one architect step. `waitForIdle` now waits
// like `waitTurn`, because the fake schedules the assistant turn asynchronously
// and a no-op would read the turn before it arrived.
reset();
notifies.length = 0;
sent.length = 0;
await commands["harness-validate"].handler("aprobado el alcance", makeCtx(tmp, true));
check(
  "validate: with a session open it runs one architect step in analysis mode",
  sent.length === 1 && sent[0]?.includes("prompts/architecture.md") && sent[0]?.includes("analysis"),
  `sent=${sent.length} ${String(sent[0]).slice(0, 90)}`,
);
check(
  "validate: the approval and the note reach the architect",
  sent[0]?.includes("aprobado el alcance"),
  String(sent[0]).slice(0, 120),
);
check(
  // The property most worth a test: approving is not finishing. Asserted by
  // behaviour rather than by reading the branch, because `reset()` cleared the
  // persisted copy and the session is still open in memory — exactly the state a
  // reload would have to restore.
  "validate: it leaves the session open",
  await (async () => {
    sent.length = 0;
    await events["input"]({ text: "y si fuera multi-idioma?", source: "interactive" }, makeCtx(tmp, false));
    await new Promise((r) => setTimeout(r, 1500));
    return sent[0]?.includes("prompts/architecture.md") === true;
  })(),
  String(sent[0]).slice(0, 70),
);

// Leave no session armed for anything that runs after this block.
await commands["harness-end"].handler("", makeCtx(tmp, true));
reset();
sent.length = 0;
await events["input"]({ text: "comprobación", source: "interactive" }, makeCtx(tmp, false));
await new Promise((r) => setTimeout(r, 1500));
check("session: no session is left armed", sent[0]?.includes("prompts/orchestrator.md"), String(sent[0]).slice(0, 70));

// REQ-016: a step whose turn ends in a model error is retried once. The common
// cause is a transient provider failure, and one turn is cheap against stopping
// a run that already holds implemented work. The error is scripted on the
// explorer, not on the orchestrator, so the run also gets past step 1 and the
// resume case below has a completed step to resume from.
reset();
assistantScript.push(
  "Plan.\n\nHARNESS-DECISION: PIPELINE",
  { text: "the provider died", stopReason: "error" },
  "Findings.\n\nHARNESS-DONE",
  "Critique.\n\nHARNESS-DONE",
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "retry me", waitTurn);
check(
  "resume: an errored step is retried and the retry is announced",
  sent.length === 4 && notifies.some((n) => n.includes("failed: simulated model error") && n.includes("Retrying it once")),
  `sent=${sent.length} ${notifies.join(" | ")}`,
);
check(
  "resume: the retried step is the same step, re-sent unchanged",
  sent[1] === sent[2] && sent[1]?.includes("prompts/explorer.md"),
  `s1=${String(sent[1]).slice(0, 50)} s2=${String(sent[2]).slice(0, 50)}`,
);
check(
  "resume: a step that recovers on the retry runs the whole workflow",
  notifies.some((n) => n.includes('Pipeline "full-dry-run" finished: orchestrator -> explorer -> critic')),
  notifies.join(" | "),
);

// The bound is real: a second error stops the run instead of retrying forever,
// and this is the state the resume path is built on.
reset();
assistantScript.push(
  "Plan.\n\nHARNESS-DECISION: PIPELINE",
  { text: "first failure", stopReason: "error" },
  { text: "second failure", stopReason: "error" },
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "stop here", waitTurn);
check(
  "resume: the retry is bounded at one and the second error stops the pipeline",
  sent.length === 3 &&
    notifies.some((n) => n.includes("Pipeline failed at step 2 (explorer)")) &&
    !notifies.some((n) => n.includes("attempt 3")),
  `sent=${sent.length} ${notifies.join(" | ")}`,
);

// A stopped run leaves a way forward: the state is written to the branch, and
// the branch is what survives a `/reload` (REQ-009's precedent).
const stopped = mod.readStoppedPipelineFromBranch(branchArr);
check(
  "resume: a stopped pipeline persists mode, task, completed and failed step",
  !!stopped &&
    stopped.mode === "full-dry-run" &&
    stopped.task === "stop here" &&
    JSON.stringify(stopped.completed) === '["orchestrator"]' &&
    stopped.failedStep === "explorer" &&
    JSON.stringify(stopped.steps) === '["orchestrator","explorer","critic"]',
  JSON.stringify(stopped),
);
check(
  "resume: an empty branch reads as no stop, so a reload resurrects nothing",
  mod.readStoppedPipelineFromBranch([]) === null,
);
check(
  "resume: a malformed entry reads as no stop rather than throwing",
  mod.readStoppedPipelineFromBranch([
    { type: "custom", customType: "pi-minimal-harness:stopped-pipeline", data: { stopped: true, mode: 7 } },
  ]) === null,
);
// REQ-009's session persistence is asserted through the exported branch reader;
// this one re-imports the module for real, so "survives a re-import" is measured
// rather than assumed. The entry lives in the branch, not in module state, which
// is what makes it outlive the runtime that wrote it.
const reimported = await import(`${pathToFileURL(path.join(ROOT, ".pi", "extensions", "harness.ts")).href}?reload=1`);
check(
  "resume: the persisted stop survives a re-import of the extension",
  reimported.readStoppedPipelineFromBranch(branchArr)?.failedStep === "explorer",
  JSON.stringify(reimported.readStoppedPipelineFromBranch(branchArr)),
);
check(
  "resume: the stop message names the step, the partial work and both exits",
  notifies.some(
    (n) =>
      n.includes("stopped at step 2 (explorer)") &&
      n.includes("partial work") &&
      n.includes("/harness-resume") &&
      n.includes("/harness-delivery"),
  ),
  notifies.join(" | "),
);

// A plain message must not silently re-run the whole workflow over a stopped
// run: that would discard the completed steps and — the router holds no tools —
// reach delivery without the issue the original run carried.
//
// `reset()` is deliberately not used here: it clears `branchArr`, which is
// where the stop is persisted, so the guard would find nothing to refuse. Only
// the observation arrays are cleared.
sent.length = 0;
notifies.length = 0;
const guarded = await events["input"]({ text: "y ahora?", source: "interactive" }, makeCtx(tmp, false));
await new Promise((r) => setTimeout(r, 250));
check(
  "resume: a plain message while stopped is refused and names the two exits",
  guarded.action === "handled" &&
    sent.length === 0 &&
    notifies.some((n) => n.includes('stopped at "explorer"') && n.includes("/harness-resume")),
  `action=${guarded.action} sent=${sent.length} ${notifies.join(" | ")}`,
);
check(
  "resume: the refused message did not start a new pipeline",
  !sent.some((s) => s.includes("prompts/orchestrator.md")),
  `sent=${sent.length}`,
);
// The same guard must not eat the message when auto-harness is off: `/harness-auto
// off` promises that a plain request goes to the model, and nothing would have
// replaced this one with a pipeline. The stop is still worth reporting — the
// partial work is still in the tree — but the message is the user's.
const cfgBeforeAutoOff = await fs.readFile(cfgPath, "utf8");
await fs.writeFile(cfgPath, cfgBeforeAutoOff.replace("  auto_harness: true", "  auto_harness: false"));
sent.length = 0;
notifies.length = 0;
const passedThrough = await events["input"]({ text: "una pregunta normal", source: "interactive" }, makeCtx(tmp, false));
await new Promise((r) => setTimeout(r, 250));
check(
  "resume: with auto-harness off the guard reports the stop but lets the message through",
  passedThrough.action === "continue" &&
    sent.length === 0 &&
    notifies.some((n) => n.includes("A pipeline stopped at") && !n.includes("not sent to a new pipeline")),
  `action=${passedThrough.action} sent=${sent.length} ${notifies.join(" | ")}`,
);
check(
  "resume: the message passed through did not start a pipeline either",
  !sent.some((s) => s.includes("prompts/orchestrator.md")),
  `sent=${sent.length}`,
);
await fs.writeFile(cfgPath, cfgBeforeAutoOff);

// /harness-resume continues from the step after the last completed one — and
// never re-runs the orchestrator, which is what would lose the issue.
sent.length = 0;
notifies.length = 0;
await commands["harness-resume"].handler("", makeCtx(tmp, true));
check(
  "resume: /harness-resume starts at the step after the last completed one",
  sent.length === 2 && !sent.some((s) => s.includes("prompts/orchestrator.md")) && sent[0]?.includes("prompts/explorer.md"),
  `sent=${sent.length} ${sent.map((s) => String(s).slice(0, 26)).join(" | ")}`,
);
check(
  "resume: the resumed step is told what already completed",
  sent.some((s) => s.includes("Resuming a stopped pipeline") && s.includes("orchestrator")),
  String(sent[0]).slice(0, 140),
);
check(
  "resume: a resumed run that completes leaves nothing to resume",
  notifies.some((n) => n.includes('Pipeline "full-dry-run" finished')) &&
    mod.readStoppedPipelineFromBranch(branchArr) === null,
  `${notifies.join(" | ")} | stopped=${JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr))}`,
);

// A forced run is a third way to walk away from a resumable stop. Left alone it
// inherits the record, and when the new run also stopped it overwrote it — the
// earlier run's completed steps gone with no way back.
reset();
assistantScript.push(
  "Plan.\n\nHARNESS-DECISION: PIPELINE",
  { text: "first failure", stopReason: "error" },
  { text: "second failure", stopReason: "error" },
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "stop once more", waitTurn);
check(
  "resume: a stop is recorded for the forced-run case",
  mod.readStoppedPipelineFromBranch(branchArr)?.task === "stop once more",
  JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
);
// No reset(): it clears the branch, which is where the stop lives. Clear only the
// observation arrays so the /harness-run notification is the thing measured.
sent.length = 0;
notifies.length = 0;
// Its own turns are scripted rather than left to the fake's turn counter: this
// run must reach completion so the assertion below measures the clear and not a
// second stop it recorded for itself.
assistantScript.push(
  "Plan.\n\nHARNESS-DECISION: PIPELINE",
  "Findings.\n\nHARNESS-DONE",
  "Critique.\n\nHARNESS-DONE",
);
await commands["harness-run"].handler("a different task", makeCtx(tmp, true));
check(
  "resume: /harness-run names the stop it abandons instead of dropping it silently",
  notifies.some((n) => n.includes('Abandoning the pipeline stopped at "explorer"')),
  notifies.join(" | "),
);
check(
  "resume: /harness-run consumes the stop it abandons",
  mod.readStoppedPipelineFromBranch(branchArr) === null,
  JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
);

// The second exit clears the record too, or the guard would keep offering a
// resume with nothing left to resume.
reset();
assistantScript.push(
  "Plan.\n\nHARNESS-DECISION: PIPELINE",
  { text: "first failure", stopReason: "error" },
  { text: "second failure", stopReason: "error" },
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "stop again", waitTurn);
check(
  "resume: a fresh stop is recorded again",
  mod.readStoppedPipelineFromBranch(branchArr)?.task === "stop again",
  JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
);
reset();
await commands["harness-delivery"].handler("", makeCtx(tmp, true));
await new Promise((r) => setTimeout(r, 300));
check(
  "resume: /harness-delivery consumes the stop it is the exit for",
  mod.readStoppedPipelineFromBranch(branchArr) === null && sent.some((s) => s.includes("prompts/delivery.md")),
  `stopped=${JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr))} sent=${sent.length}`,
);

// A completed run must not leave a stop behind: that is what would keep the
// input hook pointing at a resume of a pipeline that already finished.
reset();
await new Promise((r) => setTimeout(r, 300));
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "a clean task", waitTurn);
check(
  "resume: a completed pipeline persists no stop",
  mod.readStoppedPipelineFromBranch(branchArr) === null &&
    notifies.some((n) => n.includes('finished: orchestrator -> explorer -> critic')),
  `stopped=${JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr))} ${notifies.join(" | ")}`,
);
reset();
const sentBeforeNothingToResume = sent.length;
await commands["harness-resume"].handler("", makeCtx(tmp, true));
check(
  "resume: /harness-resume with nothing stopped says so and runs nothing",
  sent.length === sentBeforeNothingToResume && notifies.some((n) => n.includes("No pipeline is waiting to be resumed")),
  notifies.join(" | "),
);
// A decision emitted by an attempt that then failed belongs to that attempt. The
// message_end hook only records a decision when the slot is empty and the slot
// was cleared per step, not per attempt, so the failed attempt's decision used to
// survive into its successful retry — and an orchestrator that said ANSWER_ONLY
// before erroring would route the retry into the analysis workflow.
reset();
assistantScript.push(
  { text: "This needs design.\n\nHARNESS-DECISION: ANSWER_ONLY", stopReason: "error" },
  "Recovered, but with no decision this time.",
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "leaky decision", waitTurn);
check(
  "resume: a failed attempt's decision does not leak into its retry",
  !sent.some((s) => s.includes("prompts/architecture.md")) &&
    !notifies.some((n) => n.includes('Routed to "analysis"')),
  `sent=${sent.length} ${notifies.join(" | ")}`,
);
check(
  "resume: the retry is judged on its own decision, so a silent retry fails closed",
  notifies.some((n) => n.includes("the orchestrator declared no decision")),
  notifies.join(" | "),
);

// --- REQ-014 / REQ-015: the tester step and the bounded repair round -------
//
// The round is driven from the `full` workflow, whose steps are
// orchestrator, explorer, critic, implementer, tester, delivery. A command that
// really exits 0 is used for the passing check, because the delivery gate
// re-runs every declared check: a scripted "passed" that never ran would be
// reported as contradicted and stop the run for the wrong reason.
const passingCommand = `${nodeExec} -e "process.exit(0)"`;
const reportWith = (checks, extra = {}) => ({
  name: "harness_report",
  params: { changed_files: [], checks, notes: "", lessons: [], ...extra },
});
const testerFailed = reportWith([{ command: passingCommand, result: "failed" }]);
const testerPassed = reportWith([{ command: passingCommand, result: "passed" }]);
// A scripted step owes a report like any other: `done` is the textual marker
// the harness falls back to when the turn did not call `harness_report`.
const said = (text) => `${text}\n\nHARNESS-DONE`;

await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory", workflow_mode: "full" }));

// One failed round, then green: the pipeline reaches delivery.
reset();
assistantScript.push(
  { text: "Plan.\n\nHARNESS-DECISION: PIPELINE" },
  { text: said("Found it.") },
  { text: said("Fine.") },
  { text: said("Implemented.") },
  { text: "A test fails.", tool: testerFailed },
  { text: said("Fixed the cause.") },
  { text: "Green.", tool: testerPassed },
  { text: said("Delivered.") },
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "repair round", waitTurn);
check(
  "round: one failed round returns to the implementer and then reaches delivery",
  sent.length === 8 &&
    sent[5].includes("prompts/implementer.md") &&
    sent[6].includes("prompts/tester.md") &&
    sent[7].includes("prompts/delivery.md"),
  `sent=${sent.length} ${sent.map((s) => (s.match(/prompts\/[\w-]+\.md/) ?? ["?"])[0]).join(",")}`,
);
// The failing command and its output reach the implementer as `{{previous}}`:
// the tester's reply is already what the driver hands to the next step.
check(
  "round: the implementer receives the tester's failure as {{previous}}",
  sent[5].includes("A test fails.") && !sent[5].includes("prompts/tester.md"),
  String(sent[5]).slice(-160),
);
check(
  "round: the explorer and the critic are not re-run",
  sent.filter((s) => s.includes("prompts/explorer.md")).length === 1 &&
    sent.filter((s) => s.includes("prompts/critic.md")).length === 1,
  sent.map((s) => (s.match(/prompts\/[\w-]+\.md/) ?? ["?"])[0]).join(","),
);
check(
  "round: a round that passes finishes the pipeline",
  notifies.some((n) => n.includes('Pipeline "full" finished')) &&
    notifies.some((n) => n.includes("Repair round 1/3")),
  notifies.join(" | "),
);

// Three rounds and the fourth failure is the answer: no delivery.
const exhaustScript = (extra = {}) => [
  { text: "Plan.\n\nHARNESS-DECISION: PIPELINE" },
  { text: said("Found it.") },
  { text: said("Fine.") },
  { text: said("Implemented.") },
  { text: "Round 1 failure.", tool: reportWith([{ command: passingCommand, result: "failed" }], extra) },
  { text: said("Fix 1.") },
  { text: "Round 2 failure.", tool: reportWith([{ command: passingCommand, result: "failed" }], extra) },
  { text: said("Fix 2.") },
  { text: "Round 3 failure.", tool: reportWith([{ command: passingCommand, result: "failed" }], extra) },
  { text: said("Fix 3.") },
  { text: "Round 4 failure.", tool: reportWith([{ command: passingCommand, result: "failed" }], extra) },
];

reset();
assistantScript.push(...exhaustScript());
await mod.runPipeline(fakePi, makeCtx(tmp, true), "rounds exhausted", waitTurn);
// orchestrator, explorer, critic, implementer, then (implementer, tester) x 4.
check(
  "round: three rounds bound the repair and delivery never runs",
  sent.length === 11 && !sent.some((s) => s.includes("prompts/delivery.md")),
  `sent=${sent.length}`,
);
check(
  "round: exhaustion names the bound and the failure as the final answer",
  notifies.some((n) => n.includes("stopped after 3 repair rounds")) &&
    notifies.some((n) => n.includes("there is no delivery")),
  notifies.join(" | "),
);
// The stop is terminal and deliberately not resumable: resuming would point at
// delivery, which is the one thing REQ-015 forbids after an exhausted round.
check(
  "round: exhaustion clears the stopped-pipeline record instead of offering a resume into delivery",
  mod.readStoppedPipelineFromBranch(branchArr) === null &&
    !notifies.some((n) => n.includes("/harness-resume")),
  `stopped=${JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr))} ${notifies.join(" | ")}`,
);

// The counter is the driver's. A tester that claims otherwise does not get a
// fourth round: the bound is unchanged because no tool writes it.
reset();
assistantScript.push(...exhaustScript({ repair_rounds: 99, reset: true }));
await mod.runPipeline(fakePi, makeCtx(tmp, true), "model tries to reset the counter", waitTurn);
check(
  "round: the model cannot reset the counter — extra fields in the report change nothing",
  sent.length === 11 && !sent.some((s) => s.includes("prompts/delivery.md")),
  `sent=${sent.length}`,
);

// A tester that declares nothing is not a failure: the pipeline proceeds, which
// is what `checks: []` has to mean for the workflow to be usable at all.
reset();
assistantScript.push(
  { text: "Plan.\n\nHARNESS-DECISION: PIPELINE" },
  { text: said("Found it.") },
  { text: said("Fine.") },
  { text: said("Implemented.") },
  { text: "Nothing to declare.", tool: reportWith([]) },
  { text: said("Delivered.") },
);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "no declared checks", waitTurn);
check(
  "round: a tester that declares no checks does not open a repair round",
  sent.length === 6 && sent[5].includes("prompts/delivery.md"),
  `sent=${sent.length}`,
);

// --- REQ-021: the step's own turn, not an idle session -------------------------
//
// The four command paths used to wait on `ctx.waitForIdle()`, which Pi answers
// immediately when the session is idle — before the sent turn exists — so every
// step read the previous assistant message and stopped. The driver now waits
// for a complete new assistant turn from a baseline taken before the send.
// These tests drive that wiring: a command context whose `waitForIdle` is a
// real no-op (exactly Pi's behaviour when idle) must still advance, and a wait
// that never sees a turn must stop with a name instead of reading a stale reply.
reset();
{
  const immediateCtx = makeCtx(tmp, true);
  immediateCtx.waitForIdle = async () => {};
  const immediateWait = (baseline) => mod.awaitStepTurn(immediateCtx, baseline);
  await mod.runPipeline(fakePi, immediateCtx, "req-021 idle command context", immediateWait);
  check(
    "wait: an immediately-idle command context still advances past the first step",
    sent.length === 6 && sent[1]?.includes("prompts/explorer.md") && sent[5]?.includes("prompts/delivery.md"),
    `sent=${sent.length}`,
  );
  check(
    "wait: advancing leaves no stop record",
    mod.readStoppedPipelineFromBranch(branchArr) === null,
    JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
  );
}

// A wait that never observes a turn ends the step with a named stop: the
// unstarted step is not recorded as completed, and the generic stop path keeps
// the run resumable instead of hanging.
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "req-021 no turn", async () => false);
check(
  "wait: a step that never produces a turn stops with a named message",
  notifies.some((n) => n.includes("did not produce a complete assistant turn")),
  notifies.join(" | ").slice(0, 200),
);
check(
  "wait: the unstarted step is not recorded as completed",
  (mod.readStoppedPipelineFromBranch(branchArr)?.completed.length ?? -1) === 0,
  JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
);

// The baseline is captured before the send: a turn delivered after the wait
// starts is still seen, and silence returns false on the bound instead of
// hanging. The small bound keeps this unit fast; production uses the default.
reset();
{
  const unitCtx = makeCtx(tmp, true);
  const base = mod.countAssistantMessages(unitCtx);
  fakePi.sendUserMessage("unit probe");
  const saw = await mod.awaitStepTurn(unitCtx, base);
  check("wait: a turn delivered after the call is still seen", saw === true, `saw=${saw}`);
}
reset();
{
  const boundCtx = makeCtx(tmp, true);
  const base = mod.countAssistantMessages(boundCtx);
  const started = Date.now();
  const saw = await mod.awaitStepTurn(boundCtx, base, 200);
  check(
    "wait: silence returns false on the bound instead of hanging",
    saw === false && Date.now() - started < 8000,
    `saw=${saw} elapsed=${Date.now() - started}`,
  );
}

// --- REQ-022: stop, end, and the mid-run refusal --------------------------------
//
// These tests drive the `input` hook, so they force auto-harness on: the
// config has carried `auto_harness: false` since the `input: auto off` case
// left it off and `baseCfg` was captured after that (every `forceFlags`
// rewrite since preserves it).
await fs.writeFile(cfgPath, (await fs.readFile(cfgPath, "utf8")).replace(/^ {2}auto_harness: .*$/m, "  auto_harness: true"));
//
// A stop is requested from inside a running turn through a scripted tool call
// on the explorer's turn, the same way waitTurnInjecting scripts tool calls:
// the tool executes while pipelineRunning is true, so the command handler sees
// a real run in flight. The abort seam is attached per test; production binds
// ctx.abort() to the Escape path.
reset();
{
  const stopCtx = makeCtx(tmp, true);
  stopCtx.abort = () => {
    aborts.push("stop");
  };
  tools["test-stop-hook"] = {
    execute: async () => {
      await commands["harness-stop"].handler("", stopCtx);
    },
  };
  assistantScript.push(
    "Plan.\n\nHARNESS-DECISION: PIPELINE",
    { text: "Exploring.\n\nHARNESS-DONE", tool: { name: "test-stop-hook", params: {} } },
  );
  await commands["harness-run"].handler("tarea con stop", makeCtx(tmp, true));
  delete tools["test-stop-hook"];
  const stopped = mod.readStoppedPipelineFromBranch(branchArr);
  check(
    "stop: a mid-run stop keeps a resumable record",
    stopped !== null && stopped.completed.join(",") === "orchestrator" && stopped.failedStep === "explorer",
    JSON.stringify(stopped),
  );
  check(
    "stop: the stop is announced as the user's, not a model failure",
    notifies.some((n) => n.includes("stopped by the user at step 2 (explorer)")),
    notifies.join(" | ").slice(0, 220),
  );
  check("stop: the in-flight turn was aborted", aborts.join(",") === "stop", aborts.join(","));
  check(
    "stop: no further steps ran after the stop",
    sent.length === 2 && sent[1]?.includes("prompts/explorer.md"),
    `sent=${sent.length}`,
  );
}

// Ending a run clears the record instead of writing one, and the next plain
// message is routed by the orchestrator rather than refused.
reset();
{
  const endCtx = makeCtx(tmp, true);
  endCtx.abort = () => {
    aborts.push("end");
  };
  tools["test-stop-hook"] = {
    execute: async () => {
      await commands["harness-end"].handler("", endCtx);
    },
  };
  assistantScript.push(
    "Plan.\n\nHARNESS-DECISION: PIPELINE",
    { text: "Exploring.\n\nHARNESS-DONE", tool: { name: "test-stop-hook", params: {} } },
  );
  await commands["harness-run"].handler("tarea con end", makeCtx(tmp, true));
  delete tools["test-stop-hook"];
  check(
    "end: a mid-run end clears the stopped record",
    mod.readStoppedPipelineFromBranch(branchArr) === null,
    JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
  );
  check(
    "end: the end is announced as returning control",
    notifies.some((n) => n.includes("ended by the user") && n.includes("orchestrator")),
    notifies.join(" | ").slice(0, 220),
  );
  sent.length = 0;
  notifies.length = 0;
  const routed = await events["input"]({ text: "siguiente tarea", source: "interactive" }, makeCtx(tmp, false));
  const deadline = Date.now() + 10000;
  while (!sent.some((s) => s.includes("prompts/orchestrator.md")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check(
    "end: the next plain message is routed by the orchestrator",
    routed.action === "handled" && sent.some((s) => s.includes("prompts/orchestrator.md")),
    `action=${routed.action} sent=${sent.length}`,
  );
  const settled = Date.now() + 15000;
  while (sent.filter((s) => s.startsWith("[harness] step")).length < 6 && Date.now() < settled) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// /harness-end with only a recorded stop clears it without running anything.
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea que se para", async () => false);
check(
  "end: precondition holds, a stop is recorded",
  mod.readStoppedPipelineFromBranch(branchArr) !== null,
  JSON.stringify(mod.readStoppedPipelineFromBranch(branchArr)),
);
const stepsBeforeEnd = sent.length;
await commands["harness-end"].handler("", makeCtx(tmp, true));
check(
  "end: clears a previous record and runs nothing",
  mod.readStoppedPipelineFromBranch(branchArr) === null &&
    notifies.some((n) => n.includes("Stopped pipeline discarded")) &&
    sent.length === stepsBeforeEnd,
  `sent=${sent.length} before=${stepsBeforeEnd} ${notifies.join(" | ").slice(0, 200)}`,
);

// A plain message while a pipeline streams is refused before the steering
// pass-through, so it never reaches the current step's model; slash commands
// still reach their handlers.
reset();
{
  const first = await events["input"]({ text: "tarea larga", source: "interactive" }, makeCtx(tmp, false));
  const refused = await events["input"](
    { text: "oye, para un momento", source: "interactive", streamingBehavior: "steer" },
    makeCtx(tmp, false),
  );
  check(
    "run: a plain message while streaming is refused",
    first.action === "handled" &&
      refused.action === "handled" &&
      notifies.some((n) => n.includes("/harness-stop") && n.includes("/harness-end")),
    `first=${first.action} refused=${refused.action}`,
  );
  check(
    "run: the refused message never reaches a step",
    !sent.some((s) => s.includes("oye, para un momento")),
    `sent=${sent.length}`,
  );
  const slash = await events["input"](
    { text: "/harness-mode", source: "interactive", streamingBehavior: "steer" },
    makeCtx(tmp, false),
  );
  check("run: slash commands still reach their handlers", slash.action === "continue", `slash=${slash.action}`);
  const done = Date.now() + 15000;
  while (sent.filter((s) => s.startsWith("[harness] step")).length < 6 && Date.now() < done) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
