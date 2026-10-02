/**
 * Serialisation of a suspended workflow.
 *
 * A suspension is the one place where the harness is waiting for a human, so it
 * has to say two things and not just feel like it: WHY it stopped, and WHERE it
 * comes back to. Both are columns on the transition (see `transitions.ts`), so
 * nothing here has to infer them from prose.
 *
 * The question the user reads is generated FROM the reason. It used to be the
 * other way round — the reason was inferred from which question had been
 * synthesised — and that made the machine's behaviour depend on a string.
 *
 * Nothing in the current runtime can be reused for the waiting: the old
 * `confirmPreflightBlock` was a binary one-shot confirm that returned false and
 * stopped the pipeline forever, and without a TUI it notified an error and
 * offered no way to resume.
 *
 * The sink is a structural type, not Pi's `ExtensionAPI`: the core stays
 * importable by plain Node (and therefore testable) without loading Pi.
 */

import { SUSPENSION_REASONS, type Phase, type SuspensionReason } from "./transitions.ts";
import type { Question } from "./result.ts";

/** Bumped only when the on-disk shape changes incompatibly. */
export const SUSPENDED_SCHEMA_VERSION = 2;

export interface SuspendedPayload {
  schema: 2;
  phase: Phase;
  runId: string;
  task: string;
  retry: number;
  maxRetries: number;
  reason: SuspensionReason;
  resumeState: Phase;
  resumeAgent: string;
  question: Question;
}

export interface SuspendedState {
  phase: "SUSPENDED";
  runId: string;
  task: string;
  retry: number;
  maxRetries: number;
  reason: SuspensionReason;
  resumeState: Phase;
  resumeAgent: string;
  question: Question;
}

export interface SerializeResult {
  ok: boolean;
  payload?: SuspendedPayload;
  error?: string;
}

/** The minimum surface the sink needs; structurally satisfied by Pi's ExtensionAPI. */
export interface SessionEntrySink {
  appendEntry(type: string, data?: unknown): void;
}

const isQuestion = (value: unknown): value is Question => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as Record<string, unknown>;
  return typeof q.topic === "string" && q.topic.trim() !== "" && typeof q.question === "string" && q.question.trim() !== "";
};

const isReason = (value: unknown): value is SuspensionReason =>
  typeof value === "string" && (SUSPENSION_REASONS as readonly string[]).includes(value);

/** Serialise a suspended state into the payload written to the session. */
export function serializeSuspended(state: SuspendedState): SerializeResult {
  if (state.phase !== "SUSPENDED") return { ok: false, error: `expected phase SUSPENDED, got ${state.phase}` };
  if (!isReason(state.reason)) return { ok: false, error: `unknown suspension reason ${JSON.stringify(state.reason)}` };
  if (!isQuestion(state.question)) return { ok: false, error: "suspended state carries no usable question" };
  return {
    ok: true,
    payload: {
      schema: SUSPENDED_SCHEMA_VERSION,
      phase: state.phase,
      runId: state.runId,
      task: state.task,
      retry: state.retry,
      maxRetries: state.maxRetries,
      reason: state.reason,
      resumeState: state.resumeState,
      resumeAgent: state.resumeAgent,
      question: state.question,
    },
  };
}

/** Rebuild a suspended state from a session payload; null when unusable. */
export function deserializeSuspended(raw: unknown): SuspendedState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.schema !== SUSPENDED_SCHEMA_VERSION) return null;
  if (p.phase !== "SUSPENDED") return null;
  if (typeof p.runId !== "string" || typeof p.task !== "string") return null;
  if (typeof p.retry !== "number" || !Number.isInteger(p.retry) || p.retry < 0) return null;
  if (typeof p.maxRetries !== "number" || !Number.isInteger(p.maxRetries) || p.maxRetries < 0) return null;
  if (!isReason(p.reason)) return null;
  if (typeof p.resumeState !== "string") return null;
  if (typeof p.resumeAgent !== "string" || p.resumeAgent === "") return null;
  if (!isQuestion(p.question)) return null;
  return {
    phase: "SUSPENDED",
    runId: p.runId,
    task: p.task,
    retry: p.retry,
    maxRetries: p.maxRetries,
    reason: p.reason,
    resumeState: p.resumeState as Phase,
    resumeAgent: p.resumeAgent,
    question: p.question,
  };
}

/**
 * The question the user sees, generated from the REASON.
 *
 * Four reasons, four questions, always the same for the same reason. An agent's
 * own question is used as-is when it asked one — this is what makes `topic` a
 * real field, not decoration.
 */
export function questionForReason(
  reason: SuspensionReason,
  context: { agent: string; retry: number; maxRetries: number; summary?: string },
): Question {
  const budget = `${context.retry} of ${context.maxRetries} used`;
  switch (reason) {
    case "awaiting_approval":
      return {
        topic: "approval",
        question: `The plan is ready for your review (${context.agent} recommends it). Approve it, ask for changes, or stop the workflow?`,
        options: ["approve the plan", "ask for changes", "stop the workflow"],
      };
    case "retry_limit":
      return {
        topic: "exhausted",
        question: `The retry budget is exhausted (${budget}). How should the workflow proceed?`,
        options: ["revise the plan and restart", "continue anyway", "stop the workflow"],
      };
    case "agent_failed":
      return {
        topic: "blocker",
        question: `The ${context.agent} agent reported it could not continue (${context.summary?.trim() || "no detail"}). How should the workflow proceed?`,
        options: ["retry this agent", "revise the plan", "stop the workflow"],
      };
    case "delivery_blocked":
      return {
        topic: "delivery",
        question: `The ${context.agent} agent found that delivery is not ready: ${context.summary?.trim() || "no detail given"}. What should be unblocked first?`,
        options: ["unblock it and retry delivery", "revise the plan and restart", "stop the workflow"],
      };
    case "needs_input":
    default:
      return {
        topic: "blocked",
        question: `The ${context.agent} agent needs information to continue. How should the workflow proceed?`,
        options: ["answer and continue", "stop the workflow"],
      };
  }
}

/** Adapter that writes the payload into the Pi session, so it survives /reload. */
export function createSessionSink(sink: SessionEntrySink, type = "pi-minimal-harness:suspended") {
  return (payload: SuspendedPayload): void => {
    sink.appendEntry(type, payload);
  };
}
