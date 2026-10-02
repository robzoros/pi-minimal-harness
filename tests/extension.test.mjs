/**
 * Loads the extension the way Pi does.
 *
 * This file exists because of a shipped bug: `.pi/extensions/harness.ts` was
 * rewritten and nothing imported it — the only suite that had ever done so was
 * the v1 smoke test, which Phase 5 deleted. Three template literals lost their
 * backticks, Pi refused to load the extension, and every test in the project
 * stayed green because the extension was the one file nothing read.
 *
 * A test that imports the entry point and drives its registered commands and
 * hooks with fakes is what makes that class of breakage impossible again.
 *
 * Run with:  node tests/extension.test.mjs
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

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

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// --- it loads at all --------------------------------------------------------

const mod = await import(pathToFileURL(path.join(ROOT, ".pi", "extensions", "harness.ts")).href);
check("the extension module loads", typeof mod.default === "function");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-ext-"));
await fs.copyFile(path.join(ROOT, "harness.config.yaml"), path.join(tmp, "harness.config.yaml"));

// --- fakes -----------------------------------------------------------------

function makeCtx(over = {}) {
  const mode = over.mode ?? "tui";
  const notifications = [];
  const statuses = new Map();
  const selects = [];
  const inputs = [];
  return {
    notifications,
    statuses,
    selects,
    inputs,
    cwd: tmp,
    mode,
    hasUI: mode !== "json" && mode !== "print",
    ui: {
      notify: (m, level) => notifications.push([level ?? "info", m]),
      setStatus: (k, v) => statuses.set(k, v),
      select: async (title, options) => {
        selects.push([title, options]);
        return options[0];
      },
      input: async (title) => {
        inputs.push(title);
        return "the plan needs one more thing";
      },
    },
    sessionManager: { getBranch: () => over.branch ?? [] },
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    ...over,
  };
}

function makePi() {
  const commands = new Map();
  const hooks = new Map();
  const entries = [];
  const statuses = new Map();
  return {
    commands,
    hooks,
    entries,
    statuses,
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool: () => {},
    getAllTools: () => [{ name: "read" }],
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    // NO `ui` on purpose. ExtensionAPI has no such member — setStatus belongs
    // to the event context's UI. A fake that invents one hides a crash that
    // Pi then throws on the first /reload.
  };
}

/** Shorthand for a registered event handler. */
const on = (pi, event) => pi.hooks.get(event);

const withExtension = async () => {
  const pi = makePi();
  await mod.default(pi);
  return pi;
};

// --- the factory registers what Pi needs ----------------------------------

{
  const pi = await withExtension();
  const expected = ["harness-run", "harness-answer", "harness-status", "harness-config", "harness-model"];
  check("it registers the five commands",
    expected.every((c) => pi.commands.has(c)),
    [...pi.commands.keys()].join(","));
  check("it registers no v1 command",
    !["harness-mode", "harness-delivery"].some((c) => pi.commands.has(c)),
    [...pi.commands.keys()].join(","));
  check("it offers a way to stop a running workflow", pi.commands.has("harness-abort"), [...pi.commands.keys()].join(","));
  check("every command has a description",
    [...pi.commands.values()].every((c) => typeof c.description === "string" && c.description.length > 0));
  check("it registers the session_start and input hooks",
    on(pi, "session_start") !== undefined && on(pi, "input") !== undefined, [...pi.hooks.keys()].join(","));
}

// --- session_start restores a suspension ----------------------------------

{
  const pi = await withExtension();
  const ctx = makeCtx();
  const payload = {
    schema: 2,
    phase: "SUSPENDED",
    runId: "run-9",
    task: "add the thing",
    retry: 0,
    maxRetries: 3,
    reason: "awaiting_approval",
    resumeState: "PLANNING",
    resumeAgent: "planner",
    question: { topic: "approval", question: "approve?" },
  };
  ctx.sessionManager = { getBranch: () => [{ type: "custom", customType: "pi-minimal-harness:suspended", data: payload }] };
  await pi.hooks.get("session_start")({}, ctx);
  check("session_start restores a pending suspension", ctx.statuses.get("pi-minimal-harness")?.includes("SUSPENDED"),
    ctx.statuses.get("pi-minimal-harness"));
  check("and shows the reason", ctx.statuses.get("pi-minimal-harness")?.includes("awaiting_approval"),
    ctx.statuses.get("pi-minimal-harness"));
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.hooks.get("session_start")({}, ctx);
  check("an empty session shows no status", ctx.statuses.get("pi-minimal-harness") === undefined);
}

// --- the input hook's ordering, which is the whole point -------------------

{
  const pi = await withExtension();
  const ctx = makeCtx();
  const run = async (text, phase) => {
    // drive a suspension into the extension by restoring one first
    const payload = {
      schema: 2, phase: "SUSPENDED", runId: "r", task: "t", retry: 0, maxRetries: 3,
      reason: "awaiting_approval", resumeState: "PLANNING", resumeAgent: "planner",
      question: { topic: "approval", question: "approve?" },
    };
    ctx.sessionManager = { getBranch: () => (phase ? [{ type: "custom", customType: "pi-minimal-harness:suspended", data: payload }] : []) };
    await pi.hooks.get("session_start")({}, ctx);
    return pi.hooks.get("input")({ source: "interactive", text }, ctx);
  };

  const handled = await run("looks good to me", true);
  check("a reply to a waiting workflow is consumed, not treated as a new task", handled.action === "handled", handled.action);
  // The regression that stranded the user: a three-option menu for a plan
  // awaiting approval. Whatever the user typed IS the answer, so neither a
  // menu nor an extra prompt may appear.
  for (let i = 0; i < 30 && ctx.notifications.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  check("a reply with text opens no menu and no extra prompt",
    ctx.selects.length === 0 && ctx.inputs.length === 0,
    `selects=${ctx.selects.length} inputs=${ctx.inputs.length}`);
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  const result = await pi.hooks.get("input")({ source: "interactive", text: "just chatting" }, ctx);
  check("with auto_start on, a plain request starts a workflow", result.action === "handled", result.action);
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await fs.writeFile(path.join(tmp, "harness.config.yaml"),
    (await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8")).replace("  auto_start: true", "  auto_start: false"), "utf8");
  const result = await pi.hooks.get("input")({ source: "interactive", text: "just chatting" }, ctx);
  check("with auto_start off, it is left to the model", result.action === "continue", result.action);
  await fs.copyFile(path.join(ROOT, "harness.config.yaml"), path.join(tmp, "harness.config.yaml"));
}
{
  // The regression that swallowed every subagent's prompt.
  const pi = await withExtension();
  for (const mode of ["json", "print"]) {
    const ctx = makeCtx({ mode });
    const result = await pi.hooks.get("input")({ source: "interactive", text: "Reply with JSON" }, ctx);
    check(`a one-shot ${mode} session keeps its prompt`, result.action === "continue", result.action);
  }
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  check("a slash command is never intercepted", (await pi.hooks.get("input")({ source: "interactive", text: "/harness-run x" }, ctx)).action === "continue");
  check("a non-interactive source is never intercepted", (await pi.hooks.get("input")({ source: "stream", text: "hello" }, ctx)).action === "continue");
  check("empty input is never intercepted", (await pi.hooks.get("input")({ source: "interactive", text: "   " }, ctx)).action === "continue");
}

// --- commands --------------------------------------------------------------

{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-run").handler("", ctx);
  check("/harness-run with no task explains itself", ctx.notifications.some(([, m]) => /Usage/.test(m)),
    ctx.notifications.map(([, m]) => m).join(" | "));
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-answer").handler("yes", ctx);
  check("/harness-answer with nothing pending says so", ctx.notifications.some(([, m]) => /No harness workflow is waiting/.test(m)),
    ctx.notifications.map(([, m]) => m).join(" | "));
}
{
  // No text at all: a free-text box, still not a closed menu.
  const pi = await withExtension();
  const ctx = makeCtx();
  const payload = {
    schema: 2, phase: "SUSPENDED", runId: "r", task: "t", retry: 0, maxRetries: 3,
    reason: "awaiting_approval", resumeState: "PLANNING", resumeAgent: "planner",
    question: { topic: "approval", question: "approve?" },
  };
  ctx.sessionManager = { getBranch: () => [{ type: "custom", customType: "pi-minimal-harness:suspended", data: payload }] };
  await pi.hooks.get("session_start")({}, ctx);
  await pi.commands.get("harness-answer").handler("", ctx);
  check("with no text it opens a FREE-TEXT box", ctx.inputs.length > 0, ctx.inputs.join(" | "));
  check("and still no closed menu", ctx.selects.length === 0, ctx.selects.map(([t]) => t).join(" | "));
}
{
  // Whatever the user typed must reach the workflow, not be replaced by a menu.
  const pi = await withExtension();
  const ctx = makeCtx();
  const payload = {
    schema: 2, phase: "SUSPENDED", runId: "r", task: "t", retry: 0, maxRetries: 3,
    reason: "awaiting_approval", resumeState: "PLANNING", resumeAgent: "planner",
    question: { topic: "approval", question: "approve?" },
  };
  ctx.sessionManager = { getBranch: () => [{ type: "custom", customType: "pi-minimal-harness:suspended", data: payload }] };
  await pi.hooks.get("session_start")({}, ctx);
  await pi.commands.get("harness-answer").handler("esto no es lo que pedi, cambia el alcance", ctx);
  check("/harness-answer never opens a menu", ctx.selects.length === 0, ctx.selects.map(([t]) => t).join(" | "));
  check("/harness-answer with text does not open a prompt either", ctx.inputs.length === 0, ctx.inputs.join(" | "));
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-status").handler("", ctx);
  check("/harness-status with no run explains itself", ctx.notifications.some(([, m]) => /No harness workflow has run/.test(m)));
}
{
  // The dead end the user hit: a run in flight, status reporting the LAST
  // outcome, and no way out.
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-abort").handler("", ctx);
  check("/harness-abort with nothing running says so", ctx.notifications.some(([, m]) => /No harness workflow is running/.test(m)));
  await pi.commands.get("harness-status").handler("", ctx);
  check("/harness-status offers /harness-abort when idle is not required", ctx.notifications.length > 0);
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-config").handler("", ctx);
  // Warnings are expected here — the fake registry has no MCP tools — so the
  // assertion is that nothing is FATAL, not that the output says "valid".
  const report = ctx.notifications.map(([, m]) => m).join(" | ");
  check("/harness-config reports no fatal finding in the shipped configuration", !report.includes("FAIL "), report.slice(0, 200));
  check("/harness-config surfaces the environment warnings", /finding\(s\)|Configuration valid/.test(report), report.slice(0, 120));
}
{
  const pi = await withExtension();
  const ctx = makeCtx();
  await pi.commands.get("harness-model").handler("nosuchagent", ctx);
  check("/harness-model rejects an unknown agent", ctx.notifications.some(([, m]) => /Unknown agent/.test(m)));
}

// --- sweep: every command handler must survive a bare context ---------------
//
// This exists because three runtime-only bugs shipped from this file: broken
// template literals, a `pi.ui` that ExtensionAPI does not have, and a template
// closed early by an unescaped backtick. The last one still IMPORTS cleanly —
// `/harness-status` parses as division — and only throws when that line runs.

{
  const pi = await withExtension();
  const ctx = makeCtx();
  for (const [name, spec] of pi.commands) {
    let threw = null;
    try {
      await spec.handler("implementer", ctx);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    check(`sweep: /${name} runs without throwing`, threw === null, threw ?? "");
  }
}

// --- the extension stays inside the real API ------------------------------

{
  const source = await fs.readFile(path.join(ROOT, ".pi", "extensions", "harness.ts"), "utf8");
  // ExtensionAPI exposes no `ui`; a wrong call here is a crash at runtime.
  check("the extension never calls pi.ui", !/\bpi\.ui\b/.test(source),
    [...source.matchAll(/pi\.ui/g)].map((m) => source.slice(m.index - 30, m.index + 20)).join(" | "));
  check("the status line is written through the event context", /ctx\.ui\.setStatus/.test(source));
}

// --- no template literal lost its backticks --------------------------------

{
  const source = await fs.readFile(path.join(ROOT, ".pi", "extensions", "harness.ts"), "utf8");
  const bare = source.split("\n").filter((l) => l.includes("${") && !l.includes("`"));
  check("no interpolation sits outside a template literal", bare.length === 0, bare.join(" | "));
  const balanced = (source.match(/`/g) ?? []).length % 2 === 0;
  check("backticks are balanced", balanced, String((source.match(/`/g) ?? []).length));
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);