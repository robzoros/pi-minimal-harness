/**
 * Smoke test for .pi/extensions/harness.ts (project-local Pi extension).
 *
 * Run with:  node tests/harness.test.mjs
 *
 * Drives the registered commands, events and tool with fakes and asserts the
 * pipeline, footer status, question short-circuit, final-report guarantee,
 * decision handling, validation and the dispatch seams. Never touches the real
 * harness.config.yaml: everything runs against a temp copy of the project.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(`file://${ROOT}/.pi/extensions/harness.ts`);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// --- temp project: config (forced state) + prompts + contract ---------------
const tmp = await fs.mkdtemp(path.join("/tmp", "harness-test-"));
const cfgPath = path.join(tmp, "harness.config.yaml");
let cfgText = await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8");
// Force the flags this test depends on, so it never depends on live config state.
cfgText = cfgText
  .replace(/^ {2}workflow_mode: .*$/m, "  workflow_mode: simple")
  .replace(/^ {2}auto_harness: .*$/m, "  auto_harness: true")
  .replace(/^ {2}question_short_circuit: .*$/m, "  question_short_circuit: true")
  .replace(/^ {2}allow_dispatch: .*$/m, "  allow_dispatch: true")
  // Keep the smoke test independent of the operator's live model choices.
  .replace(/^ {4}model: .*$/gm, "    model: opencode-go/gpt-5.1")
  .replace(/(^ {2}orchestrator:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^ {2}explorer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}critic:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1medium")
  .replace(/(^ {2}implementer:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1high")
  .replace(/(^ {2}delivery:\n {4}model: .*\n {4}reasoning: ).*$/m, "$1low");
await fs.writeFile(cfgPath, cfgText);
await fs.cp(path.join(ROOT, "prompts"), path.join(tmp, "prompts"), { recursive: true });
await fs.copyFile(path.join(ROOT, "AGENTS-addition.md"), path.join(tmp, "AGENTS-addition.md"));

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
let assistantTextOverride = null;
let turnN = 0;
let idle = true;
let activeCtx = null;

const nextAssistantText = () => {
  if (assistantScript.length > 0) return assistantScript.shift();
  if (assistantTextOverride) return assistantTextOverride;
  turnN++;
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
      let message = {
        role: "assistant",
        stopReason: "end",
        content: [{ type: "text", text: nextAssistantText() }],
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
check("getDefaultString reads subagent_context_file", mod.getDefaultString(lines, "subagent_context_file", "fallback") === "AGENTS-addition.md");
check("getDefaultString fallback", mod.getDefaultString(lines, "no_such_key", "fallback") === "fallback");
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
  "renderPrompt placeholders",
  mod.renderPrompt("Task: {{task}} mode={{mode}} agent={{agent}} step={{step}}/{{steps}} prev={{previous}}", {
    task: "X", mode: "full", agent: "a", step: "1", steps: "5", previous: "p",
  }) === "Task: X mode=full agent=a step=1/5 prev=p",
);
check("renderPrompt appends missing {{task}}", mod.renderPrompt("No task here", { task: "T" }).endsWith("## Task\nT"));

// --- validation --------------------------------------------------------------
const checks = await mod.validate(lines, cfgPath, tmp);
const failed = checks.filter((c) => !c.ok);
check("validate: 0 failures", failed.length === 0, failed.map((f) => `${f.label} [${f.detail ?? ""}]`).join("; "));
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
check("validate includes context-file check (present)", checks.some((c) => c.label.includes("subagent_context_file") && c.ok));
await fs.rm(path.join(tmp, "AGENTS-addition.md"));
const checksMissing = await mod.validate(lines, cfgPath, tmp);
const missingCheck = checksMissing.find((c) => c.label.includes("subagent_context_file"));
check("validate: context-file missing -> fail", !!missingCheck && missingCheck.ok === false);
await fs.copyFile(path.join(ROOT, "AGENTS-addition.md"), path.join(tmp, "AGENTS-addition.md"));

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
    statuses.includes("harness: simple · 2/2 implementer · auto: on"),
  statuses.join(" | "),
);
check("pipeline: footer ends at mode + auto", statuses.at(-1) === "harness: simple · auto: on", String(statuses.at(-1)));
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
assistantTextOverride = "Plan.\n\nHARNESS-DECISION: PIPELINE\n\nHARNESS-DONE";
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
assistantTextOverride = "Direct answer.\n\nHARNESS-DECISION: ANSWER_ONLY\n\nHARNESS-DONE";
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
assistantScript.push("orchestrator output");
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
assistantScript.push("orchestrator output");
assistantScript.push("implementer sin marca");
assistantScript.push("reparación sin marca");
await mod.runPipeline(fakePi, makeCtx(tmp, true), "task three", waitTurn);
check("report: repair fails -> warning", notifies.some((n) => n.startsWith("[warning]") && n.includes("final report is missing")), notifies.join(" | "));
check("report: still only one repair turn", sent.length === 3, `got ${sent.length}`);

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
const tool = tools["harness-dispatch"];
const cfgOriginal = await fs.readFile(cfgPath, "utf8");
await fs.writeFile(cfgPath, cfgOriginal.replace("  allow_dispatch: true", "  allow_dispatch: false"));
const rDisabled = await tool.execute("t1", { tasks: [{ agent: "explorer", brief: "x" }] }, undefined, undefined, makeCtx(tmp, false));
check("dispatch: disabled gate", rDisabled.isError === true && rDisabled.content[0].text.includes("disabled"), rDisabled.content[0].text);
await fs.writeFile(cfgPath, cfgOriginal);

const rUnknown = await tool.execute("t2", { tasks: [{ agent: "nope", brief: "x" }] }, undefined, undefined, makeCtx(tmp, false));
check("dispatch: unknown agent rejected", rUnknown.isError === true && rUnknown.content[0].text.includes("Unknown agent"), rUnknown.content[0].text);

const rEmpty = await tool.execute("t3", { tasks: [{ agent: "explorer", brief: "   " }] }, undefined, undefined, makeCtx(tmp, false));
check("dispatch: empty brief rejected", rEmpty.isError === true && rEmpty.content[0].text.toLowerCase().includes("empty brief"), rEmpty.content[0].text);

const cfgUnsupported = cfgOriginal
  .replace("    model: opencode-go/gpt-5.1\n    reasoning: high", "    model: opencode-go/deepseek-v4.1-flash\n    reasoning: high");
await fs.writeFile(cfgPath, cfgUnsupported);
const rUnsupported = await tool.execute("t5", { tasks: [{ agent: "explorer", brief: "x" }] }, undefined, undefined, makeCtx(tmp, false));
check(
  "dispatch: unsupported model effort rejected",
  rUnsupported.isError === true && rUnsupported.content[0].text.includes("not supported") && rUnsupported.content[0].text.includes("Available: off"),
  rUnsupported.content[0].text,
);
await fs.writeFile(cfgPath, cfgOriginal);

const noUiCtx = makeCtx(tmp, false);
noUiCtx.hasUI = false;
const rNoUi = await tool.execute("t4", { tasks: [{ agent: "nope", brief: "x" }] }, undefined, undefined, noUiCtx);
check("dispatch: works with hasUI false", rNoUi.isError === true);
check("dispatch: no widget written by gate failures", widgets.length === 0, `widgets=${widgets.length}`);

// --- auto-harness input hook -------------------------------------------------
notifies.length = 0;
sent.length = 0;
setModelCalls.length = 0;
assistantScript.length = 0;
assistantTextOverride = null;

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

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
