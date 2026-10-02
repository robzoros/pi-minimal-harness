/**
 * Which doubts the runtime answers, and which it hands to the user.
 *
 * The orchestrator is deterministic, so "it cannot resolve the doubt" has to be
 * a CHECKABLE criterion rather than a judgement. The cut:
 *
 *   - Facts you can read in the repository or in the configuration: resolved.
 *   - Intent only the user can decide: escalated, always.
 *
 * The user-mandatory list wins even when a doubt looks checkable. That is the
 * whole point of it: "you asked" means you asked, not "we inferred you would
 * have said yes".
 *
 * NOTE ON SCOPE: this module decides WHETHER a doubt is resolvable. It does not
 * produce the resolution. These modules are pure and have no repository access,
 * so the resolved fact is supplied by the driver that wires the runtime to the
 * working tree. `state.ts` records the decision so that driver can act on it.
 */

import type { Question } from "./result.ts";

/** Topics the user always decides, no matter how checkable the doubt looks. */
export const USER_MANDATORY_TOPICS = ["scope", "requirement", "behavior", "architecture", "strategy", "acceptance"] as const;
export type UserMandatoryTopic = (typeof USER_MANDATORY_TOPICS)[number];

/**
 * Topics the runtime answers from the repository or the configuration. Anything
 * here is a fact, not an opinion: where a file is, which key exists, which
 * branch is the default, whether a tool is registered, which fallback applies.
 *
 * The names match what an agent actually puts in `question.topic` — including
 * the capability names, because "codegraph is not installed" and "graph is
 * unavailable" are the same doubt asked two ways.
 */
export const RUNTIME_RESOLVABLE_TOPICS = [
  "repository",
  "configuration",
  "requirements_file",
  "tooling",
  "environment",
  "graph",
  "memory",
  "degradation",
] as const;
export type RuntimeResolvableTopic = (typeof RUNTIME_RESOLVABLE_TOPICS)[number];

export type DoubtTopic = UserMandatoryTopic | RuntimeResolvableTopic | string;

export type DoubtDecision =
  | { decision: "escalate"; topic: string; reason: "user_mandatory" | "unknown_topic" }
  | { decision: "resolve"; topic: string; reason: "runtime_resolvable" };

/** A known degradation the runtime can settle without the user. */
export const DEGRADATIONS: Readonly<Record<string, string>> = {
  graph: "Structural exploration is unavailable; use grep/rg over the repository and say so in your report.",
  memory: "Memory tools are unavailable; carry your findings in the lessons field of your report.",
  tooling: "The requested tool is not registered; report what you could not run and why.",
  environment: "The check could not run in this environment; report it as skipped, with the reason.",
  degradation: "The known fallback for this capability applies; continue with it and say so.",
};

/**
 * Classify a doubt. Deterministic and total: anything unknown escalates, which
 * is the safe default when the orchestrator does not recognise the topic.
 */
export function classifyDoubt(topic: string | undefined): DoubtDecision {
  const name = String(topic ?? "").trim().toLowerCase();
  if (name === "") return { decision: "escalate", topic: "", reason: "unknown_topic" };
  if ((USER_MANDATORY_TOPICS as readonly string[]).includes(name)) {
    return { decision: "escalate", topic: name, reason: "user_mandatory" };
  }
  if ((RUNTIME_RESOLVABLE_TOPICS as readonly string[]).includes(name)) {
    return { decision: "resolve", topic: name, reason: "runtime_resolvable" };
  }
  return { decision: "escalate", topic: name, reason: "unknown_topic" };
}

/** Convenience for a whole question object. */
export function classifyQuestion(question: Question | undefined): DoubtDecision {
  return classifyDoubt(question?.topic);
}

/** The text the runtime hands the agent when it settles a doubt itself. */
export function resolutionText(topic: string): string {
  return DEGRADATIONS[topic] ?? "The orchestrator resolved this from the repository and the configuration; proceed.";
}
