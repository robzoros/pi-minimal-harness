/**
 * The brief each agent receives.
 *
 * The brief is the agent's whole world: the process runs with `--no-session`,
 * so there is no transcript to leak context in. What is not in the brief does
 * not reach the model.
 *
 * Deliberately absent: the field names of the result envelope. Those are
 * rendered into the system prompt from `result.ts` (see `renderResultContract`
 * in `runner.ts`), so the runtime stays the single source and the brief stays
 * about the work.
 */

import { agentForPhase, type Phase } from "./transitions.ts";
import type { AgentResult } from "./result.ts";

// The phase -> agent map is workflow data and lives in transitions.ts. Re-exported
// here because a brief is the first place a caller needs it; one list, not two.
export { AGENT_FOR_PHASE, agentForPhase } from "./transitions.ts";

export interface BriefContext {
  task: string;
  /** Rendered requirements, or a pointer to them. */
  requirements?: string;
  /** Explorer findings, for the implementer. */
  findings?: string;
  /** The reviewer's summary, when this run is a re-implementation loop. */
  previousSummary?: string;
  changedFiles?: string[];
  diffStat?: string;
  acceptanceCriteria?: string;
  traceability?: string;
  issue?: string;
  branch?: string;
  /** Answer to a previous question, when re-entering PLANNING. */
  userAnswer?: string;
  /** What the orchestrator settled itself, so the agent is not asked again. */
  resolvedDoubt?: string;
  /** Prior question/answer pairs, so a re-entered planner keeps its thread. */
  qaHistory?: string[];
}

/**
 * Language contract.
 *
 * Agents talk to each other in English: the next agent reads this agent's
 * summary, findings and checks, and a mixed-language brief is a worse brief.
 * The single exception is the question, which the runtime hands to the user
 * verbatim, and the delivery that reaches the user at the end.
 */
export const LANGUAGE_RULE =
  "Everything you put in the result envelope is English, because the next agent is the one who reads it. The one exception is the question: it goes to the user unchanged, so write it in the language the user is using.";

/**
 * Reinforces the reply shape without naming any field: the field names and the
 * enums arrive from `result.ts` via the system prompt, so stating them here too
 * would be the duplication D2 exists to avoid.
 */
export const REPLY_RULE = "Reply with a single JSON object and nothing else — no prose before or after it.";

const section = (title: string, body?: string): string => (body && body.trim() ? `## ${title}\n${body.trim()}` : "");

const list = (items: string[] | undefined): string => (items && items.length > 0 ? items.map((p) => `- ${p}`).join("\n") : "");

/** Fixed, per-phase framing of what this agent is being asked for right now. */
const ROLE_FRAME: Partial<Record<Phase, string>> = {
  PLANNING: "Understand the request, surface ambiguities, maintain the requirements file, and ask for anything you cannot decide alone. Approve only a plan you are confident in.",
  EXPLORING: "Establish the technical context the approved plan needs. Locate the files, dependencies, affected components and risks. Report; change nothing.",
  IMPLEMENTING: "Carry out the approved plan. This is the only phase that changes files. If a requirement turns out to be ambiguous or contradictory, ask instead of deciding.",
  REVIEWING: "Review the changes against the approved requirements. Flag anything that cannot be traced to one, plus regressions and quality problems. Do not fix them.",
  TESTING: "Run the checks the acceptance criteria call for and report their real outcome. Never claim a check you did not run.",
  DELIVERING: "Verify traceability end to end before delivering. Refuse to deliver if a requirement is untraced, a check failed, or the changelog is stale.",
};

const AGGREGATE = [REPLY_RULE, LANGUAGE_RULE].join("\n");

export function buildBrief(phase: Phase, ctx: BriefContext): string {
  if (!agentForPhase(phase)) {
    throw new Error(`phase ${phase} runs no agent and has no brief`);
  }
  const parts: string[] = [];
  parts.push(`# Task\n${ctx.task}`);
  const frame = ROLE_FRAME[phase];
  if (frame) parts.push(`## What this step does\n${frame}`);
  const requirement = section("Requirements", ctx.requirements);
  if (requirement) parts.push(requirement);
  if (ctx.findings) parts.push(section("Exploration findings", ctx.findings));
  if (ctx.previousSummary) parts.push(section("Previous review", ctx.previousSummary));
  const changed = section("Changed files", list(ctx.changedFiles));
  if (changed) parts.push(changed);
  if (ctx.diffStat) parts.push(section("Diff", ctx.diffStat));
  if (ctx.acceptanceCriteria) parts.push(section("Acceptance criteria", ctx.acceptanceCriteria));
  if (ctx.traceability) parts.push(section("Traceability", ctx.traceability));
  if (ctx.issue || ctx.branch) parts.push(section("Delivery context", [ctx.issue && `Issue: ${ctx.issue}`, ctx.branch && `Branch: ${ctx.branch}`].filter(Boolean).join("\n")));
  if (ctx.resolvedDoubt) parts.push(section("Answered by the orchestrator", ctx.resolvedDoubt));
  if (ctx.userAnswer) parts.push(section("Answer from the user", ctx.userAnswer));
  if (ctx.qaHistory && ctx.qaHistory.length > 0) parts.push(section("Earlier questions", ctx.qaHistory.join("\n")));
  parts.push(AGGREGATE);
  return parts.filter(Boolean).join("\n\n");
}

/**
 * What the brief says to an agent that produced an unusable result.
 * Names the concrete problems rather than asking for "a valid report", so the
 * repair costs one turn rather than two.
 */
export function buildRepairBrief(brief: string, errors: readonly string[]): string {
  return (
    `Your previous reply could not be used.\n\nProblems:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    "Reply with a single JSON object matching the result contract and nothing else. Do not add prose around it.\n\n" +
    "--- the original brief follows ---\n\n" +
    brief
  );
}

/** Fold a result's own summary into the next agent's context. */
export function summarisePrevious(result: AgentResult | null): string | undefined {
  return result?.summary && result.summary.trim() !== "" ? result.summary.trim() : undefined;
}
