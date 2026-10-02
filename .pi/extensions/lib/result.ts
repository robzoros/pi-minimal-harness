/**
 * The agent result contract: parse, validate, and derive a transition signal.
 *
 * Two validation layers, because they catch different mistakes:
 *   1. `parseResult`      — shape: is it an object, are the enums real?
 *   2. `validateForPhase` — meaning: is `verdict: approved` legal right now?
 *
 * Layer 2 is what stops an explorer from "approving" its own exploration, and
 * what stops a `complete` from short-circuiting out of a phase that has no
 * such exit.
 */

import { AGENT_PHASES, type Phase, type Signal } from "./transitions.ts";

export type ResultStatus = "ok" | "needs_input" | "complete" | "failed" | "ready_for_approval";
export type ResultVerdict = "approved" | "changes_required" | "ready" | "blocked" | "pass" | "fail";
export type CheckResult = "passed" | "failed" | "skipped";

export const RESULT_STATUSES: readonly ResultStatus[] = ["ok", "needs_input", "complete", "failed", "ready_for_approval"] as const;
export const RESULT_VERDICTS: readonly ResultVerdict[] = ["approved", "changes_required", "ready", "blocked", "pass", "fail"] as const;
export const CHECK_RESULTS: readonly CheckResult[] = ["passed", "failed", "skipped"] as const;

/**
 * The envelope is a CLOSED shape. Anything outside this list is a contract
 * error, not something to ignore.
 *
 * That is deliberate and it is the mechanism, not a convention: an agent that
 * invents a field such as `next_agent` — trying to pick the next step itself —
 * gets the field named back at it in one repair turn, instead of having the
 * value silently dropped while it believes it acted.
 */
export const ALLOWED_FIELDS: readonly string[] = ["status", "summary", "verdict", "requirements", "question", "checks"] as const;

/**
 * Phases whose agent must return a `verdict`; every other phase must not.
 *
 * PLANNING is deliberately NOT here. The planner cannot approve its own plan:
 * it returns `ready_for_approval`, which suspends the workflow, and the approval
 * itself is a user event. There is no transition from PLANNING to EXPLORING that
 * an agent result can drive.
 *
 * REVIEWING, TESTING and DELIVERING are here: they are the three roles that
 * reach a judgement about work someone else did. Their verdicts are DISJOINT —
 * a reviewer cannot report `pass`, a deliverer cannot report `approved` — so
 * presence alone is not enough; see `VERDICTS_FOR_PHASE`.
 */
export const VERDICT_PHASES: readonly Phase[] = ["REVIEWING", "TESTING", "DELIVERING"] as const;

/** Which verdicts each judging phase may return. */
export const VERDICTS_FOR_PHASE: Readonly<Partial<Record<Phase, readonly ResultVerdict[]>>> = {
  REVIEWING: ["approved", "changes_required"],
  TESTING: ["pass", "fail"],
  DELIVERING: ["ready", "blocked"],
} as const;

/** `status: complete` is the planner's way of saying "nothing to build". */
export const COMPLETE_PHASES: readonly Phase[] = ["PLANNING"] as const;

/** `status: ready_for_approval` is the planner's only route past PLANNING. */
export const READY_PHASES: readonly Phase[] = ["PLANNING"] as const;

export interface Question {
  topic: string;
  question: string;
  options?: string[];
}

export interface AgentResult {
  status: ResultStatus;
  summary: string;
  verdict?: ResultVerdict;
  requirements?: { touched: string[]; untraceable: string[] };
  question?: Question;
  checks?: { command: string; result: CheckResult }[];
}

export interface Validation {
  valid: boolean;
  errors: string[];
}

const ok = (): Validation => ({ valid: true, errors: [] });
const bad = (errors: string[]): Validation => ({ valid: false, errors });

/**
 * Validate the shape of a raw agent result. Unknown input (a string, null, an
 * array, a markdown report) fails here rather than producing a confusing
 * downstream error.
 */
export function parseResult(raw: unknown): Validation & { result?: AgentResult } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...bad(["result is not a JSON object"]), result: undefined };
  }
  const r = raw as Record<string, unknown>;

  // Closed shape first: an invented field is a contract error, and the message
  // names it, so the repair turn can quote it.
  const unknown = Object.keys(r).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) {
    errors.push(
      `the result envelope has no field(s): ${unknown.join(", ")} (allowed: ${ALLOWED_FIELDS.join(", ")})`,
    );
  }

  const status = r.status;
  if (typeof status !== "string" || !RESULT_STATUSES.includes(status as ResultStatus)) {
    errors.push(`status must be one of ${RESULT_STATUSES.join(", ")} (got ${JSON.stringify(status)})`);
  }
  if (typeof r.summary !== "string" || r.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }
  if (r.verdict !== undefined) {
    if (typeof r.verdict !== "string" || !RESULT_VERDICTS.includes(r.verdict as ResultVerdict)) {
      errors.push(`verdict must be one of ${RESULT_VERDICTS.join(", ")} when present (got ${JSON.stringify(r.verdict)})`);
    }
  }
  if (r.question !== undefined) {
    if (r.question === null || typeof r.question !== "object" || Array.isArray(r.question)) {
      errors.push("question must be an object when present");
    } else {
      const q = r.question as Record<string, unknown>;
      if (typeof q.topic !== "string" || q.topic.trim() === "") errors.push("question.topic must be a non-empty string");
      if (typeof q.question !== "string" || q.question.trim() === "") errors.push("question.question must be a non-empty string");
      if (q.options !== undefined && !Array.isArray(q.options)) errors.push("question.options must be a list when present");
    }
  }
  if (r.checks !== undefined) {
    if (!Array.isArray(r.checks)) {
      errors.push("checks must be a list when present");
    } else {
      for (const [i, c] of r.checks.entries()) {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          errors.push(`checks[${i}] must be an object`);
          continue;
        }
        const check = c as Record<string, unknown>;
        if (typeof check.command !== "string" || check.command.trim() === "") errors.push(`checks[${i}].command must be a non-empty string`);
        if (typeof check.result !== "string" || !CHECK_RESULTS.includes(check.result as CheckResult)) {
          errors.push(`checks[${i}].result must be one of ${CHECK_RESULTS.join(", ")}`);
        }
      }
    }
  }
  if (r.requirements !== undefined) {
    const req = r.requirements as Record<string, unknown> | null;
    if (req === null || typeof req !== "object" || Array.isArray(req)) {
      errors.push("requirements must be an object when present");
    } else {
      for (const key of ["touched", "untraceable"]) {
        if (req[key] !== undefined && !Array.isArray(req[key])) errors.push(`requirements.${key} must be a list when present`);
      }
    }
  }

  if (errors.length > 0) return { ...bad(errors), result: undefined };
  return { ...ok(), result: r as unknown as AgentResult };
}

/**
 * Validate the meaning of an already-parsed result in the phase it arrived in.
 * `needs_input` from any agent phase is legal; `verdict` and `complete` are not.
 */
export function validateForPhase(result: AgentResult, phase: Phase): Validation {
  if (!AGENT_PHASES.includes(phase)) {
    return bad([`${phase} does not run an agent, so it cannot receive a result`]);
  }
  const errors: string[] = [];

  // A verdict is required only when the agent actually reached a conclusion:
  // `complete`, `needs_input` and `failed` are alternatives to one, so a
  // verdict alongside them is the contradiction, not the omission.
  const concluding = result.status === "ok";
  const allowed = VERDICTS_FOR_PHASE[phase] ?? [];
  if (VERDICT_PHASES.includes(phase)) {
    if (concluding && result.verdict === undefined) {
      errors.push(`a ${phase} result with status "ok" must carry a verdict (${allowed.join(", ")})`);
    }
    if (concluding && result.verdict !== undefined && !allowed.includes(result.verdict)) {
      errors.push(`a ${phase} result cannot return "${result.verdict}" (allowed: ${allowed.join(", ")})`);
    }
  } else if (result.verdict !== undefined) {
    errors.push(`verdict is only meaningful in ${VERDICT_PHASES.join(", ")}, not in ${phase}`);
  }

  if (result.status === "complete" && !COMPLETE_PHASES.includes(phase)) {
    errors.push(`status "complete" is only valid in ${COMPLETE_PHASES.join(", ")}, not in ${phase}`);
  }
  if (result.status === "ready_for_approval") {
    if (!READY_PHASES.includes(phase)) {
      errors.push(`status "ready_for_approval" is only valid in ${READY_PHASES.join(", ")}, not in ${phase}`);
    }
    if (result.verdict !== undefined) {
      errors.push(`"ready_for_approval" hands approval to the user; do not also send a verdict`);
    }
  }
  if (result.status === "complete" && result.verdict !== undefined) {
    errors.push(`status "complete" and a verdict contradict each other`);
  }
  if (result.status === "needs_input") {
    if (result.question === undefined) errors.push(`status "needs_input" requires a question`);
    if (result.verdict !== undefined) errors.push(`status "needs_input" and a verdict contradict each other`);
  }

  // The point of the approval gate: nothing an agent returns may move the
  // workflow past PLANNING. Saying so here is what makes the rule testable.
  if (phase === "PLANNING" && result.verdict === "approved") {
    errors.push(`the planner cannot approve its own plan: send status "ready_for_approval" and let the user decide`);
  }
  return errors.length > 0 ? bad(errors) : ok();
}

/**
 * Derive the transition signal from a result. `status` wins over `verdict`
 * because suspending or failing supersedes whatever the agent concluded.
 * Returns null when the result carries no usable signal in this phase.
 */
export function signalFor(result: AgentResult, phase: Phase): Signal | null {
  if (result.status === "needs_input") return "status:needs_input";
  if (result.status === "failed") return "status:failed";
  if (result.status === "complete") return "status:complete";
  if (result.status === "ready_for_approval") return "status:ready_for_approval";
  if (result.status === "ok") return result.verdict === undefined ? "status:ok" : `verdict:${result.verdict}`;
  return null;
}
