/**
 * Tests for agent execution: capability mapping, briefs, JSON extraction and
 * the spawn/retry policy.
 *
 * Run with:  node tests/runner.test.mjs
 *
 * The spawn tests run real `node` subprocesses emitting the same
 * `--mode json` message_end lines Pi produces, so the transport path is
 * genuinely exercised. No real `pi` is ever launched and no model is called.
 *
 * Platform: Windows, macOS and Linux. Temp dirs come from `os.tmpdir()`, the
 * fake agent is `node -e`, and paths are compared after `pathToFileURL`.
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

const caps = await import(lib("capabilities.ts"));
const brief = await import(lib("brief.ts"));
const extract = await import(lib("extract.ts"));
const runner = await import(lib("runner.ts"));
const results = await import(lib("result.ts"));
const transitions = await import(lib("transitions.ts"));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runner-"));

/** A prompt fixture that deliberately contains NO result-contract field names. */
const FIXTURE_PROMPT = `# ${"planner"} — fixture\n\nYou are under test. Do the work and reply with the envelope.\n`;
const promptPath = path.join(tmp, "agent.md");
await fs.writeFile(promptPath, FIXTURE_PROMPT, "utf8");

// --- fake agent -------------------------------------------------------------
// A real script file, not `node -e`: with -e the harness args that follow the
// script would be parsed as node's own options and it would exit 9. A script
// file puts them in process.argv, which is what Pi actually does.

let fakeSeq = 0;
const fakeScript = (name, body) => {
  // Unique per call: a shared filename lets one invocation overwrite another's
  // payload, which reads as "the agent returned the previous result".
  const file = path.join(tmp, `fake-${name}-${fakeSeq++}.mjs`);
  return fs.writeFile(file, body, "utf8").then(() => file);
};

const emit = (payload) => `process.stdout.write(JSON.stringify(${JSON.stringify(payload)}) + "\\n");`;

const fakeOk = async (payload) => {
  const file = await fakeScript("ok", `${emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n`);
  return { command: process.execPath, prefixArgs: [file] };
};
const fakeText = async (text) => {
  const file = await fakeScript("text", `${emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } })}\n`);
  return { command: process.execPath, prefixArgs: [file] };
};
const fakeExit = async (code) => {
  const file = await fakeScript(`exit${code}`, `process.exit(${code});\n`);
  return { command: process.execPath, prefixArgs: [file] };
};
const fakeHang = async () => {
  const file = await fakeScript("hang", `setTimeout(() => {}, 60000);\n`);
  return { command: process.execPath, prefixArgs: [file] };
};
const FAKE_MISSING = { command: "harness-no-such-binary-xyz", prefixArgs: [] };

// PLANNING cannot carry a verdict: the planner declares readiness and the user approves.
const VALID = { status: "ready_for_approval", summary: "plan ready" };
const VALID_FIELDS = Object.keys(VALID).sort().join(",");

const step = async (over = {}) => ({
  cwd: tmp,
  agent: "planner",
  promptPath,
  brief: brief.buildBrief("PLANNING", { task: "add a feature" }),
  phase: "PLANNING",
  invocation: await fakeOk(VALID),
  systemPromptDir: tmp,
  ...over,
});

// --- 1. argv ---------------------------------------------------------------

{
  const args = runner.buildAgentArgs({ promptPath: "/p.md", brief: "the brief", model: "p/m", thinking: "high", tools: ["read", "bash"] });
  check("1. argv always carries mode json, -p and --no-session",
    args[0] === "--mode" && args[1] === "json" && args[2] === "-p" && args[3] === "--no-session", args.slice(0, 4).join(" "));
  check("1. argv points at the composed system prompt", args.includes("--append-system-prompt") && args[args.indexOf("--append-system-prompt") + 1] === "/p.md");
  check("1. argv carries model, thinking and tools", args.includes("--model") && args.includes("--thinking") && args.includes("--tools"), args.join(" "));
  check("1. the brief is the last argument", args.at(-1) === "the brief");
  const bare = runner.buildAgentArgs({ promptPath: "/p.md", brief: "b" });
  check("1. optional flags are omitted when absent", !bare.includes("--model") && !bare.includes("--thinking") && !bare.includes("--tools"), bare.join(" "));
  check("1. an empty tool list emits no --tools", !runner.buildAgentArgs({ promptPath: "/p.md", brief: "b", tools: [] }).includes("--tools"));
}

// --- 2. capabilities -------------------------------------------------------

{
  const readOnly = caps.capabilitiesToTools(["read"]);
  check("2. read maps to the read-only tools", readOnly.tools.join(",") === "read,find,grep,ls", readOnly.tools.join(","));
  check("2. read-only has no errors", readOnly.errors.length === 0);
  const full = caps.capabilitiesToTools(["read", "write", "shell", "memory", "graph", "vcs", "github"]);
  // `shell` carries both shells Pi registers: a Windows agent needs powershell
  // to run codegraph, which ships as a .cmd. Unknown names are ignored by
  // --tools, so listing both is safe everywhere.
  check("2. the full set maps to the read tools, the write tools and both shells",
    full.tools.join(",") === "read,find,grep,ls,edit,write,bash,powershell", full.tools.join(","));
  check("2. memory, graph, vcs and github are declarative", full.declarative.join(",") === "memory,graph,vcs,github", full.declarative.join(","));
  check("2. the full set has no errors", full.errors.length === 0, full.errors.join("; "));
  const reordered = caps.capabilitiesToTools(["github", "shell", "read", "write", "graph", "memory", "vcs"]);
  check("2. tool order is canonical, not input order", reordered.tools.join(",") === full.tools.join(","));
  check("2. vcs without shell is an error", caps.capabilitiesToTools(["read", "vcs"]).errors.some((e) => e.includes("requires \"shell\"")));
  check("2. github without shell is an error", caps.capabilitiesToTools(["read", "github"]).errors.some((e) => e.includes("requires \"shell\"")));
  check("2. a missing read is an error", caps.capabilitiesToTools(["shell"]).errors.some((e) => e.includes("needs \"read\"")));
  check("2. an unknown capability is named", caps.capabilitiesToTools(["read", "telepathy"]).errors.some((e) => e.includes("telepathy")));
  check("2. only memory and graph are verifiable at runtime", caps.verifiableCapabilities(["read", "memory", "graph", "vcs"]).join(",") === "memory,graph");
  check("2. an agent with no enforceable capability yields no tools",
    caps.capabilitiesToTools(["read"]).tools.length > 0 && caps.capabilitiesToTools(["memory"]).tools.length === 0);
}

// --- 3. briefs -------------------------------------------------------------

{
  const phases = transitions.AGENT_PHASES;
  check("3. every agent phase has a brief", phases.every((p) => typeof brief.buildBrief(p, { task: "t" }) === "string" && brief.buildBrief(p, { task: "t" }).length > 0));
  check("3. each phase maps to its own agent",
    phases.every((p) => brief.AGENT_FOR_PHASE[p] === brief.agentForPhase(p)) &&
    phases.map((p) => brief.agentForPhase(p)).join(",") === "planner,explorer,implementer,reviewer,tester,deliverer",
    phases.map((p) => `${p}=${brief.agentForPhase(p)}`).join(" "));
  check("3. phase names are not the agent names, and the map is explicit",
    brief.agentForPhase("IMPLEMENTING") !== "implementing" && brief.agentForPhase("REVIEWING") === "reviewer");
  check("3. a phase that runs no agent has no brief",
    brief.agentForPhase("DONE") === null && brief.agentForPhase("SUSPENDED") === null);
  let throws = false;
  try { brief.buildBrief("DONE", { task: "t" }); } catch { throws = true; }
  check("3. building a brief for a non-agent phase throws", throws);

  const ctx = {
    task: "add a feature",
    requirements: "REQ-001 add the thing",
    findings: "src/x.ts is the entry point",
    previousSummary: "reviewer asked for tests",
    changedFiles: ["src/x.ts", "src/y.ts"],
    diffStat: "2 files changed",
    acceptanceCriteria: "npm test passes",
    traceability: "REQ-001 -> src/x.ts",
    issue: "#42",
    branch: "feat/thing",
    userAnswer: "use billing",
    qaHistory: ["Q1: which module? A1: billing"],
  };
  const texts = phases.map((p) => brief.buildBrief(p, ctx));
  check("3. every brief carries the task", texts.every((t) => t.includes("add a feature")));
  check("3. every brief carries the language rule", texts.every((t) => t.includes(brief.LANGUAGE_RULE)));
  check("3. every brief states the reply rule", texts.every((t) => t.includes(brief.REPLY_RULE)));
  const implementerBrief = brief.buildBrief("IMPLEMENTING", ctx);
  check("3. the implementer gets findings, changes and the previous review",
    implementerBrief.includes("src/x.ts is the entry point") && implementerBrief.includes("reviewer asked for tests") && implementerBrief.includes("- src/y.ts"));
  check("3. the deliverer gets traceability, issue and branch",
    brief.buildBrief("DELIVERING", ctx).includes("REQ-001 -> src/x.ts") && brief.buildBrief("DELIVERING", ctx).includes("#42"));
  check("3. a re-entered planner gets the user's answer and the Q&A history",
    brief.buildBrief("PLANNING", ctx).includes("use billing") && brief.buildBrief("PLANNING", ctx).includes("Q1: which module?"));
  check("3. empty context omits its sections", !brief.buildBrief("TESTING", { task: "t" }).includes("Traceability"));
  // D2: the brief must not restate the envelope's field names.
  const forbidden = ["changed_files", "requirements.touched", "untraceable:", "needs_input", "verdict:", "checks:"];
  const leaked = forbidden.filter((token) => texts.some((t) => t.includes(token)));
  check("3. no brief leaks a result-contract field name", leaked.length === 0, leaked.join(" "));
}

// --- 4. the contract is injected from result.ts ----------------------------

{
  const contract = runner.renderResultContract();
  check("4. every status value reaches the contract", results.RESULT_STATUSES.every((s) => contract.includes(s)));
  check("4. every verdict value reaches the contract", results.RESULT_VERDICTS.every((v) => contract.includes(v)));
  check("4. every check result reaches the contract", results.CHECK_RESULTS.every((c) => contract.includes(c)));
  check("4. the prompt template alone carries no contract",
    !FIXTURE_PROMPT.includes("needs_input") && !FIXTURE_PROMPT.includes("approved"));
  const composed = runner.composeSystemPrompt(FIXTURE_PROMPT);
  check("4. composing adds the contract to a bare template",
    composed.includes("fixture") && composed.includes("needs_input") && composed.includes("approved"));
  const run = await runner.executeStep(await step({ invocation: await fakeOk(VALID) }));
  const written = path.join(tmp, `harness-system-planner-${process.pid}.md`);
  check("4. executeStep accepted a fixture with no contract in it", run.ok && run.result?.status === "ready_for_approval", run.contractErrors?.join("; "));
  check("4. executeStep cleans up its system prompt", !(await fs.access(written).then(() => true, () => false)));
}

// --- 4b. the models offered are the ones that work -----------------------

{
  const m = (provider, id) => ({ provider, id });
  const usable = [m("p", "good")];
  const catalog = { getAvailable: () => usable, getAll: () => [m("p", "good"), m("p", "broken"), m("q", "also-good")] };
  const choices = runner.modelChoices(catalog);
  check("4b. every known model is listed exactly once",
    new Set(choices.map((c) => c.label)).size === 3, choices.map((c) => c.label).join(" | "));
  check("4b. models outside getAvailable() are marked unusable",
    choices.find((c) => c.model.id === "broken")?.usable === false &&
    choices.find((c) => c.model.id === "broken")?.label === "p/broken (no auth)",
    choices.map((c) => c.label).join(" | "));
  check("4b. usable models come first", choices.filter((c) => c.usable).every((c, i, a) => i === 0 || a[i - 1].usable));
  check("4b. an authenticated provider is respected",
    runner.modelChoices({ getAvailable: () => [m("p", "x")], getAll: () => [m("p", "x"), m("p", "y")] }, (mm) => mm.id === "y")
      .find((c) => c.model.id === "y")?.usable === false);
  const none = runner.modelChoices({ getAvailable: () => [], getAll: () => [m("p", "x"), m("p", "y")] });
  check("4b. with nothing authenticated, nothing is marked usable", none.every((c) => !c.usable),
    none.map((c) => c.label).join(" | "));
  check("4b. but they are still listed, so the user can aim at one", none.length === 2, none.map((c) => c.label).join(" | "));
  check("4b. a duplicated model across both lists appears once",
    runner.modelChoices({ getAvailable: () => [m("p", "x")], getAll: () => [m("p", "x")] }).length === 1);
}

// --- 5. extractJson --------------------------------------------------------

{
  check("5. a fenced block is extracted", extract.extractJson('```json\n{"status":"ok"}\n```')?.status === "ok");
  check("5. an unfenced block is extracted", extract.extractJson('{"status":"ok"}')?.status === "ok");
  check("5. prose around the object is tolerated",
    extract.extractJson('Here is my answer:\n\n{"status":"ok","summary":"s"}\n\nHope that helps.')?.summary === "s");
  check("5. the last fenced block wins",
    extract.extractJson('```json\n{"n":1}\n```\ntext\n```json\n{"n":2}\n```')?.n === 2);
  check("5. braces inside strings do not break matching",
    extract.extractJson('{"summary":"a } b { c"}')?.summary === "a } b { c");
  check("5. escaped quotes do not break matching",
    extract.extractJson('{"summary":"he said \\"hi\\" }"}')?.summary === 'he said "hi" }');
  check("5. nested objects yield the outermost envelope",
    extract.extractJson('{"status":"needs_input","question":{"topic":"scope","question":"which?"}}')?.status === "needs_input");
  check("5. prose braces do not beat the real object",
    extract.extractJson('Use {} as a placeholder, then: {"status":"ok"}')?.status === "ok");
  check("5. an array-wrapped envelope still yields the object",
    extract.extractJson('[{"status":"ok","summary":"s"}]')?.status === "ok");
  check("5. prose with no object yields null", extract.extractJson("I could not do it.") === null);
  check("5. empty text yields null", extract.extractJson("") === null && extract.extractJson("   ") === null);
  check("5. a malformed object yields null", extract.extractJson("{not json}") === null);
  check("5. an unterminated object yields null", extract.extractJson('{"status":') === null);
  check("5. readEnvelopeFor rejects a wrong-phase result",
    !extract.readEnvelopeFor(JSON.stringify({ status: "ok", summary: "s" }), "REVIEWING").valid);
  check("5. readEnvelopeFor accepts a right-phase result",
    extract.readEnvelopeFor(JSON.stringify(VALID), "PLANNING").valid);
check("5. readEnvelopeFor rejects a planner that approves itself",
    !extract.readEnvelopeFor(JSON.stringify({ status: "ok", summary: "s", verdict: "approved" }), "PLANNING").valid);
  check("5. readEnvelopeFor reports every problem at once",
    extract.readEnvelopeFor('{"status":"nope"}', "REVIEWING").errors.length > 1,
    extract.readEnvelopeFor('{"status":"nope"}', "REVIEWING").errors.join(" | "));
}

// --- 6. transport failures -------------------------------------------------

{
  const missing = await runner.runAgent(await step({ invocation: FAKE_MISSING, promptPath: path.join(tmp, "agent.md") }));
  check("6. a missing binary is a transport error, not a throw", !missing.ok && /harness-no-such-binary-xyz/.test(missing.transportError), missing.transportError);
  const exited = await runner.runAgent(await step({ invocation: await fakeExit(3) }));
  check("6. a non-zero exit is a transport error", !exited.ok && exited.transportError.includes("code 3"), exited.transportError);
  const hung = await runner.runAgent(await step({ invocation: await fakeHang(), timeoutMs: 250 }));
  check("6. a timeout is a transport error", !hung.ok && hung.transportError.includes("timed out"), hung.transportError);
  const aborted = new AbortController();
  aborted.abort();
  const gone = await runner.runAgent(await step({ invocation: await fakeHang(), signal: aborted.signal, timeoutMs: 5000 }));
  check("6. an abort is a transport error", !gone.ok, gone.transportError);
  const good = await runner.runAgent(await step({ invocation: await fakeOk(VALID) }));
  check("6. a clean run reports its text", good.ok && good.text === JSON.stringify(VALID), good.transportError);
  const missingPrompt = await runner.executeStep(await step({ promptPath: path.join(tmp, "nope.md") }));
  check("6. an unreadable prompt is a transport error", !missingPrompt.ok && missingPrompt.transportError.includes("prompt template unreadable"));
}

// --- 7. retry policy: one of each, and they are different failures ---------

{
  const exit4 = await fakeExit(4);
  const okInv = await fakeOk(VALID);
  let calls = 0;
  const recovered = await runner.executeStep(await step({
    invocation: () => (calls++ === 0 ? exit4 : okInv),
    maxTransportRetries: 1,
  }));
  check("7. one transport failure is retried once and can recover", recovered.ok, recovered.transportError);

  let calls2 = 0;
  const gaveUp = await runner.executeStep(await step({ invocation: () => (calls2++, exit4), maxTransportRetries: 1 }));
  check("7. a persistent transport failure gives up after one retry",
    !gaveUp.ok && calls2 === 2 && gaveUp.attempts.filter((a) => a.kind === "transport").length === 2,
    `calls=${calls2} ${JSON.stringify(gaveUp.attempts.map((a) => a.kind))}`);

  const garbage = await fakeText("I am afraid I cannot do that.");
  const repaired = await runner.executeStep(await step({ invocation: garbage }));
  check("7. one contract failure is repaired once", !repaired.ok && repaired.attempts.filter((a) => a.kind === "contract").length === 2,
    JSON.stringify(repaired.attempts.map((a) => a.kind)));
  check("7. an unrepairable result becomes status failed",
    repaired.result?.status === "failed" && repaired.result.summary.includes("no usable result"), repaired.result?.summary);
  check("7. a contract failure is never reported as a transport failure", repaired.transportError === undefined);
  check("7. a repair brief is built, not a respawn", repaired.attempts.every((a) => a.kind === "contract"));

  let repainted = 0;
  const repairedOk = await runner.executeStep(await step({ invocation: () => (repainted++ === 0 ? garbage : okInv) }));
  check("7. one contract failure can recover on the repair turn", repairedOk.ok && repairedOk.result?.status === "ready_for_approval", repairedOk.contractErrors?.join("; "));

  const single = await runner.executeStep(await step({ invocation: garbage, maxTransportRetries: 0, maxRepairs: 0 }));
  check("7. 0/0 makes exactly one attempt", single.attempts.length === 1, JSON.stringify(single.attempts.map((a) => a.kind)));
}

// --- 8. integration --------------------------------------------------------

{
  const out = await runner.executeStep(await step({ invocation: await fakeOk(VALID) }));
  check("8. a valid planner reply comes back as an envelope", out.ok && out.result?.status === "ready_for_approval");
  check("8. a clean step reports no retries", out.attempts.length === 0, JSON.stringify(out.attempts));
  check("8. the raw text is preserved alongside the envelope", out.text === JSON.stringify(VALID));

  const complete = await runner.executeStep(await step({ invocation: await fakeOk({ status: "complete", summary: "nothing to do" }) }));
  check("8. a planner may report complete", complete.ok && complete.result?.status === "complete", `ok=${complete.ok} status=${complete.result?.status} errs=${JSON.stringify(complete.contractErrors)} transport=${complete.transportError}`);

  const question = await runner.executeStep(await step({ invocation: await fakeOk({ status: "needs_input", summary: "blocked", question: { topic: "scope", question: "which module?" } }) }));
  check("8. a planner question survives the transport", question.ok && question.result?.question?.question === "which module?", `ok=${question.ok} errs=${JSON.stringify(question.contractErrors)} transport=${question.transportError}`);

  const repair = brief.buildRepairBrief("the brief", ["no JSON object found in the reply", "status must be one of ok"]);
  check("8. a repair brief names every problem and keeps the original",
    repair.includes("no JSON object found") && repair.includes("status must be one of ok") && repair.includes("the brief"));
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
