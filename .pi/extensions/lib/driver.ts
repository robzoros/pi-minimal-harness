/**
 * The workflow driver: the loop that ties the state machine to real agents.
 *
 * Everything this calls already exists and is tested on its own — the state
 * machine in `state.ts`, the process in `runner.ts`, the context assembly in
 * `brief.ts`, the requirements file in `requirements.ts`. This module owns only
 * the order and the plumbing.
 *
 * A v2 workflow does NOT take over the session's turns. Each agent runs as its
 * own process and the driver waits on it, so nothing has to poll for idle, and
 * two workflows cannot interleave in one transcript.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { agentForPhase, isTerminal, type Phase } from "./transitions.ts";
import { applyAgentResult, applyUserAction, applySignal, createState, type UserAction, type WorkflowState } from "./state.ts";
import type { AgentResult } from "./result.ts";
import { withDefaults, type HarnessConfig } from "./config.ts";
import { capabilitiesToTools } from "./capabilities.ts";
import { buildBrief, summarisePrevious, type BriefContext } from "./brief.ts";
import { executeStep, type ExecuteStepOptions, type ExecuteStepOutcome } from "./runner.ts";
import { readRequirementsFile } from "./requirements.ts";
import { deserializeSuspended, serializeSuspended, type SuspendedPayload } from "./suspend.ts";

/** The session entry type a suspension is written to, so it survives /reload. */
export const SUSPENSION_ENTRY = "pi-minimal-harness:suspended";

/** Enough steps to finish a workflow plus a full retry budget, with room. */
const STEP_GUARD = 64;

export type StopReason = "done" | "suspended" | "aborted";

export interface DriverOptions {
  task: string;
  runId: string;
  config: HarnessConfig;
  /** Where `prompts/` and the requirements file live. */
  projectDir: string;
  cwd: string;
  /** The user's answer, when resuming a suspended workflow. */
  userAnswer?: string;
  /** Skip the inference below and do exactly this. */
  userAction?: UserAction;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** Injectable so the loop can be tested with fake agents. */
  execute?: (options: ExecuteStepOptions) => Promise<ExecuteStepOutcome>;
  /** Injectable so persistence can be observed without a Pi session. */
  persist?: (payload: SuspendedPayload) => void;
  /** Called before each agent runs, so the caller can show progress. */
  onStep?: (agent: string, index: number) => void;
  /** Aborting this stops the run between steps and kills the agent in flight. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  state: WorkflowState;
  stepCount: number;
  stopped: StopReason;
  /** Why the loop ended, in words the caller can show the user. */
  reason: string;
}

/**
 * Words that mean "yes, go ahead". Both languages, because the user may write
 * the answer in either.
 */
const APPROVE_WORDS = ["approve", "approved", "lgtm", "go", "go ahead", "proceed", "yes", "ok", "okay", "adelante", "vale", "si", "sí"];
const STOP_WORDS = ["stop", "cancel", "abort", "parar", "cancela", "aborta"];
const REVISE_WORDS = ["changes", "revise", "change", "cambios", "revisar", "modifica"];

/**
 * Which user action a reply means.
 *
 * Only a plan awaiting approval has a choice to infer: everywhere else the
 * answer IS the answer. When nothing matches, the default is `revise` — back to
 * planning — because advancing on a guess is the one failure that is harder to
 * undo than asking again.
 *
 * A caller that already knows (the TUI offers a choice) should pass
 * `userAction` instead of relying on this.
 */
export function inferAction(reason: string | undefined, text: string): UserAction {
  if (reason !== "awaiting_approval") return "answer";
  const lowered = String(text ?? "").toLowerCase();
  if (STOP_WORDS.some((w) => lowered.includes(w))) return "stop";
  if (APPROVE_WORDS.some((w) => lowered.includes(w))) return "approve";
  if (REVISE_WORDS.some((w) => lowered.includes(w))) return "revise";
  return "revise";
}

/** Read and parse the configuration from disk; defaults fill what is absent. */
export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const parsed = await fs.readFile(configPath, "utf8").catch(() => "");
  const { parseConfig } = await import("./config.ts");
  const result = parseConfig(parsed);
  return withDefaults(result.config ?? { agents: {} });
}

/** Rebuild a suspended workflow from the last suspension in the session. */
export function restoreFromEntries(entries: unknown[]): WorkflowState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== SUSPENSION_ENTRY) continue;
    const suspended = deserializeSuspended(entry.data);
    if (!suspended) return null;
    return {
      phase: "SUSPENDED",
      runId: suspended.runId,
      task: suspended.task,
      retry: suspended.retry,
      maxRetries: suspended.maxRetries,
      suspended,
      resolvedDoubt: null,
      lastResult: null,
      history: [],
    };
  }
  return null;
}

/**
 * Run a workflow to a terminal phase.
 *
 * `start` resumes a suspended workflow: the user's answer is applied first, and
 * only then does the loop resume. Starting fresh is just `start` undefined.
 */
export async function runWorkflow(options: DriverOptions, start?: WorkflowState): Promise<RunOutcome> {
  const config = withDefaults(options.config);
  const execute = options.execute ?? ((o: ExecuteStepOptions) => executeStep(o));
  const notify = options.notify ?? (() => {});
  const requirements = await loadRequirements(config, options.projectDir);

  let state: WorkflowState;
  if (start && start.phase === "SUSPENDED") {
    const action = options.userAction ?? inferAction(start.suspended?.reason, options.userAnswer ?? "");
    const resumed = applyUserAction(start, action, options.userAnswer);
    if (!resumed.ok) return { state: start, stepCount: 0, stopped: "aborted", reason: resumed.error };
    state = resumed.state;
  } else if (start) {
    state = start;
  } else {
    const init = applySignal(createState({ runId: options.runId, task: options.task, maxRetries: config.maxRetries }), "init");
    if (!init.ok) return { state: createState({ runId: options.runId, task: options.task, maxRetries: config.maxRetries }), stepCount: 0, stopped: "aborted", reason: init.error };
    state = init.state;
  }

  let stepCount = 0;
  while (!isTerminal(state.phase)) {
    if (options.signal?.aborted) {
      // Between steps, not inside one: the signal is also handed to the agent
      // process, so an abort during a long step kills it too.
      return { state, stepCount, stopped: "aborted", reason: "you stopped the workflow" };
    }
    if (++stepCount > STEP_GUARD) {
      return { state, stepCount, stopped: "aborted", reason: `stopped after ${STEP_GUARD} steps without reaching a terminal phase` };
    }
    const phase = state.phase;
    const agent = agentForPhase(phase);
    if (!agent) return { state, stepCount, stopped: "aborted", reason: `phase ${phase} runs no agent` };

    if (options.onStep) options.onStep(agent, stepCount);
    const outcome = await execute(buildStep(phase, agent, state, config, options, requirements));
    if (options.signal?.aborted) {
      return { state, stepCount, stopped: "aborted", reason: "you stopped the workflow" };
    }

    if (!outcome.ok) {
      // Either the agent produced nothing usable or its process failed. Both
      // become the agent reporting it cannot continue, which is what the table
      // knows how to suspend on.
      const failed: AgentResult = {
        status: "failed",
        summary: outcome.transportError ?? outcome.result?.summary ?? "the agent returned no usable result",
      };
      const applied = applyAgentResult(state, failed);
      if (!applied.ok) return { state, stepCount, stopped: "aborted", reason: applied.error };
      state = applied.state;
      continue;
    }

    const applied = applyAgentResult(state, outcome.result);
    if (!applied.ok) {
      const detail = applied.errors?.join("; ") ?? applied.error;
      notify(`Step ${agent} returned something the workflow cannot use: ${detail}`, "error");
      return { state, stepCount, stopped: "aborted", reason: `the ${agent} agent returned an invalid result: ${detail}` };
    }
    state = applied.state;
  }

  if (state.phase === "DONE") {
    return { state, stepCount, stopped: "done", reason: "the workflow finished" };
  }
  if (state.phase === "SUSPENDED" && state.suspended) {
    const payload = serializeSuspended(state.suspended);
    if (payload.ok && payload.payload && options.persist) options.persist(payload.payload);
    // A delivery blocked past the budget will not resolve itself by asking
    // again. Say so plainly instead of suspending indefinitely.
    if (state.suspended.reason === "delivery_blocked" && state.retry >= config.maxRetries) {
      return {
        state,
        stepCount,
        stopped: "aborted",
        reason: `the deliverer is still blocked after ${state.retry} attempts (${config.maxRetries} allowed); the blocker is not something an answer fixes — fix it and run again`,
      };
    }
    return { state, stepCount, stopped: "suspended", reason: state.suspended.question.question };
  }
  return { state, stepCount, stopped: "aborted", reason: "the workflow stopped without reaching a terminal phase" };
}

async function loadRequirements(config: HarnessConfig, projectDir: string): Promise<string> {
  const file = await readRequirementsFile(path.resolve(projectDir, config.requirementsFile));
  if (!file.exists || file.requirements.length === 0) return "";
  return file.requirements
    .map((r) => `${r.id} [${r.status}] ${r.title}\n  acceptance: ${r.acceptance ?? "(none)"}${r.changes?.length ? `\n  changes: ${r.changes.join(", ")}` : ""}`)
    .join("\n");
}

function buildStep(
  phase: Phase,
  agent: string,
  state: WorkflowState,
  config: HarnessConfig,
  options: DriverOptions,
  requirements: string,
): ExecuteStepOptions {
  const settings = config.agents[agent] ?? { name: agent, capabilities: [] };
  const mapping = capabilitiesToTools(settings.capabilities);
  const context: BriefContext = {
    task: state.task,
    requirements,
    previousSummary: summarisePrevious(state.lastResult),
    resolvedDoubt: state.resolvedDoubt?.note,
    userAnswer: options.userAnswer,
  };
  return {
    phase,
    agent,
    cwd: options.cwd,
    promptPath: path.resolve(options.projectDir, "prompts", `${agent}.md`),
    brief: buildBrief(phase, context),
    model: settings.model,
    thinking: settings.reasoning,
    tools: mapping.tools,
    timeoutMs: config.agentTimeoutMs,
    signal: options.signal,
    // No systemPromptDir on purpose. Pi's --append-system-prompt takes a PATH,
    // so the composed prompt has to be a file somewhere — but not inside the
    // user's repository. The runner falls back to os.tmpdir(), which is what
    // the OS already cleans, and it deletes the file in its finally either way.
  };
}
