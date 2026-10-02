/**
 * Running one agent as an isolated `pi` process.
 *
 * The process gets `--no-session`, so the brief really is the agent's whole
 * context, and `--append-system-prompt` carrying its prompt template plus the
 * result contract rendered from `result.ts`.
 *
 * Retry policy (decisions D3 and D5):
 *   - transport failure (spawn, non-zero exit, timeout, abort) -> respawn ONCE
 *   - contract failure (no JSON, wrong shape, wrong meaning) -> repair ONCE
 * These are kept apart on purpose: a crash is not the agent's fault and should
 * not cost it a repair turn, and a bad reply is not a crash and should not
 * cost it a respawn.
 *
 * KNOWN TEMPORARY DUPLICATION: `getPiInvocation` below is copied from
 * harness.ts:1182. It is not imported on purpose — importing it would couple
 * the pure modules to the monolith this rewrite replaces. harness.ts keeps its
 * own copy until Phase 5 deletes it.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RESULT_STATUSES, RESULT_VERDICTS, CHECK_RESULTS, type AgentResult } from "./result.ts";
import { readEnvelopeFor } from "./extract.ts";
import { buildRepairBrief } from "./brief.ts";
import type { Phase } from "./transitions.ts";

/** Reference default; reading it from the YAML is Phase 3's job. */
export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

/** The shape of Pi's model registry that we depend on. */
export type ModelCatalog = { getAvailable(): PiModel[]; getAll(): PiModel[] };

export type PiModel = { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | undefined };
export type ThinkingLevelArg = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EXTENDED_THINKING_LEVELS: readonly ThinkingLevelArg[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Resolve `provider/id` exactly, or a bare legacy id. Never guesses. */
export function findModelRef(ref: string, catalog: ModelCatalog): PiModel | undefined {
  const all = [...catalog.getAvailable(), ...catalog.getAll()];
  return all.find((m) => `${m.provider}/${m.id}` === ref) ?? all.find((m) => m.id === ref);
}

/**
 * Reasoning efforts a model actually supports.
 *
 * Pi exposes `off` for models without reasoning; `xhigh` and `max` only appear
 * when the model maps them. Asking for an unsupported level leaves the model
 * clamped rather than failing, so this is what /harness-model offers.
 */
export function supportedReasoningLevels(model: PiModel): (ThinkingLevelArg | "off")[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export interface RunAgentOptions {
  cwd: string;
  agent: string;
  /** Path to the agent's prompt template. */
  promptPath: string;
  brief: string;
  model?: string;
  thinking?: string;
  /** Resolved Pi tool names from `capabilitiesToTools`; omit when empty. */
  tools?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnFn?: typeof spawn;
  /** Called as the agent works. Omit it and the extra parsing costs almost nothing. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Overridable so tests never launch a real `pi`. May be a thunk so a retry
   * test can hand out a different invocation per attempt — same idea as
   * `spawnFn`.
   */
  invocation?: { command: string; prefixArgs: string[] } | (() => { command: string; prefixArgs: string[] });
}

export interface RunAgentOutcome {
  ok: boolean;
  text?: string;
  exitCode?: number | null;
  stopReason?: string;
  /** Present when `ok` is false: why the transport failed. */
  transportError?: string;
}

/**
 * How to launch another Pi process from inside a Pi extension.
 *
 * Resolution is EXPLICIT, in this order, because guessing is what broke:
 *
 *  1. `PI_LAUNCHER`, for an install somewhere unusual.
 *  2. `<pi bin>/pi-launcher.js` next to the running entry point. `pi.cmd` on
 *     Windows is literally `node "%~dp0pi-launcher.js" %*`, so the launcher is
 *     the one invocation that behaves the same on every platform.
 *  3. The documented install location, under `os.homedir()` — NOT `$HOME`,
 *     which on this machine pointed at the project directory and found nothing.
 *  4. The running script itself, if it really is JavaScript.
 *  5. `pi` on PATH, as `pi.cmd` on Windows, because a bare `pi` there is a shell
 *     script that `spawn` cannot execute without a shell.
 *
 * The old heuristic returned `node <process.argv[1]>` whenever that path
 * existed. Under an extension the entry point is a loader, not Pi's CLI, so it
 * produced `node <loader> --mode json …` and the agent process died with exit 1.
 */
export function getPiInvocation(env: NodeJS.ProcessEnv = process.env, argv1: string | undefined = process.argv[1]): { command: string; prefixArgs: string[] } {
  const launcherName = "pi-launcher.js";
  const isJs = (p: string | undefined): boolean => Boolean(p && /\.(c|m)?js$/i.test(p));

  const configured = env.PI_LAUNCHER;
  if (configured && existsSync(configured)) return { command: process.execPath, prefixArgs: [configured] };

  if (isJs(argv1)) {
    let dir = path.dirname(argv1 as string);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, launcherName);
      if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  try {
    const installed = path.join(os.homedir(), ".pi", "agent", "bin", launcherName);
    if (existsSync(installed)) return { command: process.execPath, prefixArgs: [installed] };
  } catch {
    // no home directory; fall through to PATH
  }

  if (isJs(argv1) && existsSync(argv1 as string)) {
    return { command: process.execPath, prefixArgs: [argv1 as string] };
  }
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", prefixArgs: [] };
}

export interface ModelChoice {
  model: PiModel;
  /** False when the provider is not authenticated for it. */
  usable: boolean;
  label: string;
}

/**
 * The models worth OFFERING an agent.
 *
 * `getAll()` lists everything the catalog knows, which on a machine with one
 * authenticated provider is mostly models that cannot be called. `/models` shows
 * the usable set; this must match it, or /harness-model offers the user a
 * choice that fails minutes later.
 *
 * `getAvailable()` is the set Pi itself considers usable, and it is the ONLY
 * source of that answer. `getAll()` still contributes to the LIST, so you can
 * see what exists — but never to the usable set, which is the point.
 */
export function modelChoices(catalog: ModelRegistryLike, hasAuth?: (m: PiModel) => boolean): ModelChoice[] {
  // Usability comes from getAvailable() ALONE. Falling back to getAll() here
  // would mark as usable exactly the models the user cannot call, which is the
  // bug this function exists to fix.
  const usableIds = new Set(catalog.getAvailable().map((m) => `${m.provider}/${m.id}`));
  const all = [...catalog.getAvailable(), ...catalog.getAll()];
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const model of all) {
    const id = `${model.provider}/${model.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const usable = usableIds.has(id) && (hasAuth ? hasAuth(model) : true);
    choices.push({ model, usable, label: usable ? id : `${id} (no auth)` });
  }
  return choices.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    if (a.model.provider !== b.model.provider) return a.model.provider.localeCompare(b.model.provider);
    return a.model.id.localeCompare(b.model.id);
  });
}

/** The model registry surface this needs; structurally satisfied by Pi's. */
export interface ModelRegistryLike {
  getAll(): PiModel[];
  getAvailable(): PiModel[];
}

/**
 * Turn one raw JSON record into at most one AgentEvent.
 *
 * Deliberately lossy: a rolling panel wants "bash: npm test", not the full
 * argument object and not every token of a streamed answer. `text_delta` is
 * dropped entirely and the completed message is reported once instead.
 */
function forward(opts: RunAgentOptions, record: Record<string, unknown>): void {
  if (!opts.onEvent) return;
  const type = record.type;
  if (type === "tool_execution_start") {
    const tool = typeof record.toolName === "string" ? record.toolName : "tool";
    opts.onEvent({ kind: "tool_start", tool, detail: describeToolCall(tool, record.args) });
    return;
  }
  if (type === "tool_execution_end") {
    opts.onEvent({
      kind: "tool_end",
      tool: typeof record.toolName === "string" ? record.toolName : "tool",
      ok: record.isError !== true,
    });
  }
}

/** Argument vector for one agent process. The brief is the prompt. */
export function buildAgentArgs(opts: {
  promptPath: string;
  brief: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", opts.promptPath];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  args.push(opts.brief);
  return args;
}

/**
 * The result contract, rendered from `result.ts` so it is never written twice.
 *
 * The enum values are interpolated from the exported constants, which is what
 * makes "result.ts is the single source" testable: a new status cannot reach
 * the prompts without reaching this prompt too. The structural field names live
 * here rather than in the interface because they describe the wire shape, not
 * the TypeScript shape.
 */
export function renderResultContract(): string {
  return [
    "## Result contract",
    "",
    "Reply with a single JSON object and nothing else.",
    "",
    `- status: one of ${RESULT_STATUSES.join(", ")}`,
    "- summary: non-empty string, in English — the next agent reads it",
    `- verdict: one of ${RESULT_VERDICTS.join(", ")} — only from the planner, reviewer and tester, and only when status is "ok"`,
    `- question: { topic, question, options? } — required when status is "${"needs_input"}". Write it in the language the user is using: it is the one field the user reads`,
    "- requirements: { touched: [string], untraceable: [string] }",
    `- checks: [{ command: string, result: one of ${CHECK_RESULTS.join(", ")} }]`,
  ].join("\n");
}

/** Compose the system prompt: the agent's template, then the generated contract. */
export function composeSystemPrompt(template: string, contract = renderResultContract()): string {
  return `${template.trimEnd()}\n\n---\n\n${contract.trim()}\n`;
}

interface MessageEndEvent {
  type?: string;
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

/** Run the agent once and collect the last assistant text it emitted. */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentOutcome> {
  const spawnFn = opts.spawnFn ?? spawn;
  const chosen = opts.invocation ?? getPiInvocation();
  const invocation = typeof chosen === "function" ? chosen() : chosen;
  const argv = [...invocation.prefixArgs, ...buildAgentArgs(opts)];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  return await new Promise<RunAgentOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    const spawnOptions: SpawnOptions = { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], signal: opts.signal };
    try {
      child = spawnFn(invocation.command, argv, spawnOptions);
    } catch (error) {
      resolve({ ok: false, transportError: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let buffer = "";
    let lastText = "";
    opts.onEvent?.({ kind: "agent_started" });
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);

    const finish = (outcome: RunAgentOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      forward(opts, record);
      if (record.type !== "message_end") return;
      const message = record.message as
        | { role?: string; stopReason?: string; errorMessage?: string; content?: { type?: string; text?: string }[] }
        | undefined;
      if (message?.role !== "assistant") return;
      stopReason = message.stopReason ?? stopReason;
      errorMessage = message.errorMessage ?? errorMessage;
      const text = (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      if (text.trim()) {
        lastText = text;
        opts.onEvent?.({ kind: "text", text });
      }
    };

    child.stdout?.on("data", (data: unknown) => {
      buffer += String(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.on("error", (error: Error) => {
      finish({ ok: false, transportError: `process error: ${error.message}` });
    });

    child.on("close", (code: number | null) => {
      if (buffer.trim()) handleLine(buffer);
      if (timedOut) {
        finish({ ok: false, exitCode: code, stopReason, transportError: `agent timed out after ${timeoutMs}ms` });
        return;
      }
      if (opts.signal?.aborted) {
        finish({ ok: false, exitCode: code, stopReason, transportError: "aborted" });
        return;
      }
      if (errorMessage || stopReason === "error") {
        finish({ ok: false, exitCode: code, stopReason, text: lastText, transportError: errorMessage ?? "model error" });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, exitCode: code, stopReason, text: lastText, transportError: `agent exited with code ${code}` });
        return;
      }
      opts.onEvent?.({ kind: "agent_finished", text: lastText });
      finish({ ok: true, exitCode: code, stopReason, text: lastText });
    });
  });
}

export interface ExecuteStepOptions extends RunAgentOptions {
  phase: Phase;
  /** D5: respawns after a transport failure. Default 1. */
  maxTransportRetries?: number;
  /** D3: repair turns after a contract failure. Default 1. */
  maxRepairs?: number;
  /** Where the composed system prompt is written; defaults to the OS temp dir. */
  systemPromptDir?: string;
}

/**
 * What an agent is doing, as it does it.
 *
 * Pi's JSON mode emits tool_execution_start/end and streaming text for every
 * step. The runner used to read all of it, keep only the last assistant message,
 * and discard the rest — so a step that took two minutes was two minutes of
 * silence. These events are the difference between "it is working" and "it is
 * stuck", and they cost nothing extra: the bytes were already crossing the pipe.
 */
export type AgentEvent =
  | { kind: "agent_started" }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; tool: string; detail: string }
  | { kind: "tool_end"; tool: string; ok: boolean }
  | { kind: "agent_finished"; text: string };

/** One readable line about what a tool is being asked to do. */
export function describeToolCall(tool: string, args: unknown): string {
  const record = args as Record<string, unknown> | null;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return "";
  };
  const command = pick("command", "cmd", "pattern", "path", "file_path", "query", "url");
  const oneLine = command.replace(/\s+/g, " ").slice(0, 90);
  return oneLine === "" ? "" : oneLine;
}

export interface AttemptRecord {
  kind: "transport" | "contract";
  reason: string;
}

export interface ExecuteStepOutcome {
  ok: boolean;
  result?: AgentResult;
  text?: string;
  attempts: AttemptRecord[];
  transportError?: string;
  contractErrors?: string[];
  attemptsUsed?: number;
}

/**
 * One agent step end to end: compose the prompt, run, read the envelope, and
 * apply the retry policy. On final failure it returns the `status: failed`
 * envelope the state machine turns into SUSPENDED, so a dead step never leaves
 * the workflow with nothing to report.
 */
export async function executeStep(opts: ExecuteStepOptions): Promise<ExecuteStepOutcome> {
  const maxTransportRetries = opts.maxTransportRetries ?? 1;
  const maxRepairs = opts.maxRepairs ?? 1;
  const attempts: AttemptRecord[] = [];

  let template: string;
  try {
    template = await fs.readFile(opts.promptPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      attempts,
      transportError: `prompt template unreadable at ${opts.promptPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const dir = opts.systemPromptDir ?? os.tmpdir();
  const systemPromptPath = path.join(dir, `harness-system-${opts.agent}-${process.pid}.md`);
  try {
    // The directory is ours, not the user's: create it rather than assuming it
    // is there. On a fresh checkout it never is, and a missing directory turned
    // into "cannot write system prompt" instead of a run.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(systemPromptPath, composeSystemPrompt(template), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    return { ok: false, attempts, transportError: `cannot write the system prompt into ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let brief = opts.brief;
  const runOptions: RunAgentOptions = { ...opts, promptPath: systemPromptPath, brief };

  try {
    let transportTries = 0;
    let contractTries = 0;
    let contractErrors: string[] = [];

    for (;;) {
      const run = await runAgent({ ...runOptions, brief });
      if (!run.ok) {
        attempts.push({ kind: "transport", reason: run.transportError ?? "unknown transport failure" });
        if (transportTries < maxTransportRetries) {
          transportTries++;
          continue;
        }
        return {
          ok: false,
          attempts,
          attemptsUsed: transportTries + 1,
          transportError: run.transportError,
          text: run.text,
        };
      }

      const envelope = readEnvelopeFor(run.text ?? "", opts.phase);
      if (envelope.valid && envelope.result) {
        return { ok: true, result: envelope.result, text: run.text, attempts, attemptsUsed: attempts.length + 1 };
      }

      contractErrors = envelope.errors;
      attempts.push({ kind: "contract", reason: contractErrors.join("; ") });
      if (contractTries < maxRepairs) {
        contractTries++;
        brief = buildRepairBrief(opts.brief, contractErrors);
        continue;
      }

      return {
        ok: false,
        attempts,
        attemptsUsed: contractErrors.length > 0 ? attempts.length : attempts.length,
        contractErrors,
        text: run.text,
        result: {
          status: "failed",
          summary: `The ${opts.agent} agent returned no usable result after ${contractTries} repair turn(s): ${contractErrors.join("; ")}`,
        },
      };
    }
  } finally {
    await fs.rm(systemPromptPath, { force: true }).catch(() => {
      // best effort cleanup
    });
  }
}
