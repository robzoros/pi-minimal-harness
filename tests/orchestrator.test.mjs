/**
 * Tests for the v2 orchestration core: transitions, state, result contract,
 * doubt escalation and suspension.
 *
 * Run with:  node tests/orchestrator.test.mjs
 *
 * Two rules the table has to keep:
 *   - No agent result moves the workflow past PLANNING. Approval is a user
 *     event, and there is deliberately no transition for an agent to take.
 *   - Every route into SUSPENDED declares its reason and its resume point as
 *     data, never as wording in a synthesised question.
 *
 * Platform: Windows, macOS and Linux. Paths come from `os.tmpdir()` and the
 * modules are imported through `pathToFileURL`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

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

const T = await import(lib("transitions.ts"));
const R = await import(lib("result.ts"));
const S = await import(lib("suspend.ts"));
const St = await import(lib("state.ts"));
const E = await import(lib("escalation.ts"));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const MAX = 3;
const fresh = () => St.createState({ runId: "r1", task: "add a feature", maxRetries: MAX });

// Result shorthands, all contract-valid for their phase.
const planReady = (summary = "plan ready") => ({ status: "ready_for_approval", summary });
const approved = (summary = "changes look right") => ({ status: "ok", summary, verdict: "approved" });
const passed = (summary = "tests pass") => ({ status: "ok", summary, verdict: "pass" });
const ready = (summary = "everything is in order") => ({ status: "ok", summary, verdict: "ready" });
const blocked = (summary = "REQ-002 has no test") => ({ status: "ok", summary, verdict: "blocked" });
const fail_ = (summary = "tests fail") => ({ status: "ok", summary, verdict: "fail" });
const changes = (summary = "needs work") => ({ status: "ok", summary, verdict: "changes_required" });
const done = (summary = "nothing to do") => ({ status: "complete", summary });
const okOnly = (summary = "step ok") => ({ status: "ok", summary });
const ask = (topic = "scope", summary = "blocked") => ({
  status: "needs_input",
  summary,
  question: { topic, question: "Which module?" },
});
const failed = (summary = "cannot continue") => ({ status: "failed", summary });

const implementerRuns = (s) => s.history.filter((h) => h.endsWith("->IMPLEMENTING")).length;

/**
 * Walk a scripted plan from a fresh START. Each entry is either
 * [phaseBefore, result] or a function of the state, for user actions.
 */
function drive(plan, { maxRetries = MAX } = {}) {
  const problems = [];
  let s = St.createState({ runId: "r1", task: "add a feature", maxRetries });
  const started = St.applySignal(s, "init");
  if (!started.ok) return { s, problems: [`init: ${started.error}`] };
  s = started.state;
  for (const entry of plan) {
    if (typeof entry === "function") {
      const out = entry(s);
      if (!out.ok) {
        problems.push(`${s.phase}: ${out.error}`);
        break;
      }
      s = out.state;
      continue;
    }
    const [phaseBefore, result] = entry;
    if (s.phase !== phaseBefore) {
      problems.push(`expected to be in ${phaseBefore} but was in ${s.phase}`);
      break;
    }
    const out = St.applyAgentResult(s, result);
    if (!out.ok) {
      problems.push(`${phaseBefore}: ${out.error}${out.errors ? ` [${out.errors.join("; ")}]` : ""}`);
      break;
    }
    s = out.state;
  }
  return { s, problems };
}

/** A run already suspended at PLANNING awaiting approval. */
function awaitingApproval({ maxRetries = MAX } = {}) {
  let s = St.createState({ runId: "r1", task: "add a feature", maxRetries });
  s = St.applySignal(s, "init").state;
  const out = St.applyAgentResult(s, planReady());
  if (!out.ok) throw new Error(`awaitingApproval failed: ${out.error}`);
  return out.state;
}

/** Start suspended with the given result, which must suspend. */
function suspendedBy(phase, result, { maxRetries = MAX } = {}) {
  let s = St.createState({ runId: "r1", task: "t", maxRetries });
  s = St.applySignal(s, "init").state;
  s = { ...s, phase, suspended: null };
  const out = St.applyAgentResult(s, result);
  if (!out.ok) throw new Error(`suspendedBy failed: ${out.error} ${(out.errors ?? []).join("; ")}`);
  return out.state;
}

// --- table invariants -------------------------------------------------------

{
  const isTarget = (t) => t === "@resumeState" || T.PHASES.includes(t);
  check("table: every phase in TRANSITIONS is a known phase",
    T.TRANSITIONS.every((t) => T.PHASES.includes(t.from) && isTarget(t.to)));
  check("table: transition ids are unique",
    new Set(T.TRANSITIONS.map((t) => t.id)).size === T.TRANSITIONS.length);
  check("table: no (phase, signal) is ambiguous", T.ambiguousSignals().length === 0, T.ambiguousSignals().join(", "));
  check("table: only DONE and SUSPENDED are terminal",
    T.TERMINAL_PHASES.join(",") === "DONE,SUSPENDED");
  check("table: DONE is never left", !T.TRANSITIONS.some((t) => t.from === "DONE"));
  check("table: SUSPENDED is only left by a user signal",
    T.TRANSITIONS.filter((t) => t.from === "SUSPENDED").every((t) => t.signal.startsWith("ui:")));
  // Retry is the budget for going round in circles. It is spent entering
  // IMPLEMENTING (reviewer or tester sent it back) and when a delivery is
  // blocked, which is the one reason that otherwise never terminates.
  const spendsRetry = T.TRANSITIONS.filter((t) => t.incrementRetry);
  check("table: retry is only spent on re-work or a blocked delivery",
    spendsRetry.every((t) => t.to === "IMPLEMENTING" || t.suspension?.reason === "delivery_blocked"),
    spendsRetry.map((t) => `${t.id}->${t.to}`).join(","));
  // Only ONE reason can re-enter work that has not changed: a blocked delivery.
  // The others are waits, not loops — a gate the human opens, or a failure they
  // resolve — so charging them a retry would punish them for asking.
  const loops = T.TRANSITIONS.filter((t) => t.to === "SUSPENDED" && t.suspension?.reason === "delivery_blocked");
  check("table: a blocked delivery is the only self-repeating reason, and it is bounded",
    loops.length > 0 && loops.every((t) => t.incrementRetry), loops.map((t) => `${t.id}=${t.incrementRetry}`).join(","));
  check("table: the guarded rows are the review and test change requests",
    T.TRANSITIONS.filter((t) => t.condition).map((t) => t.signal).join(",") === "verdict:changes_required,verdict:changes_required,verdict:fail,verdict:fail");
  // Every suspension declares its contract: the thing this phase exists to enforce.
  check("table: every route into SUSPENDED declares reason and resume point",
    T.suspensionsMissingContract().length === 0, T.suspensionsMissingContract().join(", "));
  check("table: every declared reason is a known reason",
    T.TRANSITIONS.every((t) => !t.suspension || T.SUSPENSION_REASONS.includes(t.suspension.reason)));
  check("table: every resumeState is the phase that suspended",
    T.TRANSITIONS.every((t) => !t.suspension || t.suspension.resumeState === t.from || t.suspension.reason === "retry_limit"));
  // The approval gate, as an invariant on the table. A self-loop is not an
  // advance: the phase was already that phase.
  const isSelfLoop = (t) => t.to === t.from;
  const into = (phase) => T.TRANSITIONS.filter((t) => t.to === phase);
  const skips = into("EXPLORING").filter((t) => !isSelfLoop(t) && !t.signal.startsWith("ui:"));
  check("table: NO agent result can take PLANNING to EXPLORING",
    skips.length === 0, skips.map((t) => `${t.id}:${t.signal}`).join(","));
  check("table: EXPLORING is only advanced into by a user approving",
    into("EXPLORING").every((t) => t.signal === "ui:approve" || isSelfLoop(t)),
    into("EXPLORING").map((t) => `${t.id}:${t.signal}`).join(","));
  check("table: PLANNING is entered by init, by a user's revise, or by a self-loop",
    into("PLANNING").every((t) => ["init", "ui:revise"].includes(t.signal) || isSelfLoop(t)),
    into("PLANNING").map((t) => `${t.id}:${t.signal}`).join(","));
  check("table: DONE is only reached by completion or by the user stopping",
    into("DONE").every((t) => ["status:complete", "verdict:ready", "ui:stop"].includes(t.signal)),
    into("DONE").map((t) => `${t.id}:${t.signal}`).join(","));
}

// --- 1. the approval gate ---------------------------------------------------

{
  const selfApprove = St.applyAgentResult(St.applySignal(fresh(), "init").state, approved());
  check("1. the planner cannot approve its own plan", !selfApprove.ok, selfApprove.error);
  check("1. the refusal says the user decides",
    (selfApprove.errors ?? []).some((e) => e.includes("let the user decide")), (selfApprove.errors ?? []).join("; "));
  check("1. a verdict is illegal in PLANNING at all",
    (selfApprove.errors ?? []).some((e) => e.includes("only meaningful in REVIEWING, TESTING, DELIVERING")));
}
{
  const s = awaitingApproval();
  check("1. ready_for_approval suspends", s.phase === "SUSPENDED", s.phase);
  check("1. the reason is awaiting_approval", s.suspended?.reason === "awaiting_approval", s.suspended?.reason);
  check("1. it resumes at PLANNING with the planner",
    s.suspended?.resumeState === "PLANNING" && s.suspended?.resumeAgent === "planner");
  check("1. the user is asked to approve, not to approve",
    /approve/i.test(s.suspended?.question.question ?? "") && s.suspended?.question.options?.includes("approve the plan"));
  check("1. the planner is not resumed into EXPLORING by its own readiness",
    St.applySignal(s, "status:ready_for_approval").ok === false);
}
{
  const approvedFlow = St.applyUserAction(awaitingApproval(), "approve");
  check("1. the user approving moves to EXPLORING", approvedFlow.ok && approvedFlow.state.phase === "EXPLORING", approvedFlow.state?.phase);
  check("1. approval clears the suspension", approvedFlow.ok && approvedFlow.state.suspended === null);

  const revised = St.applyUserAction(awaitingApproval(), "revise");
  check("1. asking for changes returns to PLANNING", revised.ok && revised.state.phase === "PLANNING", revised.state?.phase);
  check("1. a revision does not spend the retry budget", revised.ok && revised.state.retry === 0);

  const stopped = St.applyUserAction(awaitingApproval(), "stop");
  check("1. stopping ends the workflow", stopped.ok && stopped.state.phase === "DONE", stopped.state?.phase);
}
{
  const waiting = awaitingApproval();
  check("1. revise is impossible while waiting on a question",
    St.applyUserAction(suspendedBy("EXPLORING", ask()), "revise").ok === false);
  check("1. approve is impossible while waiting on a question",
    !St.applyUserAction(suspendedBy("EXPLORING", ask()), "approve").ok);
  check("1. stop works from any reason", St.applyUserAction(suspendedBy("TESTING", ask()), "stop").ok);
  check("1. an empty answer is rejected", !St.applyUserAction(waiting, "answer", "   ").ok);
}

// --- 2. the full cycle, with the approval the old model skipped -------------

{
  const { s, problems } = drive([
    ["PLANNING", planReady()],
    (st) => St.applyUserAction(st, "approve"),
    ["EXPLORING", okOnly()], ["IMPLEMENTING", okOnly()],
    ["REVIEWING", approved()], ["TESTING", passed()], ["DELIVERING", ready()],
  ]);
  check("2. the full cycle reaches DONE", problems.length === 0 && s.phase === "DONE", problems.join("; ") || s.phase);
  check("2. the happy path spends no retry", s.retry === 0, `retry=${s.retry}`);
  check("2. it took eight steps: agent, user, then six agents", s.history.length === 8, s.history.join(" "));
  check("2. the approval is in the history as a user event", s.history.some((h) => h.startsWith("T38:ui:approve")), s.history.join(" "));
}
{
  const { s } = drive([["PLANNING", done()]]);
  check("2. complete is still a terminal shortcut", s.phase === "DONE", s.phase);
}

// --- 3. the shared retry budget, driven by the tester ----------------------

{
  const plan = [["PLANNING", planReady()], (st) => St.applyUserAction(st, "approve"),
    ["EXPLORING", okOnly()], ["IMPLEMENTING", okOnly()], ["REVIEWING", approved()]];
  for (let i = 0; i < MAX; i++) {
    plan.push(["TESTING", fail_()], ["IMPLEMENTING", okOnly()], ["REVIEWING", approved()]);
  }
  plan.push(["TESTING", fail_()]);
  const { s, problems } = drive(plan);
  check("3. the fourth tester failure exhausts the budget", problems.length === 0 && s.phase === "SUSPENDED", problems.join("; ") || s.phase);
  check("3. the budget stops at maxRetries", s.retry === MAX, `retry=${s.retry}`);
  check("3. the implementer ran four times in total", implementerRuns(s) === 4, `${implementerRuns(s)}`);
  check("3. the last transition is the exhausted branch", s.history.at(-1)?.startsWith("T27:"), s.history.at(-1));
  check("3. exhaustion suspends with reason retry_limit", s.suspended?.reason === "retry_limit", s.suspended?.reason);
  check("3. it resumes at IMPLEMENTING, not PLANNING",
    s.suspended?.resumeState === "IMPLEMENTING" && s.suspended?.resumeAgent === "implementer");
  check("3. the budget is reported in the question", /3 of 3 used/.test(s.suspended?.question.question ?? ""));
}

// --- 4. exhaustion in REVIEWING shares the same budget and resume point ----

{
  const plan = [["PLANNING", planReady()], (st) => St.applyUserAction(st, "approve"),
    ["EXPLORING", okOnly()], ["IMPLEMENTING", okOnly()]];
  for (let i = 0; i < MAX; i++) plan.push(["REVIEWING", changes()], ["IMPLEMENTING", okOnly()]);
  plan.push(["REVIEWING", changes()]);
  const { s, problems } = drive(plan);
  check("4. REVIEWING exhaustion suspends", problems.length === 0 && s.phase === "SUSPENDED", problems.join("; ") || s.phase);
  check("4. it spends the same shared budget", s.retry === MAX, `retry=${s.retry}`);
  check("4. it uses the same reason and resume point",
    s.suspended?.reason === "retry_limit" && s.suspended?.resumeState === "IMPLEMENTING");
  const resumed = St.applyUserAction(s, "answer", "carry on");
  check("4. answering an exhaustion resumes at IMPLEMENTING", resumed.ok && resumed.state.phase === "IMPLEMENTING", resumed.state?.phase);
  check("4. answering clears the budget", resumed.ok && resumed.state.retry === 0, `retry=${resumed.state?.retry}`);
  check("4. and the run continues from there, with the implementer pending again",
    resumed.ok && resumed.state.phase === "IMPLEMENTING" && implementerRuns(resumed.state) === 5,
    `phase=${resumed.state?.phase} runs=${implementerRuns(resumed.state)}`);
}

// --- 5. doubt escalation: orchestrator first, user only when it must -------

{
  const check5 = E.classifyDoubt;
  check("5. every user-mandatory topic escalates",
    E.USER_MANDATORY_TOPICS.every((t) => check5(t).decision === "escalate"), E.USER_MANDATORY_TOPICS.join(","));
  check("5. a checkable topic is resolved",
    E.RUNTIME_RESOLVABLE_TOPICS.every((t) => check5(t).decision === "resolve"), E.RUNTIME_RESOLVABLE_TOPICS.join(","));
  check("5. an unknown topic escalates, it never resolves by default", check5("vibes").decision === "escalate");
  check("5. a missing topic escalates", check5(undefined).decision === "escalate" && check5("").decision === "escalate");
  check("5. the classification is case- and space-insensitive", check5("  Scope ").decision === "escalate");
}
{
  const escalated = suspendedBy("IMPLEMENTING", ask("requirement"));
  check("5. a user-mandatory doubt suspends", escalated.phase === "SUSPENDED", escalated.phase);
  check("5. it suspends for needs_input with the asking agent",
    escalated.suspended?.reason === "needs_input" && escalated.suspended?.resumeAgent === "implementer");
  check("5. the agent's own question is what the user sees",
    escalated.suspended?.question.question === "Which module?");
  check("5. nothing was resolved", escalated.resolvedDoubt === null);
}
{
  let s = St.createState({ runId: "r", task: "t", maxRetries: MAX });
  s = { ...St.applySignal(s, "init").state, phase: "IMPLEMENTING", suspended: null, retry: 2 };
  const out = St.applyAgentResult(s, ask("graph"));
  check("5. a checkable doubt is a self-loop", out.ok && out.state.phase === "IMPLEMENTING", out.state?.phase);
  check("5. it spends no budget", out.ok && out.state.retry === 2, `retry=${out.state?.retry}`);
  check("5. it records what the orchestrator settled",
    out.ok && out.state.resolvedDoubt?.topic === "graph", JSON.stringify(out.state?.resolvedDoubt));
  check("5. the fallback the agent must use is named",
    out.ok && /grep/.test(out.state.resolvedDoubt?.note ?? ""), out.state?.resolvedDoubt?.note);
  check("5. it clears once the next result is taken", St.applyAgentResult(out.state, okOnly()).state.resolvedDoubt === null);
}
{
  const escalated = suspendedBy("EXPLORING", ask("architecture"));
  const answered = St.applyUserAction(escalated, "answer", "use the billing module");
  check("5. the answer returns to the agent that asked", answered.ok && answered.state.phase === "EXPLORING", answered.state?.phase);
  check("5. approve is not offered outside awaiting_approval", !St.applyUserAction(escalated, "approve").ok);
}

// --- 6. the question is generated FROM the reason --------------------------

{
  const generated = [
    ["awaiting_approval", awaitingApproval().suspended],
    ["retry_limit", suspendedBy("TESTING", fail_("still red"), { maxRetries: 0 }).suspended],
    ["agent_failed", suspendedBy("TESTING", failed()).suspended],
  ];
  check("6. each reason produces its own question",
    new Set(generated.map(([, s]) => s?.question.question)).size === 3,
    generated.map(([r, s]) => `${r}: ${s?.question.topic}`).join(" | "));
  check("6. the same reason always produces the same question",
    S.questionForReason("retry_limit", { agent: "implementer", retry: 3, maxRetries: 3 }).question ===
    S.questionForReason("retry_limit", { agent: "implementer", retry: 3, maxRetries: 3 }).question);
  check("6. an agent_failed question quotes what the agent said",
    S.questionForReason("agent_failed", { agent: "tester", retry: 0, maxRetries: 3, summary: "suite broken" }).question.includes("suite broken"));
  check("6. a needs_input without an agent question still asks something",
    S.questionForReason("needs_input", { agent: "explorer", retry: 0, maxRetries: 3 }).question.includes("explorer"));
  check("6. the reason is data, not wording",
    generated.every(([r, s]) => s?.reason === r), generated.map(([r, s]) => `${r}=${s?.reason}`).join(" "));
}

// --- 6b. the closed envelope, per-phase verdicts, and delivery_blocked -----

{
  const extra = St.applyAgentResult({ ...fresh(), phase: "EXPLORING", suspended: null },
    { status: "ok", summary: "done", next_agent: "implementer" });
  check("6b. an invented field is rejected, and named", extra.ok === false, extra.error);
  check("6b. the refusal quotes the field",
    (extra.errors ?? []).some((e) => e.includes("next_agent")), (extra.errors ?? []).join("; "));
  check("6b. the refusal lists what is allowed",
    (extra.errors ?? []).some((e) => e.includes("allowed:")), (extra.errors ?? []).join("; "));
  const known = { status: "ok", summary: "s", verdict: "ready" };
  check("6b. the envelope's own fields all pass",
    St.applyAgentResult({ ...fresh(), phase: "DELIVERING", suspended: null }, known).ok);
  check("6b. allowed fields are exactly the contract",
    R.ALLOWED_FIELDS.join(",") === "status,summary,verdict,requirements,question,checks", R.ALLOWED_FIELDS.join(","));
}
{
  const at = (phase) => ({ ...fresh(), phase, suspended: null });
  const verdict = (phase, v) => St.applyAgentResult(at(phase), { status: "ok", summary: "s", verdict: v });
  check("6b. the reviewer may return approved", verdict("REVIEWING", "approved").ok);
  check("6b. the reviewer may return changes_required", verdict("REVIEWING", "changes_required").ok);
  check("6b. the reviewer may NOT return pass",
    (verdict("REVIEWING", "pass").errors ?? []).some((e) => e.includes("cannot return \"pass\"")),
    (verdict("REVIEWING", "pass").errors ?? []).join("; "));
  check("6b. the tester may not return approved",
    (verdict("TESTING", "approved").errors ?? []).some((e) => e.includes("cannot return")));
  check("6b. the deliverer may not return approved",
    (verdict("DELIVERING", "approved").errors ?? []).some((e) => e.includes("cannot return")));
  check("6b. the deliverer may return ready", verdict("DELIVERING", "ready").ok);
  check("6b. the deliverer may return blocked", verdict("DELIVERING", "blocked").ok);
  check("6b. the old verdict name is gone everywhere",
    !R.RESULT_VERDICTS.includes("changes") && !T.TRANSITIONS.some((t) => t.signal === "verdict:changes"),
    R.RESULT_VERDICTS.join(","));
  check("6b. each judging phase has its own disjoint set",
    new Set([...(R.VERDICTS_FOR_PHASE.REVIEWING ?? []), ...(R.VERDICTS_FOR_PHASE.TESTING ?? []), ...(R.VERDICTS_FOR_PHASE.DELIVERING ?? [])]).size === 6);
}
{
  const done_ = St.applyAgentResult({ ...fresh(), phase: "DELIVERING", suspended: null }, ready());
  check("6b. DELIVERING + ready -> DONE", done_.ok && done_.state.phase === "DONE", done_.state?.phase);
  const stuck = St.applyAgentResult({ ...fresh(), phase: "DELIVERING", suspended: null }, blocked());
  check("6b. DELIVERING + blocked -> SUSPENDED", stuck.ok && stuck.state.phase === "SUSPENDED", stuck.state?.phase);
  check("6b. the reason is delivery_blocked, not agent_failed",
    stuck.state.suspended?.reason === "delivery_blocked", stuck.state.suspended?.reason);
  check("6b. it resumes at DELIVERING with the deliverer",
    stuck.state.suspended?.resumeState === "DELIVERING" && stuck.state.suspended?.resumeAgent === "deliverer");
  check("6b. the question names the blocker",
    /REQ-002/.test(stuck.state.suspended?.question.question ?? ""), stuck.state.suspended?.question.question);
  const resumed = St.applyUserAction(stuck.state, "answer", "add the missing test");
  check("6b. answering returns to DELIVERING", resumed.ok && resumed.state.phase === "DELIVERING", resumed.state?.phase);
  check("6b. and the reasons are still distinct",
    suspendedBy("TESTING", failed()).suspended.reason === "agent_failed" &&
    stuck.state.suspended.reason === "delivery_blocked");
  const ser = S.serializeSuspended(stuck.state.suspended);
  check("6b. delivery_blocked round-trips", ser.ok && S.deserializeSuspended(JSON.parse(JSON.stringify(ser.payload)))?.reason === "delivery_blocked");
}

// --- 7. agent failures and the rejection rules -----------------------------

{
  const s = suspendedBy("REVIEWING", failed("the diff will not load"));
  check("7. a failed agent suspends with reason agent_failed", s.suspended?.reason === "agent_failed", s.suspended?.reason);
  check("7. it resumes at the phase that failed", s.suspended?.resumeState === "REVIEWING" && s.suspended?.resumeAgent === "reviewer");
  check("7. and its answer returns it to that phase",
    St.applyUserAction(s, "answer", "try again").state.phase === "REVIEWING");

  const cases = [
    ["a reviewer result without a verdict", "REVIEWING", okOnly()],
    ["a verdict outside review and test", "EXPLORING", approved()],
    ["complete outside planning", "IMPLEMENTING", done()],
    ["ready_for_approval outside planning", "EXPLORING", planReady()],
    ["complete together with a verdict", "PLANNING", { status: "complete", summary: "x", verdict: "approved" }],
    ["ready_for_approval with a verdict", "PLANNING", { status: "ready_for_approval", summary: "x", verdict: "approved" }],
    ["needs_input without a question", "PLANNING", { status: "needs_input", summary: "x" }],
    ["an unknown status", "PLANNING", { status: "maybe", summary: "x" }],
    ["an unknown verdict", "REVIEWING", { status: "ok", summary: "x", verdict: "shipit" }],
    ["a non-object result", "PLANNING", "### Plan\nall good"],
    ["an empty summary", "PLANNING", { status: "ok", summary: "  " }],
  ];
  let allRejected = true;
  const detail = [];
  for (const [name, phase, raw] of cases) {
    const out = St.applyAgentResult({ ...fresh(), phase, suspended: null }, raw);
    if (out.ok) { allRejected = false; detail.push(`accepted: ${name}`); }
    else if (!out.error || (out.errors && out.errors.length === 0)) { allRejected = false; detail.push(`no reason: ${name}`); }
  }
  check("7. every malformed result is rejected with a reason", allRejected, detail.join("; "));
}
{
  check("7. a planner that returns plain ok has no transition",
    !St.applyAgentResult({ ...fresh(), phase: "PLANNING", suspended: null }, okOnly()).ok);
  check("7. a terminal phase accepts nothing further",
    !St.applyAgentResult({ ...fresh(), phase: "DONE", suspended: null }, okOnly()).ok);
  check("7. acting when not suspended is rejected", !St.applyUserAction(fresh(), "answer", "hi").ok);
  check("7. every agent phase can be left", T.AGENT_PHASES.every((p) => T.TRANSITIONS.some((t) => t.from === p)),
    T.AGENT_PHASES.filter((p) => !T.TRANSITIONS.some((t) => t.from === p)).join(","));
}

// --- 8. suspension round-trip -----------------------------------------------

{
  const s = awaitingApproval();
  const ser = S.serializeSuspended(s.suspended);
  check("8. a suspended state serialises", ser.ok && ser.payload.schema === 2, ser.error);
  check("8. the payload carries reason and resume point",
    ser.payload?.reason === "awaiting_approval" && ser.payload?.resumeState === "PLANNING" && ser.payload?.resumeAgent === "planner");
  const back = S.deserializeSuspended(JSON.parse(JSON.stringify(ser.payload)));
  check("8. it round-trips through JSON",
    back?.reason === "awaiting_approval" && back?.resumeState === "PLANNING" && back?.resumeAgent === "planner" && back?.retry === s.retry);
  check("8. the question survives the round trip", back?.question.question === s.suspended.question.question);
  check("8. an unknown reason is refused", S.deserializeSuspended({ ...ser.payload, reason: "gave_up" }) === null);
  check("8. a missing resume point is refused",
    S.deserializeSuspended({ ...ser.payload, resumeState: undefined }) === null);
  check("8. the old schema version is refused", S.deserializeSuspended({ ...ser.payload, schema: 1 }) === null);
  check("8. a non-suspended state is refused", S.serializeSuspended({ ...s.suspended, phase: "PLANNING" }).ok === false);
  check("8. garbage is refused", S.deserializeSuspended("nope") === null);
  const sinkCalls = [];
  const sink = S.createSessionSink({ appendEntry: (type, data) => sinkCalls.push([type, data]) });
  sink(ser.payload);
  check("8. the sink writes the payload to the session", sinkCalls.length === 1 && sinkCalls[0][1].reason === "awaiting_approval");
}

// --- 9. the state is reachable and consistent ------------------------------

{
  const started = St.createState({ runId: "r", task: "t", maxRetries: MAX });
  check("9. a fresh state starts at START, which runs no agent",
    started.phase === "START" && !St.applyAgentResult(started, okOnly()).ok);
  const init = St.applySignal(started, "init");
  check("9. init is the only way out of START", init.ok && init.state.phase === "PLANNING" && init.state.history[0].startsWith("T1:"));

  const every = T.TRANSITIONS.filter((t) => !t.condition && t.to !== "@resumeState");
  const reachable = every.every((t) => T.PHASES.includes(t.from));
  check("9. every unguarded row has a known source phase", reachable);
  check("9. SUSPENDED exposes its reason", St.suspensionReason(awaitingApproval()) === "awaiting_approval");
  check("9. and null when it is not suspended", St.suspensionReason(fresh()) === null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
