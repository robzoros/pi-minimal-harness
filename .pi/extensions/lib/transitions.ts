/**
 * The workflow transition table — the single source of truth for v2 control flow.
 *
 * Pure data plus a pure lookup. No I/O, no Pi API, no config reading: every
 * policy value is injected by the caller, which is what makes the machine
 * testable with fake agents.
 *
 * Retry accounting:
 *   - The guard is evaluated BEFORE the transition.
 *   - `incrementRetry` fires when ENTERING IMPLEMENTING.
 *   - With maxRetries = 3: retry goes 0 -> 1 -> 2 -> 3 across three re-entries,
 *     and the fourth loop fails the guard. The implementer therefore runs at
 *     most 4 times (1 initial + 3 re-entries).
 *
 * Suspension accounting:
 *   - Nothing about a suspension lives in prose. `reason`, `resumeState` and
 *     `resumeAgent` are columns here, and the question the user sees is
 *     generated FROM the reason, never the other way round.
 *   - The PLANNING agent cannot approve its own plan. It emits
 *     `ready_for_approval`, which suspends; approval itself is a user event
 *     (`ui:approve`). There is deliberately no transition that an agent result
 *     alone can take from PLANNING to EXPLORING.
 */

/** Every phase the workflow can occupy. START is pre-run; DONE/SUSPENDED are terminal. */
export type Phase =
  | "START"
  | "PLANNING"
  | "EXPLORING"
  | "IMPLEMENTING"
  | "REVIEWING"
  | "TESTING"
  | "DELIVERING"
  | "SUSPENDED"
  | "DONE";

export const PHASES: readonly Phase[] = [
  "START",
  "PLANNING",
  "EXPLORING",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "DELIVERING",
  "SUSPENDED",
  "DONE",
] as const;

/** Phases that run an agent, and therefore accept an agent result. */
export const AGENT_PHASES: readonly Phase[] = [
  "PLANNING",
  "EXPLORING",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "DELIVERING",
] as const;

/** A state the workflow can leave only through the user. */
export const TERMINAL_PHASES: readonly Phase[] = ["DONE", "SUSPENDED"] as const;

/** The agent that runs in each phase. Lives here because it is workflow data. */
export const AGENT_FOR_PHASE: Partial<Record<Phase, string>> = {
  PLANNING: "planner",
  EXPLORING: "explorer",
  IMPLEMENTING: "implementer",
  REVIEWING: "reviewer",
  TESTING: "tester",
  DELIVERING: "deliverer",
};

export function agentForPhase(phase: Phase): string | null {
  return AGENT_FOR_PHASE[phase] ?? null;
}

/**
 * What moved the workflow forward.
 *
 * Agent signals are prefixed by the field they come from, so `status` and
 * `verdict` never collide. The three `ui:*` signals come from the user; the
 * two `doubt:*` signals are derived by the runtime from the escalation table,
 * never chosen by a model.
 */
export type Signal =
  | "init"
  | "status:ok"
  | "status:complete"
  | "status:ready_for_approval"
  | "status:needs_input"
  | "status:failed"
  | "verdict:approved"
  | "verdict:changes_required"
  | "verdict:ready"
  | "verdict:blocked"
  | "verdict:pass"
  | "verdict:fail"
  | "ui:approve"
  | "ui:revise"
  | "ui:stop"
  | "ui:answer"
  | "doubt:resolved"
  | "doubt:escalated";

/** Guard for the two signals that can exhaust the retry budget. */
export type RetryCondition = "retries_left" | "exhausted";

/** Why the workflow is waiting. Closed set; adding one means adding rows. */
export const SUSPENSION_REASONS = ["needs_input", "awaiting_approval", "retry_limit", "delivery_blocked", "agent_failed"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** Where a transition lands. `@resumeState` means "wherever it suspended from". */
export type Target = Phase | "@resumeState";

export interface Transition {
  /** Stable id, e.g. "T13". Referenced by tests. */
  id: string;
  from: Phase;
  signal: Signal;
  /** Present only for signals whose target depends on the retry budget. */
  condition?: RetryCondition;
  /** Present only on transitions out of SUSPENDED, to require one reason. */
  fromReason?: SuspensionReason;
  to: Target;
  /** True when entering `to` consumes one unit of the shared retry budget. */
  incrementRetry?: boolean;
  /** Set on every transition into SUSPENDED; carries the suspension contract. */
  suspension?: {
    reason: SuspensionReason;
    resumeState: Phase;
    resumeAgent: string;
  };
  /** True when an answer from the user clears the retry budget. */
  resetRetry?: boolean;
}

const agent = (phase: Phase): string => agentForPhase(phase) ?? "planner";

/** Every route into SUSPENDED declares why, and exactly where it comes back to. */
const SUSPEND = (id: string, from: Phase, reason: SuspensionReason): Transition => ({
  id,
  from,
  signal: "status:needs_input",
  to: "SUSPENDED",
  suspension: { reason, resumeState: from, resumeAgent: agent(from) },
});

const FAILED = (id: string, from: Phase): Transition => ({
  id,
  from,
  signal: "status:failed",
  to: "SUSPENDED",
  suspension: { reason: "agent_failed", resumeState: from, resumeAgent: agent(from) },
});

/** The runtime resolved a doubt itself: same agent, same phase, budget untouched. */
const RESOLVE = (id: string, from: Phase): Transition => ({ id, from, signal: "doubt:resolved", to: from });

const ESCALATE = (id: string, from: Phase): Transition => ({
  id,
  from,
  signal: "doubt:escalated",
  to: "SUSPENDED",
  suspension: { reason: "needs_input", resumeState: from, resumeAgent: agent(from) },
});

export const TRANSITIONS: readonly Transition[] = [
  { id: "T1", from: "START", signal: "init", to: "PLANNING" },

  // The planner can never move itself to EXPLORING. It can only declare the
  // plan ready, which suspends until the user answers.
  { id: "T2", from: "PLANNING", signal: "status:complete", to: "DONE" },
  {
    id: "T3",
    from: "PLANNING",
    signal: "status:ready_for_approval",
    to: "SUSPENDED",
    suspension: { reason: "awaiting_approval", resumeState: "PLANNING", resumeAgent: "planner" },
  },
  SUSPEND("T4", "PLANNING", "needs_input"),
  FAILED("T5", "PLANNING"),
  RESOLVE("T6", "PLANNING"),
  ESCALATE("T7", "PLANNING"),

  { id: "T8", from: "EXPLORING", signal: "status:ok", to: "IMPLEMENTING" },
  SUSPEND("T9", "EXPLORING", "needs_input"),
  FAILED("T10", "EXPLORING"),
  RESOLVE("T11", "EXPLORING"),
  ESCALATE("T12", "EXPLORING"),

  { id: "T13", from: "IMPLEMENTING", signal: "status:ok", to: "REVIEWING" },
  SUSPEND("T14", "IMPLEMENTING", "needs_input"),
  FAILED("T15", "IMPLEMENTING"),
  RESOLVE("T16", "IMPLEMENTING"),
  ESCALATE("T17", "IMPLEMENTING"),

  { id: "T18", from: "REVIEWING", signal: "verdict:approved", to: "TESTING" },
  { id: "T19", from: "REVIEWING", signal: "verdict:changes_required", condition: "retries_left", to: "IMPLEMENTING", incrementRetry: true },
  {
    id: "T20",
    from: "REVIEWING",
    signal: "verdict:changes_required",
    condition: "exhausted",
    to: "SUSPENDED",
    suspension: { reason: "retry_limit", resumeState: "IMPLEMENTING", resumeAgent: "implementer" },
  },
  SUSPEND("T21", "REVIEWING", "needs_input"),
  FAILED("T22", "REVIEWING"),
  RESOLVE("T23", "REVIEWING"),
  ESCALATE("T24", "REVIEWING"),

  { id: "T25", from: "TESTING", signal: "verdict:pass", to: "DELIVERING" },
  { id: "T26", from: "TESTING", signal: "verdict:fail", condition: "retries_left", to: "IMPLEMENTING", incrementRetry: true },
  {
    id: "T27",
    from: "TESTING",
    signal: "verdict:fail",
    condition: "exhausted",
    to: "SUSPENDED",
    suspension: { reason: "retry_limit", resumeState: "IMPLEMENTING", resumeAgent: "implementer" },
  },
  SUSPEND("T28", "TESTING", "needs_input"),
  FAILED("T29", "TESTING"),
  RESOLVE("T30", "TESTING"),
  ESCALATE("T31", "TESTING"),

  // The deliverer answers "is everything ready to ship?", never "is it
  // accepted?". Acceptance is not the harness's call to make.
  { id: "T32", from: "DELIVERING", signal: "verdict:ready", to: "DONE" },
  {
    id: "T33",
    from: "DELIVERING",
    signal: "verdict:blocked",
    to: "SUSPENDED",
    // Spends the budget on entry. Without this the deliverer could block and be
    // re-run for ever: the human answering does not clean a dirty worktree.
    incrementRetry: true,
    suspension: { reason: "delivery_blocked", resumeState: "DELIVERING", resumeAgent: "deliverer" },
  },
  SUSPEND("T34", "DELIVERING", "needs_input"),
  FAILED("T35", "DELIVERING"),
  RESOLVE("T36", "DELIVERING"),
  ESCALATE("T37", "DELIVERING"),

  // Leaving SUSPENDED. `ui:approve` and `ui:revise` exist only for a plan
  // waiting on the user; `ui:stop` ends the run from any reason; `ui:answer`
  // resumes wherever the workflow suspended from, with the budget cleared
  // because the human just supplied new authority.
  { id: "T38", from: "SUSPENDED", signal: "ui:approve", fromReason: "awaiting_approval", to: "EXPLORING" },
  { id: "T39", from: "SUSPENDED", signal: "ui:revise", fromReason: "awaiting_approval", to: "PLANNING" },
  { id: "T40", from: "SUSPENDED", signal: "ui:stop", to: "DONE" },
  { id: "T41", from: "SUSPENDED", signal: "ui:answer", to: "@resumeState", resetRetry: true },
] as const;

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function isAgentPhase(phase: Phase): boolean {
  return AGENT_PHASES.includes(phase);
}

export function isSuspensionReason(value: unknown): value is SuspensionReason {
  return typeof value === "string" && (SUSPENSION_REASONS as readonly string[]).includes(value);
}

/** Resolve `@resumeState` against the phase a suspension was created in. */
export function resolveTarget(target: Target, resumeState?: Phase): Phase | null {
  if (target !== "@resumeState") return target;
  return resumeState ?? null;
}

/**
 * Resolve the transition for `(from, signal)`.
 *
 * The retry guard is evaluated here — before the caller applies anything — so
 * the counter is never incremented speculatively. `reason` is consulted only for
 * transitions out of SUSPENDED. Returns null when the signal is not legal in
 * that phase, which is how a contract violation surfaces.
 */
export function findTransition(
  from: Phase,
  signal: Signal,
  retry: number,
  maxRetries: number,
  reason: SuspensionReason | null = null,
): Transition | null {
  const candidates = TRANSITIONS.filter(
    (t) => t.from === from && t.signal === signal && (t.fromReason === undefined || t.fromReason === reason),
  );
  if (candidates.length === 0) return null;
  const guarded = candidates.filter((t) => t.condition !== undefined);
  if (guarded.length === 0) return candidates[0] ?? null;
  const wantsMore = retry < maxRetries;
  return candidates.find((t) => t.condition === (wantsMore ? "retries_left" : "exhausted")) ?? null;
}

/** Rows that share (from, signal) but differ only by guard — a table bug if > 2. */
export function ambiguousSignals(): string[] {
  const counts = new Map<string, number>();
  for (const t of TRANSITIONS) {
    const key = `${t.from}|${t.signal}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 2).map(([key]) => key);
}

/** Rows into SUSPENDED that forgot to declare their contract. */
export function suspensionsMissingContract(): string[] {
  return TRANSITIONS.filter((t) => t.to === "SUSPENDED" && !t.suspension).map((t) => t.id);
}
