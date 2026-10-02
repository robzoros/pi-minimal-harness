/**
 * Workflow state and the application of signals to it.
 *
 * Pure: no I/O, no Pi API, no config file reading. `maxRetries` is injected, so
 * the whole retry budget is testable without touching disk.
 *
 * The retry rule, stated once: the guard is evaluated before the transition, and
 * `retry++` fires when entering IMPLEMENTING. A suspension never spends budget,
 * and only the exhaustion branch does.
 *
 * The approval rule, stated once: no agent result moves the workflow past
 * PLANNING. The planner declares `ready_for_approval`, which suspends, and the
 * user answers.
 */

import {
  findTransition,
  isAgentPhase,
  isTerminal,
  resolveTarget,
  type Phase,
  type Signal,
  type SuspensionReason,
  type Transition,
} from "./transitions.ts";
import { parseResult, signalFor, validateForPhase, type AgentResult, type Question } from "./result.ts";
import { classifyQuestion, resolutionText } from "./escalation.ts";
import { questionForReason, type SuspendedState } from "./suspend.ts";

export type WorkflowPhase = Phase;

/** What the runtime settled itself, handed to the driver so it can supply the fact. */
export interface ResolvedDoubt {
  topic: string;
  note: string;
}

export interface WorkflowState {
  phase: Phase;
  runId: string;
  task: string;
  retry: number;
  maxRetries: number;
  /** Non-null exactly while `phase` is SUSPENDED. */
  suspended: SuspendedState | null;
  /** Set after the orchestrator settled a doubt; cleared once consumed. */
  resolvedDoubt: ResolvedDoubt | null;
  /** Last accepted result, so the runner can build the next brief. */
  lastResult: AgentResult | null;
  /** Every transition taken, for the transcript and for assertions. */
  history: string[];
}

export interface CreateStateOptions {
  runId: string;
  task: string;
  maxRetries: number;
}

export type Outcome =
  | { ok: true; state: WorkflowState; transition: Transition }
  | { ok: false; error: string; errors?: string[] };

/** What the user did while the workflow was waiting. */
export type UserAction = "approve" | "revise" | "stop" | "answer";

export const USER_SIGNAL: Record<UserAction, Signal> = {
  approve: "ui:approve",
  revise: "ui:revise",
  stop: "ui:stop",
  answer: "ui:answer",
};

export function createState(options: CreateStateOptions): WorkflowState {
  return {
    phase: "START",
    runId: options.runId,
    task: options.task,
    retry: 0,
    maxRetries: options.maxRetries,
    suspended: null,
    resolvedDoubt: null,
    lastResult: null,
    history: [],
  };
}

/** Apply a bare signal (`init`). */
export function applySignal(state: WorkflowState, signal: Signal): Outcome {
  if (isTerminal(state.phase) && signal !== "ui:answer") {
    return { ok: false, error: `${state.phase} is terminal; no further signal is accepted` };
  }
  const transition = findTransition(state.phase, signal, state.retry, state.maxRetries, state.suspended?.reason ?? null);
  if (!transition) return { ok: false, error: `no transition from ${state.phase} for signal ${signal}` };
  return commit(state, transition, signal);
}

/**
 * Apply an agent result: validate shape, validate meaning for the phase, route
 * any doubt through the escalation table, then transition.
 *
 * `status: needs_input` is a TRIGGER, not a destination. The runtime decides
 * whether the orchestrator settles it or the user does, so a model cannot ask
 * the user a question the runtime would have answered.
 */
export function applyAgentResult(state: WorkflowState, raw: unknown): Outcome {
  if (!isAgentPhase(state.phase)) return { ok: false, error: `${state.phase} does not run an agent` };

  const parsed = parseResult(raw);
  if (!parsed.valid || !parsed.result) return { ok: false, error: "invalid agent result", errors: parsed.errors };
  const result = parsed.result;

  const meaning = validateForPhase(result, state.phase);
  if (!meaning.valid) return { ok: false, error: `invalid result for ${state.phase}`, errors: meaning.errors };

  if (result.status === "needs_input") return applyDoubt(state, result);

  const signal = signalFor(result, state.phase);
  if (!signal) return { ok: false, error: `result carries no usable signal for ${state.phase}` };
  const transition = findTransition(state.phase, signal, state.retry, state.maxRetries, state.suspended?.reason ?? null);
  if (!transition) return { ok: false, error: `no transition from ${state.phase} for ${signal}` };
  return commit(state, transition, signal, result);
}

/**
 * A doubt: the runtime classifies the topic and either settles it (self-loop,
 * budget untouched) or escalates it (suspends for the user).
 */
function applyDoubt(state: WorkflowState, result: AgentResult): Outcome {
  const question = result.question as Question | undefined;
  const verdict = classifyQuestion(question);
  const signal: Signal = verdict.decision === "escalate" ? "doubt:escalated" : "doubt:resolved";
  const transition = findTransition(state.phase, signal, state.retry, state.maxRetries, state.suspended?.reason ?? null);
  if (!transition) return { ok: false, error: `no transition from ${state.phase} for ${signal}` };

  const outcome = commit(state, transition, signal, result);
  if (!outcome.ok) return outcome;
  if (verdict.decision === "resolve") {
    outcome.state.resolvedDoubt = {
      topic: verdict.topic,
      note: question ? `${question.question} — ${resolutionText(verdict.topic)}` : resolutionText(verdict.topic),
    };
  }
  return outcome;
}

/**
 * The user acted on a suspension.
 *
 * Which actions are legal depends on WHY it stopped, and the table decides
 * that: `approve` and `revise` exist only for a plan awaiting approval, so
 * offering them on a retry exhaustion is not possible.
 */
export function applyUserAction(state: WorkflowState, action: UserAction, answer?: string): Outcome {
  if (state.phase !== "SUSPENDED") {
    return { ok: false, error: `not suspended (phase is ${state.phase}); there is nothing to answer` };
  }
  const signal = USER_SIGNAL[action];
  const transition = findTransition("SUSPENDED", signal, state.retry, state.maxRetries, state.suspended?.reason ?? null);
  if (!transition) {
    return {
      ok: false,
      error: `"${action}" is not available while suspended for ${state.suspended?.reason}`,
    };
  }
  if (action === "answer" && (typeof answer !== "string" || answer.trim() === "")) {
    return { ok: false, error: "an answer must be a non-empty string" };
  }
  // A fresh answer clears the budget — the human just supplied new authority.
  // A blocked DELIVERY does not: answering does not clean a worktree or fix a
  // missing remote, so re-running the deliverer on the same state would produce
  // the same refusal for ever.
  const reason = state.suspended?.reason;
  const clearBudget = transition.resetRetry === true && reason !== "delivery_blocked";
  const source = clearBudget ? { ...state, retry: 0 } : state;
  return commit(source, transition, signal);
}

function commit(state: WorkflowState, transition: Transition, signal: Signal, result?: AgentResult): Outcome {
  const to = resolveTarget(transition.to, state.suspended?.resumeState);
  if (to === null) return { ok: false, error: `transition ${transition.id} has no resolvable target` };

  const next: WorkflowState = {
    ...state,
    phase: to,
    retry: state.retry + (transition.incrementRetry ? 1 : 0),
    suspended: null,
    resolvedDoubt: null,
    lastResult: result ?? state.lastResult,
    history: [...state.history, `${transition.id}:${signal}->${to}`],
  };

  if (to === "SUSPENDED") next.suspended = buildSuspension(next, transition, signal, result);
  return { ok: true, state: next, transition };
}

/**
 * Build the suspension from the TRANSITION's declared contract, never from the
 * signal or from the wording of a question. The agent's own question is kept
 * when it asked one; otherwise the reason produces it.
 */
function buildSuspension(
  state: WorkflowState,
  transition: Transition,
  signal: Signal,
  result?: AgentResult,
): SuspendedState | null {
  const contract = transition.suspension;
  if (!contract) return null;
  const question =
    result?.question ??
    questionForReason(contract.reason, {
      agent: contract.resumeAgent,
      retry: state.retry,
      maxRetries: state.maxRetries,
      summary: result?.summary,
    });
  return {
    phase: "SUSPENDED",
    runId: state.runId,
    task: state.task,
    retry: state.retry,
    maxRetries: state.maxRetries,
    reason: contract.reason,
    resumeState: contract.resumeState,
    resumeAgent: contract.resumeAgent,
    question,
  };
}

export function suspensionReason(state: WorkflowState): SuspensionReason | null {
  return state.suspended?.reason ?? null;
}
