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
  .replace(/^ {2}workflow_mode: .*$/m, "  workflow_mode: simple")
  .replace(/^ {2}auto_harness: .*$/m, "  auto_harness: true")
  .replace(/^ {2}question_short_circuit: .*$/m, "  question_short_circuit: true")
  .replace(/^ {2}allow_dispatch: .*$/m, "  allow_dispatch: true")
  .replace(/^ {2}strict_decision_marker: .*$/m, "  strict_decision_marker: true")
  .replace(/^ {2}preflight_policy: .*$/m, "  preflight_policy: advisory")
  // Keep the smoke test independent of the operator's live model choices.
  .replace(/^ {4}model: .*$/gm, "    model: opencode-go/gpt-5.1")
  .replace(/(^ {2}orchestrator:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^ {2}explorer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}critic:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^ {2}implementer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}delivery:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1low");
await fs.writeFile(cfgPath, cfgText);
await fs.cp(path.join(ROOT, "prompts"), path.join(tmp, "prompts"), { recursive: true });
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
/** Tool call to emit on the next assistant turn: { name, params, text }. */
let pendingToolCall = null;
let assistantTextOverride = null;
let turnN = 0;
let assistantTurns = 0;
let idle = true;
let activeCtx = null;

const nextAssistantText = (turn = 0) => {
  if (assistantScript.length > 0) return assistantScript.shift();
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
  sendUserMessage: (text) => {
    sent.push(text);
    branchArr.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    idle = false;
    setTimeout(async () => {
      assistantTurns++;
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
      let message = {
        role: "assistant",
        stopReason: "end",
        content: [{ type: "text", text: nextAssistantText(assistantTurns) }],
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
    ...(isCommand ? { waitForIdle: async () => {} } : {}),
  };
  activeCtx = ctx;
  return ctx;
};

await mod.default(fakePi);

const waitTurn = async () => {
  await new Promise((r) => setTimeout(r, 140));
};
const reset = () => {
  sent.length = 0;
  notifies.length = 0;
  statuses.length = 0;
  setModelCalls.length = 0;
  thinkingCalls.length = 0;
  assistantScript.length = 0;
  assistantTextOverride = null;
  assistantTurns = 0;
  pendingToolCall = null;
  toolErrors.length = 0;
};

// --- registration ------------------------------------------------------------
check(
  "factory registers commands",
  ["harness-config", "harness-mode", "harness-model", "harness-run", "harness-delivery", "harness-auto"].every((c) => c in commands),
  Object.keys(commands).join(","),
);
check(
  "factory registers session_start + input + message_end",
  "session_start" in events && "input" in events && "message_end" in events,
);
check("factory registers dispatch tool", !!tools["harness-dispatch"] && typeof tools["harness-dispatch"].execute === "function");

// --- helpers -----------------------------------------------------------------
const lines = cfgText.split(/\r?\n/);

check("getWorkflowSteps(simple)", JSON.stringify(mod.getWorkflowSteps(lines, "simple")) === '["orchestrator","implementer"]');
check("getWorkflowSteps(full-dry-run)", JSON.stringify(mod.getWorkflowSteps(lines, "full-dry-run")) === '["orchestrator","explorer","critic"]');
check("getWorkflowSteps(missing) -> null", mod.getWorkflowSteps(lines, "nope") === null);
check("isAutoHarness true", mod.isAutoHarness(lines) === true);
check(
  "setAutoHarness off/on roundtrip",
  mod.isAutoHarness(mod.setAutoHarness(lines, false)) === false &&
    mod.isAutoHarness(mod.setAutoHarness(mod.setAutoHarness(lines, false), true)) === true,
);
check("isQuestionShortCircuit default true", mod.isQuestionShortCircuit(lines.filter((l) => !l.startsWith("  question_short_circuit:"))) === true);
check("isQuestionShortCircuit false when set", mod.isQuestionShortCircuit(lines.map((l) => (l.startsWith("  question_short_circuit:") ? "  question_short_circuit: false" : l))) === false);
check("isAllowDispatch true", mod.isAllowDispatch(lines) === true);
check("getDefaultString reads a configured key", mod.getDefaultString(lines, "workflow_mode", "fallback") === "simple");
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
  checks.some((c) => c.label.includes('workflows has an entry for mode "simple"')) &&
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

check("pipeline: 2 prompts sent", sent.length === 2, `got ${sent.length}`);
check(
  "pipeline: step1 pointer names template, body hidden",
  sent[0]?.includes("prompts/orchestrator.md") &&
    sent[0]?.includes("add a dark mode toggle") &&
    !sent[0]?.includes("# Orchestrator"),
  String(sent[0]).slice(0, 90),
);
check(
  "pipeline: step2 pointer names template, body hidden",
  sent[1]?.includes("prompts/implementer.md") &&
    sent[1]?.includes("add a dark mode toggle") &&
    !sent[1]?.includes("# Implementer"),
  String(sent[1]).slice(0, 90),
);

const implMatch = /^ {4}model:\s*(\S+)/m.exec(cfgText.slice(cfgText.indexOf("  implementer:")));
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
  "pipeline: step1 shows no invented total, step2 shows 2/2",
  statuses.includes("harness: simple · orchestrator · auto: on") &&
    statuses.includes("harness: simple · 2/2 implementer · decision: pipeline · auto: on"),
  statuses.join(" | "),
);
check("pipeline: footer ends at mode + decision + auto", statuses.at(-1) === "harness: simple · decision: pipeline · auto: on", String(statuses.at(-1)));
check("pipeline: finished info (report present, no repair)", notifies.some((n) => n.includes('Pipeline "simple" finished: orchestrator -> implementer')), notifies.join(" | "));

reset();
const implementerReasoningBlock = /(^  implementer:\n    model: )opencode-go\/gpt-5\.1(\n    reasoning: )high/m;
const cfgUnsupportedEffort = cfgText.replace(
  implementerReasoningBlock,
  "$1opencode-go/deepseek-v4.1-flash$2high",
);
await fs.writeFile(cfgPath, cfgUnsupportedEffort);
await mod.runPipeline(fakePi, makeCtx(tmp, true), "unsupported effort", waitTurn);
check(
  "pipeline: unsupported model effort warns and is not applied",
  JSON.stringify(thinkingCalls) === JSON.stringify(["medium", "high"]) &&
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
  JSON.stringify(thinkingCalls) === JSON.stringify(["medium", "high"]),
  JSON.stringify(thinkingCalls),
);
await fs.writeFile(cfgPath, cfgText);

// --- footer refresh: session_start + /harness-auto toggle --------------------
await events["session_start"]({}, makeCtx(tmp, false));
check("session_start: footer shows mode + auto", statuses.at(-1) === "harness: simple · auto: on", String(statuses.at(-1)));
check("session_start: decision segment cleared", !String(statuses.at(-1)).includes("decision:"));

await commands["harness-auto"].handler("off", makeCtx(tmp, true));
check("/harness-auto off: footer refreshed", statuses.at(-1) === "harness: simple · auto: off", String(statuses.at(-1)));
await commands["harness-auto"].handler("on", makeCtx(tmp, true));
check("/harness-auto on: footer refreshed", statuses.at(-1) === "harness: simple · auto: on", String(statuses.at(-1)));

// --- question short-circuit: state path (message_end strips the marker) ------
reset();
assistantTextOverride = "Direct answer to the question.\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿cómo funciona el harness?", waitTurn);
check("short-circuit: ANSWER_ONLY stops after orchestrator", sent.length === 1, `got ${sent.length}`);
check("short-circuit: reports direct answer", notifies.some((n) => n.includes("orchestrator answered directly")), notifies.join(" | "));
check("short-circuit: no stopped-pipeline warning", !notifies.some((n) => n.startsWith("[warning]") && n.includes("stopped")), notifies.join(" | "));

const lastAssistant = [...branchArr].reverse().find((e) => e.type === "message" && e.message.role === "assistant");
check("decision stripped from the visible reply", !JSON.stringify(lastAssistant).includes("HARNESS-DECISION"));
check("footer shows the recorded decision", statuses.some((s) => String(s).includes("decision: answer_only")), statuses.slice(-3).join(" | "));
check(
  "question run ends at 1/1 orchestrator",
  statuses.at(-1) === "harness: simple · 1/1 orchestrator · decision: answer_only · auto: on",
  String(statuses.at(-1)),
);

reset();
assistantTextOverride = "Plan.\n\nHARNESS-DONE\n\nHARNESS-DECISION: PIPELINE";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "implementa la feature", waitTurn);
check("short-circuit: PIPELINE runs all steps", sent.length === 2, `got ${sent.length}`);
check(
  "pipeline run shows 1/2 orchestrator once decided",
  statuses.includes("harness: simple · 1/2 orchestrator · decision: pipeline · auto: on"),
  statuses.join(" | "),
);

// flag disabled -> ANSWER_ONLY does not stop the pipeline
const cfgTextShort = await fs.readFile(cfgPath, "utf8");
await fs.writeFile(cfgPath, cfgTextShort.replace("  question_short_circuit: true", "  question_short_circuit: false"));
reset();
assistantTextOverride = "Direct answer.\n\nHARNESS-DONE\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿otra pregunta?", waitTurn);
check("short-circuit: disabled flag runs all steps", sent.length === 2, `got ${sent.length}`);
await fs.writeFile(cfgPath, cfgTextShort);
assistantTextOverride = null;

// --- short-circuit: text fallback (no message_end handler) -------------------
const savedMessageEnd = events["message_end"];
delete events["message_end"];
reset();
assistantTextOverride = "Direct answer.\n\nHARNESS-DECISION: ANSWER_ONLY";
await mod.runPipeline(fakePi, makeCtx(tmp, true), "¿fallback?", waitTurn);
check("short-circuit: text fallback works without message_end", sent.length === 1, `got ${sent.length}`);
check(
  "fallback run ends at 1/1 orchestrator (finally path)",
  statuses.at(-1) === "harness: simple · 1/1 orchestrator · auto: on",
  String(statuses.at(-1)),
);
events["message_end"] = savedMessageEnd;
assistantTextOverride = null;

// --- final-report guarantee (fallo 1) ---------------------------------------
// Case 1: final step carries HARNESS-DONE -> no repair turn.
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task one", waitTurn);
check("report: marker present -> no repair turn", sent.length === 2, `got ${sent.length}`);
check("report: finished as info", notifies.some((n) => n.startsWith("[info]") && n.includes("finished:")), notifies.join(" | "));

// Case 2: final step omits it -> exactly one repair turn, then compliance.
reset();
assistantScript.push("orchestrator output\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("implementer output sin marca");
assistantScript.push("### Changes\n- none\n\n### Evidence\n- test\n\n### Notes for delivery\n- none\n\nHARNESS-DONE");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task two", waitTurn);
check("report: missing marker -> exactly one repair turn", sent.length === 3, `got ${sent.length}`);
check("report: repair prompt demands HARNESS-DONE", sent[2]?.includes("HARNESS-DONE"), String(sent[2]).slice(0, 60));
check(
  "report: repaired -> finish info, no missing-report warning",
  notifies.some((n) => n.startsWith("[info]") && n.includes("finished:")) && !notifies.some((n) => n.includes("final report is missing")),
  notifies.join(" | "),
);

// Case 3: repair also omits it -> warning, still only one repair turn.
reset();
assistantScript.push("orchestrator output\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("implementer sin marca");
assistantScript.push("reparación sin marca");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task three", waitTurn);
check("report: repair fails -> warning", notifies.some((n) => n.startsWith("[warning]") && n.includes("report is missing")), notifies.join(" | "));
check("report: still only one repair turn", sent.length === 3, `got ${sent.length}`);
check(
  "report: repair failure names the step and stops the pipeline",
  notifies.some((n) => n.includes("did not report") && n.includes("implementer")),
  notifies.join(" | "),
);

// Decision segment clears again on session_start.
statuses.length = 0;
await events["session_start"]({}, makeCtx(tmp, false));
check("session_start after run: footer has no decision", statuses.at(-1) === "harness: simple · auto: on", String(statuses.at(-1)));

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

const cfgUnsupported = cfgOriginal
  .replace("    model: opencode-go/gpt-5.1\n    reasoning: high", "    model: opencode-go/deepseek-v4.1-flash\n    reasoning: high");
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
check("input: pipeline ran detached (2 prompts)", sent.length === 2, `got ${sent.length}`);
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
assistantTextOverride = 'If it had written "HARNESS-DECISION: ANSWER_ONLY" I would stop, but it did not.';
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: a quoted marker does not decide", sent.length === 1, `got ${sent.length}`);

await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: false }));
reset();
await mod.runPipeline(fakePi, makeCtx(tmp, true), "pregunta", waitTurn);
check("strict: disabled keeps the previous fail-open behaviour", sent.length === 2, `got ${sent.length}`);

// P0-3: an intermediate step owes its report too.
await fs.writeFile(cfgPath, forceFlags(baseCfg, { strict_decision_marker: true, preflight_policy: "advisory" }));
reset();
assistantScript.push("Plan.\n\nHARNESS-DECISION: PIPELINE");
assistantScript.push("explorer sin informe");
assistantScript.push("el explorador sigue sin informe");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "tarea", waitTurn, "full-dry-run");
check("report: an intermediate step is verified", sent.length === 3, `got ${sent.length}`);
check("report: the repair prompt names the step", sent[2]?.includes('"explorer"'), String(sent[2]).slice(0, 90));
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
  await fs.writeFile(path.join(gateRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "blocking" }));
  await fs.cp(path.join(ROOT, "prompts"), path.join(gateRepo, "prompts"), { recursive: true });
  await fs.writeFile(path.join(gateRepo, "uncommitted.txt"), "work in progress\n");
  gateReady = true;
} catch {
  gateReady = false;
}

if (gateReady) {
  reset();
  assistantTextOverride = "Plan.\n\nHARNESS-DECISION: PIPELINE";
  const noUiGate = makeCtx(gateRepo, true);
  noUiGate.hasUI = false;
  await mod.runPipeline(fakePi, noUiGate, "tarea", waitTurn);
  check("preflight: blocking stops the file-mutating step", sent.length === 1, `got ${sent.length}`);
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
    confirms === 1 && sent.length === 5,
    `confirms=${confirms} prompts=${sent.length}`,
  );

  await fs.writeFile(path.join(gateRepo, "harness.config.yaml"), forceFlags(baseCfg, { preflight_policy: "advisory" }));
  reset();
  const advisoryGate = makeCtx(gateRepo, true);
  advisoryGate.ui.confirm = async () => {
    confirms++;
    return false;
  };
  await mod.runPipeline(fakePi, advisoryGate, "tarea", waitTurn);
  check(
    "preflight: advisory only warns and never asks",
    sent.length === 2 && confirms === 1 && notifies.some((n) => n.includes("uncommitted changes")),
    `prompts=${sent.length} confirms=${confirms} ${notifies.join(" | ")}`,
  );
} else {
  console.log("SKIP preflight gate tests: git is unavailable in this environment");
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
check("tool: a decision call runs the whole pipeline", sent.length === 2, `got ${sent.length}`);
check("tool: no repair turn when the decision came from the tool", !sent.some((s) => s.includes("no usable decision")), sent.length + "");
check(
  "tool: the reason is surfaced for the operator",
  notifies.some((n) => n.includes("Orchestrator decision: pipeline") && n.includes("files must change")),
  notifies.join(" | "),
);
check("tool: sloppy casing is accepted", toolErrors.length === 0, toolErrors.join(" | "));

// ANSWER_ONLY through the tool short-circuits exactly like the marker.
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" } };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "una pregunta", waitTurn);
check("tool: ANSWER_ONLY short-circuits after step 1", sent.length === 1, `got ${sent.length}`);
check(
  "tool: short-circuit footer shows 1/1 with the decision",
  statuses.at(-1)?.includes("1/1 orchestrator") && statuses.at(-1)?.includes("decision: answer_only"),
  String(statuses.at(-1)),
);

// The tool wins over a contradicting marker, thanks to the runtime ordering:
// message_end (which reads the marker) runs BEFORE the tool executes.
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" }, text: "Done.\n\nHARNESS-DECISION: PIPELINE" };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "contradicción", waitTurn);
check("tool: the tool beats a contradicting marker in the same message", sent.length === 1, `got ${sent.length}`);

// Lowercase decision must not stop the pipeline (the enum trap the critic flagged).
reset();
pendingToolCall = { name: "harness_decision", params: { decision: "answer_only" }, text: "Done.\n\nHARNESS-DECISION: PIPELINE" };
await mod.runPipeline(fakePi, makeCtx(tmp, true), "contradicción invertida", waitTurn);
check("tool: lowercase decision is normalized, not rejected", sent.length === 1 && toolErrors.length === 0, `sent=${sent.length} ${toolErrors.join("|")}`);

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
check("report tool: a harness_report call satisfies the step with no marker", sent.length === 2, `got ${sent.length}`);
check(
  "report tool: no repair turn and no missing-report warning",
  !notifies.some((n) => n.includes("did not report")) && !notifies.some((n) => n.includes("report is missing")),
  notifies.join(" | "),
);

// --- exploration and memory are reachable in the default mode ---------------

const cfgLines = (await fs.readFile(cfgPath, "utf8")).split("\n");
const simpleSteps = mod.getWorkflowSteps(cfgLines, "simple") ?? [];
const implementerTools = mod.getAgentTools(cfgLines, "implementer");
check(
  "config: the implementer of the default mode is granted codegraph",
  simpleSteps.includes("implementer") && implementerTools.includes("codegraph"),
  `simple=${simpleSteps.join("->")} tools=${implementerTools.join(",")}`,
);
check(
  "config: the orchestrator, which runs in every mode, is granted codegraph too",
  mod.getAgentTools(cfgLines, "orchestrator").includes("codegraph"),
  mod.getAgentTools(cfgLines, "orchestrator").join(","),
);
check(
  "config: engram stays with the agents that record findings",
  ["orchestrator", "explorer", "implementer"].every((a) => mod.getAgentTools(cfgLines, a).includes("engram")),
);
check(
  "config: an agent without a tools list still resolves to no tools (backward compatibility)",
  JSON.stringify(mod.getAgentTools(["agents:", "  x:", "    model: p/m"], "x")) === "[]" &&
    JSON.stringify(mod.getAgentTools(cfgLines, "no-such-agent")) === "[]",
);
// The example config is what `init` copies into an adopting project.
const exampleLines = (await fs.readFile(path.join(ROOT, "harness.config.example.yaml"), "utf8")).split("\n");
check(
  "config: the shipped example grants codegraph to the implementer of the default mode too",
  (mod.getWorkflowSteps(exampleLines, "simple") ?? []).includes("implementer") &&
    mod.getAgentTools(exampleLines, "implementer").includes("codegraph") &&
    mod.getAgentTools(exampleLines, "orchestrator").includes("codegraph"),
  mod.getAgentTools(exampleLines, "implementer").join(","),
);

// The rendered prompt is what the model actually reads: the dependency check
// and the memory write have to survive rendering, not just live in the file.
const implementerPrompt = mod.renderPrompt(
  await fs.readFile(path.join(ROOT, "prompts", "implementer.md"), "utf8"),
  { task: "tarea", mode: "simple", agent: "implementer", step: "2", steps: "2", previous: "" },
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
  "prompt: the orchestrator and explorer record findings with mem_save too",
  (await fs.readFile(path.join(ROOT, "prompts", "orchestrator.md"), "utf8")).includes("mem_save") &&
    (await fs.readFile(path.join(ROOT, "prompts", "explorer.md"), "utf8")).includes("mem_save"),
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
check("lessons: a report missing lessons earns exactly one repair turn", sent.length === 3, `got ${sent.length}`);
check("lessons: the repair prompt names the missing field", sent[2]?.includes("lessons"), String(sent[2]).slice(0, 200));
check(
  "lessons: the completed repair finishes the pipeline",
  notifies.some((n) => n.includes("finished: orchestrator -> implementer")) && !notifies.some((n) => n.includes("did not report")),
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
  "report: a stale report from the orchestrator does not satisfy the implementer",
  sent.length === 3,
  `got ${sent.length}`,
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
