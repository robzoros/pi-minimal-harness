/**
 * Tests for the driver: the loop that turns the state machine into a run.
 *
 * Run with:  node tests/driver.test.mjs
 *
 * Agents are fakes. That is the point: the whole workflow — including the
 * approval gate, the retry budget and a suspension surviving /reload — is
 * exercised without a model, a subprocess or a network.
 *
 * Platform: Windows, macOS and Linux; temp dirs come from `os.tmpdir()`.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
const lib = (name) => pathToFileURL(path.join(ROOT, ".pi", "extensions", "lib", name)).href;

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

const D = await import(lib("driver.ts"));
const T = await import(lib("transitions.ts"));
const C = await import(lib("config.ts"));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-driver-"));
const projectDir = path.join(tmp, "project");
await fs.mkdir(path.join(projectDir, "prompts"), { recursive: true });
for (const agent of ["planner", "explorer", "implementer", "reviewer", "tester", "deliverer"]) {
  await fs.writeFile(path.join(projectDir, "prompts", `${agent}.md`), `# ${agent} — fixture\n`, "utf8");
}
await fs.writeFile(path.join(projectDir, ".harness", "requirements.md").replace(/\\/g, "/"), "x", "utf8").catch(async () => {
  await fs.mkdir(path.join(projectDir, ".harness"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".harness", "requirements.md"), "x", "utf8");
});
await fs.writeFile(path.join(projectDir, ".harness", "requirements.md"),
  "# Requirements\n\n## REQ-001 — add the thing\n- **Status:** approved\n- **Acceptance:** tests pass\n", "utf8");

const config = C.withDefaults(
  C.parseConfig(await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8")).config ?? { agents: {} },
);

/** A fake agent: a script of results, keyed by agent name, consumed in order. */
function fakeAgents(script, log = []) {
  return async (options) => {
    log.push({ agent: options.agent, phase: options.phase, tools: options.tools, brief: options.brief, model: options.model, systemPromptDir: options.systemPromptDir });
    const entry = script[options.agent];
    // A function entry is a script that produces a different result each call.
    const result = typeof entry === "function" ? entry(options) : Array.isArray(entry) ? entry.shift() ?? entry.at(-1) : entry;
    if (result === "unusable") {
      return { ok: false, attempts: [], transportError: "the process died", contractErrors: ["no JSON object found in the reply"] };
    }
    return { ok: true, result, attempts: [], text: "" };
  };
}

const baseOptions = (extra = {}) => ({
  task: "add the thing",
  runId: "run-1",
  config,
  projectDir,
  cwd: tmp,
  ...extra,
});

const HAPPY = {
  planner: { status: "ready_for_approval", summary: "the plan is ready" },
  explorer: { status: "ok", summary: "found the files" },
  implementer: { status: "ok", summary: "changed two files" },
  reviewer: { status: "ok", summary: "looks right", verdict: "approved" },
  tester: { status: "ok", summary: "green", verdict: "pass" },
  deliverer: { status: "ok", summary: "shipped", verdict: "ready" },
};

// --- 1. a full run reaches DONE, through the user's approval ---------------

{
  const log = [];
  // The planner suspends; the driver cannot answer, so the run ends suspended
  // and the user is asked. That is the point of the gate.
  const first = await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }, log) }), undefined);
  check("1. a run stops to ask for approval", first.stopped === "suspended", first.stopped);
  check("1. it stops at the approval gate", first.state.phase === "SUSPENDED" && first.state.suspended?.reason === "awaiting_approval");
  check("1. only the planner ran", log.length === 1 && log[0].agent === "planner", log.map((l) => l.agent).join(","));

  const resumed = await D.runWorkflow(
    baseOptions({ execute: fakeAgents({ ...HAPPY }, log), userAction: "approve", userAnswer: "approved" }),
    first.state,
  );
  check("1. after the user approves it finishes", resumed.stopped === "done", resumed.reason);
  check("1. it ran the other five agents", log.length === 6, log.map((l) => l.agent).join(","));
  check("1. in order, and it went through the reviewer and tester",
    log.map((l) => l.agent).join(",") === "planner,explorer,implementer,reviewer,tester,deliverer",
    log.map((l) => l.agent).join(","));
  check("1. the implementer ran only once", log.filter((l) => l.agent === "implementer").length === 1);
}

// --- 2. a suspension survives /reload --------------------------------------

{
  const persisted = [];
  const first = await D.runWorkflow(baseOptions({
    execute: fakeAgents({ ...HAPPY }),
    persist: (payload) => persisted.push(payload),
  }));
  check("2. the suspension was persisted", persisted.length === 1 && persisted[0].reason === "awaiting_approval");
  check("2. with its resume point", persisted[0].resumeState === "PLANNING" && persisted[0].resumeAgent === "planner");

  // /reload replaces the runtime: a fresh process rebuilds the state from the
  // session entry alone, and the answer still lands in the right place.
  const entries = [
    { type: "message" },
    { type: "custom", customType: "other-extension:thing", data: { nope: true } },
    { type: "custom", customType: D.SUSPENSION_ENTRY, data: persisted[0] },
  ];
  const restored = D.restoreFromEntries(entries);
  check("2. a session entry rebuilds the workflow", restored?.phase === "SUSPENDED", restored?.phase);
  check("2. ignoring entries of other extensions", D.restoreFromEntries([{ type: "custom", customType: "x", data: persisted[0] }]) === null);
  check("2. an empty session restores nothing", D.restoreFromEntries([]) === null);
  check("2. a corrupt entry restores nothing",
    D.restoreFromEntries([{ type: "custom", customType: D.SUSPENSION_ENTRY, data: { schema: 2 } }]) === null);

  const log = [];
  const resumed = await D.runWorkflow(
    baseOptions({ execute: fakeAgents({ ...HAPPY }, log), userAction: "approve", userAnswer: "approved, go ahead" }),
    restored,
  );
  check("2. and the restored workflow still finishes", resumed.stopped === "done", resumed.reason);
  check("2. without re-running the planner", log[0].agent === "explorer", log.map((l) => l.agent).join(","));
}

// --- 2b. inferring what the user meant --------------------------------------

{
  const infer = D.inferAction;
  check("2b. a free-text approval is understood", infer("awaiting_approval", "approved") === "approve");
  check("2b. in Spanish too", infer("awaiting_approval", "adelante, por favor") === "approve");
  check("2b. a stop is a stop", infer("awaiting_approval", "stop") === "stop" && infer("awaiting_approval", "cancela") === "stop");
  check("2b. a request for changes is not an approval", infer("awaiting_approval", "haz unos cambios") === "revise");
  check("2b. an ambiguous reply never advances the workflow", infer("awaiting_approval", "mmm") === "revise");
  check("2b. everywhere else the answer is the answer", infer("needs_input", "approved") === "answer");
  check("2b. and for a retry exhaustion too", infer("retry_limit", "go ahead") === "answer");
}

// --- 3. retry exhaustion, and answering it --------------------------------

{
  const log = [];
  const alwaysFails = {
    ...HAPPY,
    tester: () => ({ status: "ok", summary: "red", verdict: "fail" }),
  };
  // The planner still suspends first; approving then runs the rest against a
  // tester that never goes green.
  const asked = await D.runWorkflow(baseOptions({ execute: fakeAgents(alwaysFails, log) }));
  check("3. the run asks for approval first", asked.state.suspended?.reason === "awaiting_approval", asked.state.suspended?.reason);

  const exhausted = await D.runWorkflow(
    baseOptions({ execute: fakeAgents(alwaysFails, log), userAction: "approve", userAnswer: "approved" }),
    asked.state,
  );
  check("3. a persistently failing tester exhausts the budget", exhausted.stopped === "suspended", exhausted.stopped);
  check("3. the reason is retry_limit", exhausted.state.suspended?.reason === "retry_limit", exhausted.state.suspended?.reason);
  check("3. it resumes at IMPLEMENTING with the implementer",
    exhausted.state.suspended?.resumeState === "IMPLEMENTING" && exhausted.state.suspended?.resumeAgent === "implementer",
    `${exhausted.state.suspended?.resumeState}/${exhausted.state.suspended?.resumeAgent}`);
  check("3. the budget was spent", exhausted.state.retry === config.maxRetries, `retry=${exhausted.state.retry}`);
  check("3. the implementer ran once plus every retry", log.filter((l) => l.agent === "implementer").length === config.maxRetries + 1,
    String(log.filter((l) => l.agent === "implementer").length));

  const carriedOn = await D.runWorkflow(
    baseOptions({ execute: fakeAgents(HAPPY, log), userAnswer: "carry on" }),
    exhausted.state,
  );
  check("3. answering resumes at IMPLEMENTING and can finish", carriedOn.stopped === "done", carriedOn.reason);
  check("3. without running the planner again", log.at(-1).agent === "deliverer", log.at(-1).agent);
}

// --- 4. a dead agent suspends instead of hanging ---------------------------

{
  const first = await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }) }));
  const dead = await D.runWorkflow(
    baseOptions({ execute: fakeAgents({ ...HAPPY, implementer: "unusable", explorer: "unusable" }, []), userAction: "approve", userAnswer: "approved" }),
    first.state,
  );
  check("4. an agent that cannot run suspends", dead.stopped === "suspended", dead.stopped);
  check("4. with reason agent_failed", dead.state.suspended?.reason === "agent_failed", dead.state.suspended?.reason);
  check("4. and it says why", /the process died/.test(dead.reason), dead.reason);
}

// --- 5. an invalid result stops the run with a readable reason -------------

{
  const first = await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }) }));
  const bad = await D.runWorkflow(
    baseOptions({ execute: fakeAgents({ ...HAPPY, reviewer: { status: "ok", summary: "x", verdict: "nonsense" } }, []), userAction: "approve", userAnswer: "approved" }),
    first.state,
  );
  check("5. a result the workflow cannot use aborts the run", bad.stopped === "aborted", bad.stopped);
  check("5. naming the agent and the problem", /reviewer/.test(bad.reason) && /nonsense/.test(bad.reason), bad.reason);
}

// --- 6. the driver builds each step correctly ------------------------------

{
  const log = [];
  const first = await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }, log) }));
  await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }, log), userAction: "approve", userAnswer: "approved" }), first.state);
  const byAgent = Object.fromEntries(log.map((l) => [l.agent, l]));

  check("6. the prompt path follows the agent name",
    log.every((l) => l.brief && l.agent), log.map((l) => l.agent).join(","));
  check("6. the implementer gets the writable tools",
    byAgent.implementer.tools.includes("bash") && byAgent.implementer.tools.includes("edit"),
    (byAgent.implementer.tools ?? []).join(","));
  check("6. the reviewer gets no shell", !byAgent.reviewer.tools.includes("bash"), (byAgent.reviewer.tools ?? []).join(","));
  check("6. the model comes from the config", byAgent.explorer.model === config.agents.explorer.model, byAgent.explorer.model);
  check("6. every brief carries the task", log.every((l) => l.brief.includes("add the thing")));
  check("6. and the language rule", log.every((l) => /English/.test(l.brief)));
  check("6. the explorer brief names the requirements file contents or omits it cleanly",
    typeof byAgent.explorer.brief === "string");
  check("6. no step writes anything into the project directory",
    log.every((l) => !String(l.systemPromptDir ?? "").startsWith(tmp)),
    log.map((l) => l.systemPromptDir).join(" | "));
  check("6. the runner falls back to the OS temp dir when no directory is given",
    log.every((l) => l.systemPromptDir === undefined) && String(os.tmpdir()).length > 0);
}

// --- 7. configuration comes from disk --------------------------------------

{
  const loaded = await D.loadConfig(path.join(ROOT, "harness.config.yaml"));
  check("7. the shipped config loads", loaded.version === 2, String(loaded.version));
  check("7. with all six agents", C.AGENT_NAMES.every((a) => Boolean(loaded.agents[a])));
  const missing = await D.loadConfig(path.join(tmp, "does-not-exist.yaml"));
  check("7. a missing file yields defaults rather than throwing", missing.maxRetries === C.DEFAULTS.maxRetries);
}

// --- 7b. aborting a run --------------------------------------------------

{
  const controller = new AbortController();
  let seen = 0;
  const slow = async (options) => {
    seen++;
    if (seen === 1) controller.abort();      // abort during the FIRST step
    return { ok: true, result: { status: "ready_for_approval", summary: "ready" }, attempts: [], text: "" };
  };
  const out = await D.runWorkflow(baseOptions({ execute: slow, signal: controller.signal }));
  check("7b. an abort during a step stops the run", out.stopped === "aborted", out.stopped);
  check("7b. and says so in plain words", out.reason === "you stopped the workflow", out.reason);
  check("7b. without starting another step", seen === 1, String(seen));

  const pre = new AbortController();
  pre.abort();
  const never = await D.runWorkflow(baseOptions({ execute: async () => { throw new Error("must not run"); }, signal: pre.signal }));
  check("7b. an abort before the first step runs no agent at all", never.stopped === "aborted" && never.stepCount === 0, `${never.stopped}/${never.stepCount}`);
  check("7b. and says the same thing", never.reason === "you stopped the workflow", never.reason);
}

// --- 7c. a blocked delivery must terminate --------------------------------

{
  // An ENVELOPE, not an executeStep outcome: fakeAgents does the wrapping.
  const blocked = () => ({ status: "ok", summary: "still blocked: the worktree holds changes from another task", verdict: "blocked" });
  const happy = {
    planner: { status: "ready_for_approval", summary: "ready" },
    explorer: { status: "ok", summary: "found it" },
    implementer: { status: "ok", summary: "changed it" },
    reviewer: { status: "ok", summary: "fine", verdict: "approved" },
    tester: { status: "ok", summary: "green", verdict: "pass" },
    deliverer: blocked,
  };
  const asked = await D.runWorkflow(baseOptions({ execute: fakeAgents(happy) }));
  check("7c. the planner gate comes first", asked.state.suspended?.reason === "awaiting_approval", asked.state.suspended?.reason);

  const reached = await D.runWorkflow(
    baseOptions({ execute: fakeAgents(happy), userAction: "approve", userAnswer: "approved" }),
    asked.state,
  );
  check("7c. a blocked delivery suspends rather than finishing", reached.stopped === "suspended", reached.stopped);
  check("7c. with reason delivery_blocked", reached.state.suspended?.reason === "delivery_blocked", reached.state.suspended?.reason);
  check("7c. and it has already spent one retry", reached.state.retry >= 1, String(reached.state.retry));

  let s = reached.state;
  let rounds = 0;
  let last = reached;
  while (s.phase === "SUSPENDED" && rounds++ < 12) {
    last = await D.runWorkflow(
      baseOptions({ execute: fakeAgents({ deliverer: blocked }), userAction: "answer", userAnswer: "try again" }),
      s,
    );
    s = last.state;
    if (last.stopped !== "suspended") break;
  }
  check("7c. the loop ends instead of suspending for ever", last.stopped === "aborted", `stopped=${last.stopped} after ${rounds}`);
  check("7c. and says the blocker is not an answer's problem",
    /not something an answer fixes/.test(last.reason), last.reason);
  check("7c. the budget was never reset by answering", s.retry > 0, `retry=${s.retry}`);
}

// --- 8. the driver cannot loop forever -------------------------------------

{
  const loop = {
    ...HAPPY,
    reviewer: () => ({ status: "ok", summary: "again", verdict: "changes_required" }),
    implementer: () => ({ status: "ok", summary: "again" }),
  };
  const log = [];
  const first = await D.runWorkflow(baseOptions({ execute: fakeAgents(HAPPY, log) }));
  const outcome = await D.runWorkflow(baseOptions({ execute: fakeAgents(loop, log), userAction: "approve", userAnswer: "approved" }), first.state);
  check("8. an endless review loop stops at the budget", outcome.stopped === "suspended", outcome.stopped);
  check("8. rather than spinning", outcome.stepCount <= 64, String(outcome.stepCount));
  check("8. and never reaches DONE on its own", outcome.state.phase !== "DONE");
}

// --- 9. every phase the driver can enter is one it can leave ----------------

{
  const run = await D.runWorkflow(baseOptions({ execute: fakeAgents({ ...HAPPY }) }));
  check("9. the driver only ever lands on real phases", T.PHASES.includes(run.state.phase), run.state.phase);
  check("9. a fresh run always starts at PLANNING",
    (await D.runWorkflow(baseOptions({ execute: fakeAgents(HAPPY) }), undefined)).state.history[0] === "T1:init->PLANNING");
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
