/**
 * Harness extension for Corpustory.
 *
 * Project-local (`.pi/extensions/`), registers:
 *
 *   /harness-config   configuration menu (mode, models, validation, auto-harness)
 *   /harness-mode     pick the default workflow mode (menu or direct argument)
 *   /harness-model    pick an agent model and effort from Pi's catalog (menu or arguments)
 *   /harness-run      run a task through the workflow pipeline (forced sequence)
 *   /harness-delivery deliver the current changes without changing workflow mode
 *   /harness-auto     show/toggle auto-harness (plain requests run the pipeline)
 *
 * Plus an `input` hook: when `defaults.auto_harness` is true, any plain
 * (non-slash) request is consumed and executed through the pipeline instead of
 * going straight to the model.
 *
 * Pipeline driver: reads `workflows.<mode>.steps` from harness.config.yaml and,
 * for each step, switches to that agent's configured model + reasoning level,
 * renders its prompt template, sends it as the next user turn, waits for the
 * turn to finish, and passes control to the next step. The runtime sequences
 * the steps — the model cannot skip them.
 *
 * Reads and edits `harness.config.yaml` (repo root) or, when adopted,
 * `.agents/harness/harness.config.yaml`. No external dependencies: the YAML
 * is edited with indentation-aware line operations to preserve formatting.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const MODES: Array<{ id: string; steps: string; when: string }> = [
  { id: "simple", steps: "orchestrator -> implementer", when: "small and clear changes" },
  { id: "full-dry-run", steps: "orchestrator -> explorer -> critic", when: "exploration and critique without editing files" },
  { id: "full", steps: "orchestrator -> explorer -> critic -> implementer -> delivery", when: "non-trivial tasks that should end in a pull request" },
  { id: "implementation-only", steps: "orchestrator -> implementer", when: "exploration and critique already happened, or a complete plan is provided" },
  { id: "delivery-only", steps: "orchestrator -> delivery", when: "changes already exist locally and only branch/commit/push/PR is needed" },
];
const MODE_IDS = MODES.map((m) => m.id);
const REQUIRED_AGENTS = ["orchestrator", "explorer", "critic", "implementer", "delivery"];
const STATUS_KEY = "corpustory-harness-mode";
const DISPATCH_WIDGET_KEY = "corpustory-harness-dispatch";
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const EXTENDED_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REPOSITORY_COMMAND_TIMEOUT_MS = 2000;

type PiModel = Parameters<ExtensionAPI["setModel"]>[0];
type ThinkingLevelArg = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type ReasoningLevelArg = ThinkingLevelArg | "off";

/** Last orchestrator decision recorded for this runtime (shown in the footer). */
let lastDecision: HarnessDecision = null;

/** Justification the orchestrator gave with the decision tool, if any. */
let lastDecisionReason = "";

/** Structured report of the step that just finished, when it used the tool. */
let lastReport: HarnessReport | null = null;

/** True while a pipeline is running: the harness tools are inert outside one. */
let pipelineActive = false;

export type CheckResult = "passed" | "failed" | "skipped";

export interface HarnessReport {
  /** null when the field was omitted; [] when it was passed with nothing in it. */
  changedFiles: string[] | null;
  checks: { command: string; result: CheckResult }[] | null;
  lessons: string[] | null;
  notes: string;
}

/** Normalize a decision argument from a tool call: models are case-sloppy. */
export function normalizeDecision(value: unknown): HarnessDecision {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  if (key === "ANSWER_ONLY") return "answer_only";
  if (key === "PIPELINE") return "pipeline";
  return null;
}

/** Normalize one check result from a tool call; unknown values read as skipped. */
function normalizeCheckResult(value: unknown): CheckResult {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (key === "passed" || key === "pass" || key === "ok") return "passed";
  if (key === "failed" || key === "fail") return "failed";
  return "skipped";
}

/**
 * Normalize the `lessons` field of a report: null when the agent left it out
 * or sent nothing usable in it, [] when it deliberately said "nothing to
 * record". A single string is accepted because models send one instead of a
 * one-element list often enough to be worth tolerating.
 */
export function normalizeLessons(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : null;
  }
  if (!Array.isArray(value)) return null;
  const lessons = value.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim());
  return lessons.length > 0 || value.length === 0 ? lessons : null;
}

/** Last pipeline progress line shown in the footer (null when no run is active). */
let lastProgress: string | null = null;

/** Compose the footer status text: mode, optional pipeline progress, decision, auto state. */
function formatStatus(mode: string | null, auto: boolean, progress?: string, decision?: HarnessDecision): string {
  const parts = [`harness: ${mode ?? "none"}`];
  if (progress) parts.push(progress);
  if (decision) parts.push(`decision: ${decision}`);
  parts.push(`auto: ${auto ? "on" : "off"}`);
  return parts.join(" · ");
}

/** Show the current workflow mode and auto-harness state in the Pi TUI footer/status bar. */
async function refreshModeStatus(ctx: ExtensionContext): Promise<void> {
  try {
    const configPath = await resolveConfigPath(ctx.cwd);
    if (!configPath) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const lines = await readLines(configPath);
    ctx.ui.setStatus(STATUS_KEY, formatStatus(getWorkflowMode(lines), isAutoHarness(lines), lastProgress ?? undefined, lastDecision));
  } catch {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

/**
 * Progress line once the orchestrator's decision is known: a direct answer is
 * one step of one (`1/1 <first>`), a pipeline re-states the real total.
 */
async function computeDecisionProgress(
  ctx: ExtensionContext,
  decision: Exclude<HarnessDecision, null>,
): Promise<string | null> {
  try {
    const configPath = await resolveConfigPath(ctx.cwd);
    if (!configPath) return null;
    const lines = await readLines(configPath);
    const mode = getWorkflowMode(lines);
    const steps = mode ? getWorkflowSteps(lines, mode) : null;
    const first = steps && steps.length > 0 ? steps[0] : "orchestrator";
    return decision === "answer_only"
      ? `1/1 ${first}`
      : `1/${steps && steps.length > 0 ? steps.length : "?"} ${first}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config location and line helpers
// ---------------------------------------------------------------------------

export async function resolveConfigPath(cwd: string): Promise<string | null> {
  const candidates = [
    path.join(cwd, ".agents", "harness", "harness.config.yaml"),
    path.join(cwd, "harness.config.yaml"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function readLines(configPath: string): Promise<string[]> {
  const text = await fs.readFile(configPath, "utf8");
  return text.split(/\r?\n/);
}

async function writeLines(configPath: string, lines: string[]): Promise<void> {
  await fs.writeFile(configPath, lines.join("\n"), "utf8");
}

/** Range of a top-level `key:` section (indentation-aware, no YAML parser needed). */
function topLevelSection(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && !/^\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Range of a nested `  name:` block inside a top-level section. */
function nestedBlock(lines: string[], sectionKey: string, name: string): { start: number; end: number } | null {
  const section = topLevelSection(lines, sectionKey);
  if (!section) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^ {2}${escaped}:\\s*$`);
  let start = -1;
  for (let i = section.start + 1; i < section.end; i++) {
    if (header.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = section.end;
  for (let i = start + 1; i < section.end; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function listAgents(lines: string[]): string[] {
  const section = topLevelSection(lines, "agents");
  if (!section) return [];
  const agents: string[] = [];
  for (let i = section.start + 1; i < section.end; i++) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) agents.push(match[1]);
  }
  return agents;
}

function agentBlock(lines: string[], agent: string): { start: number; end: number } | null {
  return nestedBlock(lines, "agents", agent);
}

/** Tools granted to an agent, in config order ([] when the agent grants none). */
export function getAgentTools(lines: string[], agent: string): string[] {
  const block = agentBlock(lines, agent);
  if (!block) return [];
  let inTools = false;
  const tools: string[] = [];
  for (let i = block.start; i < block.end; i++) {
    if (/^ {4}tools:\s*$/.test(lines[i])) {
      inTools = true;
      continue;
    }
    if (!inTools) continue;
    if (/^ {4}\S/.test(lines[i])) break;
    const item = lines[i].match(/^ {6}-\s+(\S+)\s*$/);
    if (item) tools.push(item[1]);
  }
  return tools;
}

function getBlockField(lines: string[], block: { start: number; end: number }, field: string): string | null {
  const pattern = new RegExp(`^ {4}${field}:\\s*(.*)$`);
  for (let i = block.start; i < block.end; i++) {
    const match = lines[i].match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

export function getWorkflowMode(lines: string[]): string | null {
  const section = topLevelSection(lines, "defaults");
  if (!section) return null;
  const pattern = /^ {2}workflow_mode:\s*(\S+)\s*$/;
  for (let i = section.start; i < section.end; i++) {
    const match = lines[i].match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function setWorkflowMode(lines: string[], mode: string): string[] {
  const section = topLevelSection(lines, "defaults");
  if (!section) return lines;
  const pattern = /^ {2}workflow_mode:\s*\S+\s*$/;
  for (let i = section.start; i < section.end; i++) {
    if (pattern.test(lines[i])) {
      const next = [...lines];
      next[i] = `  workflow_mode: ${mode}`;
      return next;
    }
  }
  return lines;
}

/** Ordered agent steps of a workflow mode, or null when the mode has no entry. */
export function getWorkflowSteps(lines: string[], mode: string): string[] | null {
  const block = nestedBlock(lines, "workflows", mode);
  if (!block) return null;
  let stepsIndex = -1;
  for (let i = block.start; i < block.end; i++) {
    if (/^ {4}steps:\s*$/.test(lines[i])) {
      stepsIndex = i;
      break;
    }
  }
  if (stepsIndex === -1) return [];
  const steps: string[] = [];
  for (let i = stepsIndex + 1; i < block.end; i++) {
    const match = lines[i].match(/^ {6}-\s+(\S+)\s*$/);
    if (match) {
      steps.push(match[1]);
      continue;
    }
    if (lines[i].trim() === "") continue;
    if (/^ {4}\S/.test(lines[i]) || /^ {2}\S/.test(lines[i])) break;
  }
  return steps;
}

function setAgentFields(lines: string[], agent: string, fields: Record<string, string>): string[] {
  const block = agentBlock(lines, agent);
  if (!block) return lines;
  const next = [...lines];
  const missing: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const pattern = new RegExp(`^ {4}${field}:\\s*.*$`);
    let found = false;
    for (let i = block.start; i < block.end; i++) {
      if (pattern.test(next[i])) {
        next[i] = `    ${field}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) missing.push(`    ${field}: ${value}`);
  }
  if (missing.length > 0) {
    const modelIndex = next.findIndex((line, index) => index > block.start && index < block.end && /^ {4}model:\s*/.test(line));
    next.splice(modelIndex >= 0 ? modelIndex + 1 : block.start + 1, 0, ...missing);
  }
  return next;
}

export function setAgentModel(lines: string[], agent: string, model: string): string[] {
  return setAgentFields(lines, agent, { model });
}

export function setAgentReasoning(lines: string[], agent: string, reasoning: string): string[] {
  return setAgentFields(lines, agent, { reasoning });
}

/** Read a boolean flag from the `defaults:` section, with a fallback. */
export function getDefaultFlag(lines: string[], key: string, fallback: boolean): boolean {
  const section = topLevelSection(lines, "defaults");
  if (!section) return fallback;
  const pattern = new RegExp(`^ {2}${key}:\\s*(\\S+)\\s*$`);
  for (let i = section.start; i < section.end; i++) {
    const match = lines[i].match(pattern);
    if (match) return match[1] === "true";
  }
  return fallback;
}

export function isAutoHarness(lines: string[]): boolean {
  return getDefaultFlag(lines, "auto_harness", false);
}

/** When true, an orchestrator `ANSWER_ONLY` decision stops the pipeline early. */
export function isQuestionShortCircuit(lines: string[]): boolean {
  return getDefaultFlag(lines, "question_short_circuit", true);
}

/**
 * When true, a missing or ambiguous decision marker stops the pipeline instead
 * of being read as "not ANSWER_ONLY" (which would run the file-mutating steps
 * of a task that only needed an answer).
 */
export function isStrictDecisionMarker(lines: string[]): boolean {
  return getDefaultFlag(lines, "strict_decision_marker", false);
}

export type PreflightPolicy = "advisory" | "blocking";

/**
 * `blocking` stops the first file-mutating step when the repository is not in
 * a known state; `advisory` only reports. Any other value reads as advisory.
 */
export function preflightPolicy(lines: string[]): PreflightPolicy {
  return getDefaultString(lines, "preflight_policy", "advisory").toLowerCase() === "blocking" ? "blocking" : "advisory";
}

/** Read a string flag from the `defaults:` section, with a fallback. */
export function getDefaultString(lines: string[], key: string, fallback: string): string {
  const section = topLevelSection(lines, "defaults");
  if (!section) return fallback;
  const pattern = new RegExp(`^ {2}${key}:\\s*(\\S+)\\s*$`);
  for (let i = section.start; i < section.end; i++) {
    const match = lines[i].match(pattern);
    if (match) return match[1];
  }
  return fallback;
}

/** Master gate for the harness-dispatch tool. */
export function isAllowDispatch(lines: string[]): boolean {
  return getDefaultFlag(lines, "allow_dispatch", true);
}

// ---------------------------------------------------------------------------
// Contract resolution for dispatched subagents
// ---------------------------------------------------------------------------
// The contract injected into a dispatch subagent is the only channel it gets,
// so failing to find it must not be the price of a wrong guess. An adopting
// project reaches it in one of two ways: the installer copies the contract to
// its root as `pi-minimal-harness.md` and points at it from `AGENTS.md`, or the
// project keeps a contract of its own and points at that. The pipeline steps
// do not depend on any of this: they get the project's `AGENTS.md` through
// Pi's normal mechanism.
//
// Resolution is therefore a chain verified by existence, never "the first
// configured one wins": a `defaults.subagent_context_file` that points at a
// file no longer present — the normal state after a project replaced the key
// with another file, or after deleting one it no longer uses — falls through
// instead of breaking dispatch. The installer-written file comes before
// `AGENTS.md` because `AGENTS.md` now carries a pointer, not the contract; a
// legacy `AGENTS-addition.md` is still accepted as a last resort.
const HARNESS_BLOCK_START = "<!-- BEGIN pi-minimal-harness -->";
/** The contract the installer copies to the root of an adopting project. */
const CONTRACT_FILE = "pi-minimal-harness.md";
/** The name the same contract had before, still honoured for existing projects. */
const LEGACY_CONTRACT_FILE = "AGENTS-addition.md";

export interface ContractResolution {
  /** Absolute path of the file to inject, or null when none exists. */
  path: string | null;
  /** Absolute paths that were considered, in order. */
  candidates: string[];
  /** Which step matched: "defaults.subagent_context_file", "pi-minimal-harness.md", "AGENTS.md" or "AGENTS-addition.md". */
  source: string | null;
  /** A configured value that exists nowhere, worth warning about. */
  staleConfig: string | null;
}

function contractCandidates(cwd: string, configPath: string | undefined, lines: string[]): Array<{ source: string; file: string }> {
  const base = cwd ?? (configPath ? path.dirname(configPath) : process.cwd());
  const candidates: Array<{ source: string; file: string }> = [];
  const configured = getDefaultString(lines, "subagent_context_file", "");
  if (configured) candidates.push({ source: "defaults.subagent_context_file", file: configured });
  candidates.push({ source: CONTRACT_FILE, file: CONTRACT_FILE });
  candidates.push({ source: "AGENTS.md", file: "AGENTS.md" });
  candidates.push({ source: LEGACY_CONTRACT_FILE, file: LEGACY_CONTRACT_FILE });
  return candidates.map((candidate) => ({
    source: candidate.source,
    file: path.isAbsolute(candidate.file) ? candidate.file : path.join(base, candidate.file),
  }));
}

/**
 * Find the contract to inject into dispatched subagents: the configured file
 * when it exists, then the `pi-minimal-harness.md` the installer copies, then
 * an `AGENTS.md` that carries the harness block, then a legacy
 * `AGENTS-addition.md`. A configured file that exists nowhere is reported as
 * stale instead of failing the resolution.
 */
export function resolveContractPath(lines: string[], configPath?: string, cwd?: string): ContractResolution {
  const considered = contractCandidates(cwd, configPath, lines);
  const configured = considered.find((candidate) => candidate.source === "defaults.subagent_context_file");
  const resolution: ContractResolution = {
    path: null,
    candidates: considered.map((c) => c.file),
    source: null,
    staleConfig: configured && !existsSync(configured.file) ? configured.file : null,
  };
  for (const candidate of considered) {
    if (!existsSync(candidate.file)) continue;
    if (candidate.source === "AGENTS.md") {
      // A bare AGENTS.md is only a contract when the installer wrote the block.
      let text = "";
      try {
        text = readFileSync(candidate.file, "utf8");
      } catch {
        continue;
      }
      if (!text.includes(HARNESS_BLOCK_START)) continue;
    }
    resolution.path = candidate.file;
    resolution.source = candidate.source;
    return resolution;
  }
  return resolution;
}

/**
 * Whether an agent's step may modify files, from `agents.<name>.mutates_files`.
 * An agent without the field is assumed to mutate files: a blocking gate that
 * failed open on missing configuration would defeat its own purpose.
 */
export function agentMutatesFiles(lines: string[], agent: string): boolean {
  const block = agentBlock(lines, agent);
  const value = block ? getBlockField(lines, block, "mutates_files") : null;
  if (!value) return true;
  return value.toLowerCase() === "true";
}

export function setAutoHarness(lines: string[], on: boolean): string[] {
  const section = topLevelSection(lines, "defaults");
  if (!section) return lines;
  const next = [...lines];
  const pattern = /^ {2}auto_harness:\s*\S+\s*$/;
  for (let i = section.start; i < section.end; i++) {
    if (pattern.test(next[i])) {
      next[i] = `  auto_harness: ${on ? "true" : "false"}`;
      return next;
    }
  }
  let anchor = -1;
  for (let i = section.start; i < section.end; i++) {
    if (/^ {2}workflow_mode:/.test(next[i])) {
      anchor = i;
      break;
    }
  }
  const insertAt = anchor >= 0 ? anchor + 1 : section.start + 1;
  next.splice(insertAt, 0, `  auto_harness: ${on ? "true" : "false"}`);
  return next;
}

function getCatalogSource(lines: string[]): string | null {
  const section = topLevelSection(lines, "commands");
  if (!section) return null;
  const pattern = /^\s+model_catalog_source:\s*(\S+)\s*$/;
  for (let i = section.start; i < section.end; i++) {
    const match = lines[i].match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt templates and model catalog
// ---------------------------------------------------------------------------

/** Resolve an agent's prompt_template relative to the config, with a fallback. */
export async function resolvePromptTemplatePath(
  cwd: string,
  configPath: string,
  relative: string,
): Promise<string | null> {
  const candidates = [
    path.join(path.dirname(configPath), relative),
    path.join(cwd, ".agents", "harness", relative),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Render a prompt template. Unknown placeholders stay verbatim; if the
 * template forgot {{task}}, the task is appended so it always reaches the model.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
  if (!template.includes("{{task}}")) return `${out}\n\n## Task\n${vars.task}`;
  return out;
}

type ModelCatalog = { getAvailable(): PiModel[]; getAll(): PiModel[] };

/** Resolve `provider/id` (exact) or a bare legacy `id` against Pi's catalog. */
export function findModelRef(ref: string, catalog: ModelCatalog): PiModel | undefined {
  const all = [...catalog.getAvailable(), ...catalog.getAll()];
  return all.find((m) => `${m.provider}/${m.id}` === ref) ?? all.find((m) => m.id === ref);
}

/**
 * Reasoning efforts assignable for a model. Pi exposes `off` for non-reasoning
 * models; reasoning models use the provider-neutral levels accepted by the
 * extension API, with xhigh/max enabled only when the model maps them.
 */
export function supportedReasoningLevels(model: PiModel): ReasoningLevelArg[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

type HarnessDecision = "answer_only" | "pipeline" | null;

const DECISION_MARKER = /HARNESS-DECISION:\s*(ANSWER_ONLY|PIPELINE)/gi;

export interface DecisionLineSplit {
  /** null when the reply has no marker on its last line, or names both variants. */
  decision: HarnessDecision;
  /** The reply without the decision marker. */
  rest: string;
  /** True when a marker was present on the last line, valid or ambiguous. */
  hadMarker: boolean;
}

/**
 * Split the orchestrator's mandatory decision marker off a reply.
 *
 * The marker only counts on the last non-empty line: quoted earlier — in prose,
 * a code fence, or a list of examples — it is an example and must neither decide
 * nor be removed from the visible text. A final line carrying both variants is
 * ambiguous, so it yields no decision and the caller fails closed.
 */
export function splitDecisionLine(text: string): DecisionLineSplit {
  const lines = text.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { decision: null, rest: text, hadMarker: false };

  const variants = new Set([...lines[idx].matchAll(DECISION_MARKER)].map((m) => m[1].toUpperCase()));
  if (variants.size === 0) return { decision: null, rest: text, hadMarker: false };

  const decision: HarnessDecision =
    variants.size === 1 ? ([...variants][0] === "ANSWER_ONLY" ? "answer_only" : "pipeline") : null;

  // The marker never reaches the user, but a sentence sharing the final line
  // is prose and survives without it.
  const cleaned = lines[idx].replace(DECISION_MARKER, "").replace(/\s+$/, "");
  const out = [...lines];
  if (cleaned.trim()) out[idx] = cleaned;
  else out.splice(idx, 1);
  return { decision, rest: out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), hadMarker: true };
}

/** Parse the orchestrator's mandatory decision marker from an assistant reply. */
export function parseHarnessDecision(text: string): HarnessDecision {
  return splitDecisionLine(text).decision;
}

interface LastTurn {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Text + stop reason of the last assistant message on the current branch. */
function lastAssistantTurn(ctx: ExtensionContext): LastTurn | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as {
      type?: string;
      message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> };
    };
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const text = (entry.message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      return { text, stopReason: entry.message.stopReason, errorMessage: entry.message.errorMessage };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pipeline driver
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One repair turn, sent when a step owes a report and did not deliver a
 * complete one. The agent name is included so a stalled step is
 * identifiable in the transcript, and the gaps so the agent knows exactly
 * which field to add instead of rewriting a report that was nearly right.
 */
function reportRepairPrompt(agentName: string, gaps: string[]): string {
  const detail = gaps.length > 0 ? ` Its report is missing: ${gaps.join(", ")}.` : "";
  return (
    `The previous response from "${agentName}" ended without a complete completion report: no \`harness_report\` call and no \`HARNESS-DONE\` marker, and no complete report in the required format (### Changes / ### Evidence / ### Notes for delivery / ### Lessons).` +
    `${detail} Write the full report now and call harness_report(changed_files, checks, notes, lessons) — or end with \`HARNESS-DONE\` if the tool is unavailable. ` +
    "Pass `[]` for a field that is genuinely empty; omitting a field is what makes the report incomplete."
  );
}

/**
 * What a finished step is still missing before its report counts.
 *
 * The textual `HARNESS-DONE` fallback cannot be inspected, so it stays a
 * complete report. A `harness_report` call counts only when it carries
 * every field the report contract names: an agent with nothing to record
 * says so with `[]`, while an omitted or blank field is a gap and earns the
 * same single repair turn as a missing report.
 */
export function reportGaps(report: HarnessReport | null, text: string): string[] {
  if (/\bHARNESS-DONE\b/.test(text)) return [];
  if (!report) return ["harness_report call"];
  const gaps: string[] = [];
  if (!Array.isArray(report.changedFiles)) gaps.push("changed_files");
  if (!Array.isArray(report.checks)) gaps.push("checks");
  if (!Array.isArray(report.lessons)) gaps.push("lessons");
  return gaps;
}

/**
 * Ask whether a file-mutating step may run anyway. Without a TUI there is
 * nobody to ask, so the step is blocked: continuing silently is exactly the
 * failure mode this gate exists to prevent.
 */
async function confirmPreflightBlock(
  ctx: ExtensionContext,
  blockers: string[],
  agentName: string,
): Promise<boolean> {
  const detail = blockers.join("; ");
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Pipeline blocked before "${agentName}": ${detail}. Resolve it and run the task again (or set defaults.preflight_policy: advisory).`,
      "error",
    );
    return false;
  }
  return await ctx.ui.confirm(
    `Run "${agentName}" anyway?`,
    `${detail}.\n\nThe next step may modify files on top of this state. Default is to stop: resolve it and run the task again.`,
  );
}

/**
 * Turn wait for the auto-harness `input` hook, where ctx.waitForIdle() is not
 * available: wait for a new assistant message to appear and the session to go
 * idle. Falls back after 8 s of idleness with no output (turn never started).
 *
 * A turn that calls a tool produces several assistant messages (the tool call,
 * then the text), and the session is briefly idle between them. Waiting on
 * "some output + idle" would return on the tool-call message and read the step
 * as finished, so a message that still carries a pending tool call never
 * satisfies the wait.
 */
async function pollIdle(ctx: ExtensionContext): Promise<void> {
  const countAssistants = () =>
    ctx.sessionManager
      .getBranch()
      .filter((e) => (e as { type?: string; message?: { role?: string } }).type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant").length;
  const base = countAssistants();
  const started = Date.now();
  let sawOutput = false;
  for (;;) {
    if (countAssistants() > base) sawOutput = true;
    if (sawOutput && !lastAssistantHasToolCall(ctx) && ctx.isIdle()) return;
    if (!sawOutput && ctx.isIdle() && Date.now() - started > 8000) return;
    await sleep(150);
  }
}

/** True when the newest assistant message still carries an unexecuted tool call. */
export function lastAssistantHasToolCall(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as {
      type?: string;
      message?: { role?: string; content?: Array<{ type?: string }> };
    };
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    return (entry.message.content ?? []).some((part) => part?.type === "toolCall");
  }
  return false;
}

export interface RepositoryState {
  available: boolean;
  dirty: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  pullRequest: { state: string; number: number; url: string } | null;
}

type RepositoryCommandResult = { ok: boolean; stdout: string };
type RepositoryCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<RepositoryCommandResult>;

const execFileAsync = promisify(execFile);

async function runRepositoryCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<RepositoryCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: REPOSITORY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
    return { ok: false, stdout };
  }
}

/**
 * Read local repository state without changing the worktree. Git is advisory:
 * repositories without Git simply skip the preflight. GitHub CLI is optional;
 * when available, an open PR is reported as a warning for the operator.
 */
export async function checkRepositoryState(
  cwd: string,
  runner: RepositoryCommandRunner = runRepositoryCommand,
): Promise<RepositoryState> {
  const inside = await runner("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!inside.ok) {
    return {
      available: false,
      dirty: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      pullRequest: null,
    };
  }

  const status = await runner("git", ["status", "--porcelain"], cwd);
  const branchResult = await runner("git", ["branch", "--show-current"], cwd);
  const branch = branchResult.ok ? branchResult.stdout.trim() || null : null;
  const upstreamResult = await runner("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() || null : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runner("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd);
    const match = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (counts.ok && match) {
      ahead = Number(match[1]);
      behind = Number(match[2]);
    }
  }

  let pullRequest: RepositoryState["pullRequest"] = null;
  if (branch) {
    const pr = await runner("gh", ["pr", "view", "--json", "state,number,url"], cwd);
    if (pr.ok) {
      try {
        const parsed = JSON.parse(pr.stdout) as { state?: string; number?: number; url?: string };
        if (parsed.state && parsed.number && parsed.url) {
          pullRequest = { state: parsed.state, number: parsed.number, url: parsed.url };
        }
      } catch {
        // GitHub CLI output is advisory; malformed output means no PR warning.
      }
    }
  }

  return {
    available: true,
    dirty: status.ok && status.stdout.trim().length > 0,
    branch,
    upstream,
    ahead,
    behind,
    pullRequest,
  };
}

/** Human-readable preflight warning; null means the repository looks ready. */
export function formatRepositoryPreflight(state: RepositoryState): string | null {
  if (!state.available) return null;
  const warnings: string[] = [];
  if (state.dirty) warnings.push("the working tree has uncommitted changes");
  if (state.behind > 0) warnings.push(`the branch is behind ${state.upstream ?? "its upstream"} by ${state.behind} commit(s)`);
  if (state.ahead > 0) warnings.push(`the branch has ${state.ahead} unpushed commit(s)`);
  if (state.pullRequest?.state === "OPEN") {
    warnings.push(`pull request #${state.pullRequest.number} is still open (${state.pullRequest.url})`);
  }
  if (warnings.length === 0) return null;
  return `Repository preflight: ${warnings.join("; ")}. Consider pulling, pushing, or resolving the pull request before starting another task.`;
}

/**
 * Conditions that must stop a file-mutating step under
 * `defaults.preflight_policy: blocking`. Only states where the harness would
 * build on top of unknown work qualify: an out-of-date branch is reported as a
 * warning instead, because pulling is the operator's call, not the harness's.
 */
export function formatBlockingPreflight(state: RepositoryState): string[] {
  if (!state.available) return [];
  const blockers: string[] = [];
  if (state.dirty) blockers.push("the working tree has uncommitted changes");
  if (state.pullRequest?.state === "OPEN") {
    blockers.push(`pull request #${state.pullRequest.number} is still open (${state.pullRequest.url})`);
  }
  return blockers;
}

/**
 * Execute the configured workflow pipeline for `task`, step by step.
 * The runtime sequences the steps: each agent's prompt is sent as the next
 * user turn and the driver waits for it to finish before continuing.
 */
export async function runPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: string,
  waitForTurn: () => Promise<void>,
  modeOverride?: string,
  agentOverride?: string,
): Promise<void> {
  const configPath = await resolveConfigPath(ctx.cwd);
  if (!configPath) {
    ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
    return;
  }
  const lines = await readLines(configPath);
  const mode = modeOverride ?? getWorkflowMode(lines);
  if (!mode) {
    ctx.ui.notify("defaults.workflow_mode is not set in the harness configuration.", "error");
    return;
  }
  const steps = agentOverride ? [agentOverride] : getWorkflowSteps(lines, mode);
  if (!steps || steps.length === 0) {
    ctx.ui.notify(`workflows has no steps for mode "${mode}" — cannot run the pipeline.`, "error");
    return;
  }
  const repositoryState = await checkRepositoryState(ctx.cwd);
  const repositoryWarning = formatRepositoryPreflight(repositoryState);
  if (repositoryWarning) ctx.ui.notify(repositoryWarning, "warning");

  const originalModel = ctx.model;
  const originalThinking = pi.getThinkingLevel();
  const autoHarness = isAutoHarness(lines);
  const questionShortCircuit = isQuestionShortCircuit(lines);
  const strictDecisionMarker = isStrictDecisionMarker(lines);
  // Resolved once: the gate is asked at most one time per pipeline, so a step
  // that dirties the tree itself does not block the next one.
  let pendingPreflightBlock = preflightPolicy(lines) === "blocking" ? formatBlockingPreflight(repositoryState) : [];
  lastDecision = null;
  lastDecisionReason = "";
  lastReport = null;
  pipelineActive = true;
  lastProgress = null;
  let touchedModel = false;
  let touchedThinking = false;
  let shortCircuited = false;
  let reportMissing = false;
  const completed: string[] = [];

  ctx.ui.notify(`Pipeline "${mode}": ${steps.length} steps — ${steps.join(" -> ")}`, "info");

  try {
    for (let i = 0; i < steps.length; i++) {
      const agentName = steps[i];
      const block = agentBlock(lines, agentName);
      if (!block) {
        ctx.ui.notify(`Pipeline stopped: agent "${agentName}" is not defined in the configuration.`, "error");
        break;
      }

      // Model for this step (exact catalog reference; never invented).
      const modelRef = getBlockField(lines, block, "model");
      let model: PiModel | undefined;
      let modelActive = false;
      if (modelRef) {
        model = findModelRef(modelRef, ctx.modelRegistry);
        if (!model) {
          ctx.ui.notify(`[${i + 1}/${steps.length}] ${agentName}: model "${modelRef}" not in catalog; keeping current model.`, "warning");
        } else {
          const ok = await pi.setModel(model);
          modelActive = ok;
          touchedModel = true;
          if (!ok) {
            ctx.ui.notify(`[${i + 1}/${steps.length}] ${agentName}: no authentication for "${modelRef}"; keeping current model.`, "warning");
          }
        }
      }

      // Reasoning effort must be supported by the model that is actually active.
      const reasoning = getBlockField(lines, block, "reasoning");
      if (reasoning && model) {
        const supported = supportedReasoningLevels(model);
        if (!supported.includes(reasoning as ReasoningLevelArg)) {
          ctx.ui.notify(
            `[${i + 1}/${steps.length}] ${agentName}: effort "${reasoning}" is not supported by "${modelRef}"; available: ${supported.join(", ")}. Keeping current effort.`,
            "warning",
          );
        } else if (reasoning === "off" && modelActive) {
          // Model switches can clamp the active level; restore it in finally.
          touchedThinking = true;
        } else if (reasoning !== "off" && modelActive) {
          pi.setThinkingLevel(reasoning as ThinkingLevelArg);
          touchedThinking = true;
        }
      } else if (reasoning && !modelRef && THINKING_LEVELS.has(reasoning)) {
        // Backward-compatible agents without a model use Pi's current model.
        pi.setThinkingLevel(reasoning as ThinkingLevelArg);
        touchedThinking = true;
      } else if (reasoning && modelRef) {
        ctx.ui.notify(`[${i + 1}/${steps.length}] ${agentName}: cannot validate effort "${reasoning}" because the model is not in the catalog.`, "warning");
      }

      // Prompt template for this step (missing configuration stops the run).
      const templateRel = getBlockField(lines, block, "prompt_template");
      if (!templateRel) {
        ctx.ui.notify(`Pipeline stopped: agent "${agentName}" has no prompt_template.`, "error");
        break;
      }
      const templatePath = await resolvePromptTemplatePath(ctx.cwd, configPath, templateRel);
      if (!templatePath) {
        ctx.ui.notify(`Pipeline stopped: prompt template not found for "${agentName}": ${templateRel}`, "error");
        break;
      }

      // Step 1 has no total yet: the orchestrator has not decided how many
      // steps this task really needs. Later steps show the real total.
      lastProgress = i === 0 ? agentName : `${i + 1}/${steps.length} ${agentName}`;
      ctx.ui.setStatus(STATUS_KEY, formatStatus(mode, autoHarness, lastProgress, lastDecision));
      ctx.ui.notify(`[${i + 1}/${steps.length}] ${agentName}${modelRef ? ` (${modelRef})` : ""}`, "info");

      // The template body never enters the transcript: this message only
      // points at the file (the agent reads it) and supplies the values the
      // placeholders stand for.
      if (pendingPreflightBlock.length > 0 && agentMutatesFiles(lines, agentName)) {
        const blockers = pendingPreflightBlock;
        pendingPreflightBlock = [];
        if (!(await confirmPreflightBlock(ctx, blockers, agentName))) break;
      }

      pi.sendUserMessage(
        [
          `[harness] step ${i + 1}/${steps.length} · ${agentName} · mode ${mode}.`,
          `Read \`${templateRel}\` and follow it exactly. Placeholder values — {{task}}: ${task} | {{mode}}: ${mode} | {{agent}}: ${agentName} | {{step}}: ${i + 1} | {{steps}}: ${steps.length} | {{previous}}: from this conversation.`,
          `Task: ${task}`,
        ].join("\n"),
      );
      await waitForTurn();

      const turn = lastAssistantTurn(ctx);
      if (turn?.stopReason === "aborted") {
        ctx.ui.notify(`Pipeline aborted by user at step ${i + 1} (${agentName}).`, "warning");
        break;
      }
      if (turn?.stopReason === "error") {
        ctx.ui.notify(`Pipeline failed at step ${i + 1} (${agentName}): ${turn.errorMessage ?? "model error"}`, "error");
        break;
      }
      completed.push(agentName);

      // Questions and no-file-change tasks: the orchestrator answered in this
      // first step, so the remaining pipeline is unnecessary. The decision is
      // read before the report marker below, so a legitimate ANSWER_ONLY answer
      // is never "repaired" for a report it does not owe.
      // `lastDecision` is the tool's value when the orchestrator called the
      // tool (its execute ran during the turn); the textual marker is only the
      // fallback for prompts that have not migrated yet.
      const decision = lastDecision ?? parseHarnessDecision(turn?.text ?? "");
      if (i === 0 && lastDecisionReason) {
        ctx.ui.notify(`Orchestrator decision: ${decision ?? "(none)"} — ${lastDecisionReason}`, "info");
        lastDecisionReason = "";
      }
      if (i === 0 && steps.length > 1 && questionShortCircuit) {
        if (decision === "answer_only") {
          shortCircuited = true;
          break;
        }
        // Fail closed: without a decision the pipeline would guess "PIPELINE" and
        // let the mutating steps run on a task that may need no file at all.
        if (decision === null && strictDecisionMarker) {
          ctx.ui.notify(
            `Pipeline stopped: the orchestrator declared no decision. Call harness_decision(ANSWER_ONLY | PIPELINE), ` +
              "or end the reply with HARNESS-DECISION: ANSWER_ONLY / HARNESS-DECISION: PIPELINE as its last line. " +
              "Re-run the task, or set defaults.strict_decision_marker: false to let the pipeline continue without it.",
            "error",
          );
          break;
        }
      }

      // A report the orchestrator happened to send is not the next step's
      // report: drop it before the report guarantee below, which only applies
      // to i > 0, so it can never stand in for the step that owes one.
      if (i === 0) lastReport = null;

      // Per-step report guarantee: every step that owes a report delivers a
      // complete one (every field present, `[]` for a genuinely empty one).
      // Step 1 is exempt: the orchestrator's job is the decision plus the
      // handoff, not the report contract, and asking it for one would cost an
      // adopter an extra turn on a path that has always worked without it.
      // A complete harness_report call satisfies it; the textual marker is the
      // fallback. An incomplete one is repaired exactly once, like a missing
      // report.
      if (!shortCircuited && decision !== "answer_only" && i > 0) {
        let gaps = reportGaps(lastReport, turn?.text ?? "");
        if (gaps.length > 0) {
          pi.sendUserMessage(reportRepairPrompt(agentName, gaps));
          await waitForTurn();
          const repaired = lastAssistantTurn(ctx);
          gaps = reportGaps(lastReport, repaired?.text ?? "");
          if (gaps.length > 0) {
            reportMissing = true;
            ctx.ui.notify(
              `Pipeline stopped: step ${i + 1} (${agentName}) did not report (no complete harness_report call and no HARNESS-DONE) after one repair turn: ${gaps.join(", ")}.`,
              "error",
            );
            break;
          }
        }
        // The report belongs to this step only: forget it before the next one.
        lastReport = null;
      }
    }
  } finally {
    if (touchedModel && originalModel) {
      try {
        await pi.setModel(originalModel);
      } catch {
        // restoring the original model is best-effort
      }
    }
    if (touchedThinking) pi.setThinkingLevel(originalThinking);
    // A question ends at `1/1 <first>`; a finished pipeline clears the progress.
    lastProgress = shortCircuited && steps.length > 0 ? `1/1 ${steps[0]}` : null;
    pipelineActive = false;
    lastReport = null;
    await refreshModeStatus(ctx);
  }

  if (completed.length === steps.length) {
    if (reportMissing) {
      ctx.ui.notify(
        `Pipeline "${mode}" finished, but a step's report is missing — the last agent may have stopped early.`,
        "warning",
      );
    } else {
      ctx.ui.notify(`Pipeline "${mode}" finished: ${completed.join(" -> ")}`, "info");
    }
  } else if (shortCircuited) {
    ctx.ui.notify(`Pipeline "${mode}": orchestrator answered directly — remaining steps skipped.`, "info");
  } else {
    ctx.ui.notify(`Pipeline "${mode}" stopped after ${completed.length}/${steps.length} steps.`, "warning");
  }
}

// ---------------------------------------------------------------------------
// Background dispatch (curated subagents in isolated processes)
// ---------------------------------------------------------------------------

const DISPATCH_MAX_TASKS = 8;
const DISPATCH_CONCURRENCY = 4;
const DISPATCH_OUTPUT_CAP = 50 * 1024;

export interface DispatchTaskResult {
  agent: string;
  ok: boolean;
  text: string;
  exitCode?: number;
  stopReason?: string;
  stderr?: string;
  truncated?: boolean;
}

type SpawnFn = typeof spawn;

/** Cross-platform pi invocation (same logic as Pi's subagent example). */
function getPiInvocation(): { command: string; prefixArgs: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, prefixArgs: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, prefixArgs: [] };
  }
  return { command: "pi", prefixArgs: [] };
}

/** Argument vector for one isolated subagent process; the brief is the prompt. */
export function buildDispatchArgs(opts: {
  systemPromptPath?: string;
  model?: string;
  thinking?: string;
  brief: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (opts.systemPromptPath) args.push("--append-system-prompt", opts.systemPromptPath);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  args.push(opts.brief);
  return args;
}

function capDispatchOutput(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= DISPATCH_OUTPUT_CAP) return { text, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, DISPATCH_OUTPUT_CAP).toString("utf8");
  return {
    text: `${cut}\n\n[Output truncated: ${bytes - DISPATCH_OUTPUT_CAP} bytes omitted.]`,
    truncated: true,
  };
}

/**
 * Outcome line for a dispatch batch, plus the per-agent summaries.
 *
 * Pure and exported so the success/failure decision is testable without
 * spawning a real subagent process: a partial batch must resolve with this
 * text, a fully failed batch must throw it.
 */
export function formatDispatchOutcome(total: number, failedCount: number, summaries: string[]): string {
  return `${total - failedCount}/${total} dispatched agents ok\n\n${summaries.join("\n\n---\n\n")}`;
}

/** Run one isolated subagent process and collect its final text. */
export async function runDispatchTask(opts: {
  cwd: string;
  agent: string;
  args: string[];
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
}): Promise<DispatchTaskResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const invocation = getPiInvocation();
  const argv = [...invocation.prefixArgs, ...opts.args];

  return await new Promise<DispatchTaskResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(invocation.command, argv, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (error) {
      resolve({ agent: opts.agent, ok: false, text: "", exitCode: 1, stderr: String(error) });
      return;
    }

    let buffer = "";
    let stderr = "";
    let lastText = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let settled = false;

    const finish = (result: DispatchTaskResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: {
        type?: string;
        message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> };
      };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      stopReason = event.message.stopReason ?? stopReason;
      errorMessage = event.message.errorMessage ?? errorMessage;
      const text = (event.message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      if (text.trim()) lastText = text;
    };

    child.stdout?.on("data", (data: unknown) => {
      buffer += String(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stderr?.on("data", (data: unknown) => {
      stderr += String(data);
    });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (stopReason === "aborted") {
        finish({ agent: opts.agent, ok: false, text: lastText, stopReason: "aborted", stderr: stderr.slice(0, 4000) || undefined });
        return;
      }
      const exitCode = typeof code === "number" ? code : 1;
      const ok = exitCode === 0 && stopReason !== "error" && !errorMessage;
      const capped = capDispatchOutput(lastText);
      const detail = (errorMessage ? `${errorMessage}\n` : "") + stderr;
      finish({
        agent: opts.agent,
        ok,
        text: capped.text,
        exitCode,
        stopReason,
        stderr: detail.trim() ? detail.trim().slice(0, 4000) : undefined,
        truncated: capped.truncated,
      });
    });
    child.on("error", (error) => {
      finish({ agent: opts.agent, ok: false, text: "", exitCode: 1, stderr: String(error) });
    });

    if (opts.signal) {
      const kill = () => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, 5000);
        } catch {
          // already gone
        }
      };
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Two-channel system prompt: rendered agent template + the stable contract. */
async function composeDispatchSystemPrompt(opts: {
  templatePath: string;
  contractPath: string;
  agent: string;
  brief: string;
}): Promise<string> {
  const template = await fs.readFile(opts.templatePath, "utf8");
  const objective =
    opts.brief
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? opts.brief;
  const rendered = renderPrompt(template, {
    task: objective,
    mode: "dispatch",
    agent: opts.agent,
    step: "-",
    steps: "-",
    previous: "",
  });
  const contract = await fs.readFile(opts.contractPath, "utf8");
  return `${rendered.trimEnd()}\n\n---\n\n${contract.trimEnd()}\n`;
}

/**
 * Parameter schema for the dispatch tool. TypeBox resolves inside Pi (its
 * loader aliases `typebox`); outside Pi — e.g. the node smoke test — we fall
 * back to the equivalent plain JSON Schema, so the extension loads anywhere
 * without npm dependencies.
 */
async function buildDispatchParams(): Promise<Record<string, unknown>> {
  const agentDescription = "Configured agent: orchestrator, explorer, critic, implementer or delivery";
  const briefDescription =
    "Curated brief: objective, relevant files with line refs, constraints, acceptance criteria, expected evidence, non-goals, unknowns";
  const tasksDescription = "Independent tasks to run in isolated background agents";
  const parallelDescription = `Run tasks concurrently (default true; max ${DISPATCH_CONCURRENCY} at a time)`;

  let T: typeof import("typebox").Type | undefined;
  try {
    T = (await import("typebox")).Type;
  } catch {
    T = undefined;
  }
  if (T) {
    return T.Object({
      tasks: T.Array(
        T.Object({
          agent: T.String({ description: agentDescription }),
          brief: T.String({ description: briefDescription }),
        }),
        { minItems: 1, maxItems: DISPATCH_MAX_TASKS, description: tasksDescription },
      ),
      parallel: T.Optional(T.Boolean({ description: parallelDescription })),
    }) as unknown as Record<string, unknown>;
  }
  return {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: DISPATCH_MAX_TASKS,
        description: tasksDescription,
        items: {
          type: "object",
          properties: {
            agent: { type: "string", description: agentDescription },
            brief: { type: "string", description: briefDescription },
          },
          required: ["agent", "brief"],
          additionalProperties: false,
        },
      },
      parallel: { type: "boolean", description: parallelDescription },
    },
    required: ["tasks"],
    additionalProperties: false,
  };
}

/**
 * Parameter schemas for the harness control tools.
 *
 * Deliberately no `enum`: the text marker this replaces was case-insensitive,
 * so a strict enum would reject "pipeline" from a model and turn a cosmetic
 * slip into a pipeline stop. The schema stays tolerant and `execute`
 * normalizes and validates, throwing on anything unusable.
 */
async function buildControlToolParams(): Promise<Record<string, unknown> | null> {
  const decisionDescription = "ANSWER_ONLY when the task needs no file change, PIPELINE when it does";
  const reasonDescription = "One line of justification, shown in the status bar";
  const changedFilesDescription = "Repository-relative paths this step changed";
  const commandDescription = "The check command as it was run";
  const resultDescription = "passed | failed | skipped";
  const notesDescription = "What the delivery step must know";
  const lessonsDescription =
    "Findings worth reusing: root causes, gotchas, codebase discoveries, configuration changes — the same ones saved with mem_save. Pass [] when there are none; an omitted field makes the report incomplete";

  let T: typeof import("typebox").Type | undefined;
  try {
    T = (await import("typebox")).Type;
  } catch {
    T = undefined;
  }
  if (T) {
    return {
      harness_decision: T.Object({
        decision: T.String({ description: decisionDescription }),
        reason: T.Optional(T.String({ description: reasonDescription })),
      }) as unknown as Record<string, unknown>,
      harness_report: T.Object({
        changed_files: T.Optional(T.Array(T.String({ description: changedFilesDescription }))),
        checks: T.Optional(
          T.Array(
            T.Object({
              command: T.String({ description: commandDescription }),
              result: T.String({ description: resultDescription }),
            }),
          ),
        ),
        notes: T.Optional(T.String({ description: notesDescription })),
        lessons: T.Optional(T.Array(T.String({ description: lessonsDescription }))),
      }) as unknown as Record<string, unknown>,
    };
  }
  return {
    harness_decision: {
      type: "object",
      properties: {
        decision: { type: "string", description: decisionDescription },
        reason: { type: "string", description: reasonDescription },
      },
      required: ["decision"],
    },
    harness_report: {
      type: "object",
      properties: {
        changed_files: { type: "array", items: { type: "string" }, description: changedFilesDescription },
        checks: {
          type: "array",
          description: "Checks actually run, with their outcome",
          items: {
            type: "object",
            properties: {
              command: { type: "string", description: commandDescription },
              result: { type: "string", description: resultDescription },
            },
            required: ["command"],
          },
        },
        notes: { type: "string", description: notesDescription },
        lessons: {
          type: "array",
          items: { type: "string" },
          description: lessonsDescription,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Summary and validation
// ---------------------------------------------------------------------------

export function summarize(lines: string[], configPath: string, cwd: string): string {
  const rel = path.relative(cwd, configPath) || configPath;
  const mode = getWorkflowMode(lines) ?? "(missing)";
  const contract = resolveContractPath(lines, configPath, cwd);
  const contractText = contract.path ?? "(none found; checked " + contractCandidates(cwd, configPath, lines).map((c) => path.relative(cwd, c.file) || c.file).join(", ") + ")";
  const out: string[] = [
    `Harness config: ${rel}`,
    `defaults.workflow_mode: ${mode}`,
    `defaults.auto_harness: ${isAutoHarness(lines) ? "true" : "false"}`,
    `defaults.question_short_circuit: ${isQuestionShortCircuit(lines) ? "true" : "false"}`,
    `defaults.allow_dispatch: ${isAllowDispatch(lines) ? "true" : "false"} (context: ${contractText})`,
    `defaults.strict_decision_marker: ${isStrictDecisionMarker(lines) ? "true" : "false"}`,
    `defaults.preflight_policy: ${preflightPolicy(lines)}`,
    "agents:",
  ];
  for (const agent of listAgents(lines)) {
    const block = agentBlock(lines, agent);
    const model = block ? getBlockField(lines, block, "model") ?? "(no model)" : "?";
    const reasoning = block ? getBlockField(lines, block, "reasoning") ?? "-" : "-";
    out.push(`  ${agent}: ${model} (reasoning: ${reasoning}; mutates files: ${agentMutatesFiles(lines, agent)})`);
  }
  out.push(`commands.model_catalog_source: ${getCatalogSource(lines) ?? "(missing)"}`);
  return out.join("\n");
}

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

export async function validate(
  lines: string[],
  configPath?: string,
  cwd?: string,
  modelCatalog?: ModelCatalog,
): Promise<Check[]> {
  const checks: Check[] = [];

  const mode = getWorkflowMode(lines);
  checks.push({
    label: "defaults.workflow_mode is one of the allowed modes",
    ok: mode !== null && MODE_IDS.includes(mode),
    detail: mode ?? "(missing)",
  });

  const policy = getDefaultString(lines, "preflight_policy", "advisory");
  checks.push({
    label: "defaults.preflight_policy is advisory or blocking",
    ok: policy === "advisory" || policy === "blocking",
    detail: policy,
  });

  const agents = listAgents(lines);
  for (const required of REQUIRED_AGENTS) {
    checks.push({ label: `agent "${required}" exists`, ok: agents.includes(required) });
  }

  for (const agent of agents) {
    const block = agentBlock(lines, agent);
    const modelRef = block ? getBlockField(lines, block, "model") : null;
    const declaresMutation = !!block && !!getBlockField(lines, block, "mutates_files");
    checks.push({
      label: `agent "${agent}" declares mutates_files`,
      ok: declaresMutation,
      detail: declaresMutation ? String(agentMutatesFiles(lines, agent)) : "(missing; assumed to mutate files)",
    });
    checks.push({ label: `agent "${agent}" has a model`, ok: !!modelRef, detail: modelRef ?? "(missing)" });
    const reasoning = block ? getBlockField(lines, block, "reasoning") : null;
    checks.push({ label: `agent "${agent}" has reasoning`, ok: !!reasoning, detail: reasoning ?? "(missing)" });
    if (modelCatalog && modelRef) {
      const model = findModelRef(modelRef, modelCatalog);
      checks.push({
        label: `agent "${agent}" model is in Pi's catalog`,
        ok: !!model,
        detail: model ? `${model.provider}/${model.id}` : modelRef,
      });
      if (model && reasoning) {
        const available = supportedReasoningLevels(model);
        checks.push({
          label: `agent "${agent}" reasoning is supported by its model`,
          ok: available.includes(reasoning as ReasoningLevelArg),
          detail: `configured: ${reasoning}; available: ${available.join(", ")}`,
        });
      }
    }
    const template = block ? getBlockField(lines, block, "prompt_template") : null;
    checks.push({ label: `agent "${agent}" has a prompt_template`, ok: !!template, detail: template ?? "(missing)" });
  }

  if (mode && MODE_IDS.includes(mode)) {
    const steps = getWorkflowSteps(lines, mode);
    checks.push({
      label: `workflows has an entry for mode "${mode}"`,
      ok: !!steps && steps.length > 0,
      detail: steps && steps.length > 0 ? steps.join(" -> ") : "(missing)",
    });
    if (steps) {
      for (const step of steps) {
        checks.push({ label: `workflow "${mode}" step "${step}" is a defined agent`, ok: agents.includes(step) });
      }
    }
  }

  if (configPath) {
    const baseCwd = cwd ?? path.dirname(configPath);
    for (const agent of agents) {
      const block = agentBlock(lines, agent);
      const rel = block ? getBlockField(lines, block, "prompt_template") : null;
      if (!rel) continue;
      const resolved = await resolvePromptTemplatePath(baseCwd, configPath, rel);
      checks.push({ label: `agent "${agent}" prompt_template file exists`, ok: !!resolved, detail: rel });
    }
  }

  if (configPath && isAllowDispatch(lines)) {
    const contract = resolveContractPath(lines, configPath, cwd);
    const base = cwd ?? path.dirname(configPath);
    const detail = contract.path
      ? path.relative(base, contract.path) || contract.path
      : contract.candidates.map((candidate) => path.relative(base, candidate) || candidate).join(" | ");
    checks.push({
      label: "contract file for dispatched subagents exists",
      ok: contract.path !== null,
      detail,
    });
    if (contract.staleConfig) {
      checks.push({
        label: "defaults.subagent_context_file points at an existing file",
        ok: false,
        detail: `${contract.staleConfig} (not found; fell back to ${contract.source})`,
      });
    }
  }

  const deliveryBlock = agentBlock(lines, "delivery");
  const hasDeliverySkill =
    !!deliveryBlock &&
    lines.slice(deliveryBlock.start, deliveryBlock.end).some((l) => /^\s*-\s*github-delivery\s*$/.test(l));
  checks.push({ label: "delivery includes the github-delivery skill", ok: hasDeliverySkill });

  const catalog = getCatalogSource(lines);
  checks.push({
    label: "commands.model_catalog_source points to /models",
    ok: catalog === "/models",
    detail: catalog ?? "(missing)",
  });

  return checks;
}

function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "OK  " : "FAIL"} ${c.label}${c.detail ? ` [${c.detail}]` : ""}`).join("\n");
}

// ---------------------------------------------------------------------------
// Interactive flows
// ---------------------------------------------------------------------------

function requireUI(ctx: ExtensionCommandContext): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify("This command needs an interactive terminal (TUI/RPC mode).", "error");
  return false;
}

async function pickMode(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  const lines = await readLines(configPath);
  const current = getWorkflowMode(lines);
  const choice = await ctx.ui.select(
    `Workflow mode (current: ${current ?? "none"})`,
    MODE_IDS.map((id) => (id === current ? `${id} (current)` : id)),
  );
  if (!choice) return;
  const mode = choice.replace(" (current)", "");
  await writeLines(configPath, setWorkflowMode(lines, mode));
  await refreshModeStatus(ctx);
  ctx.ui.notify(`defaults.workflow_mode set to "${mode}"`, "info");
}

async function pickAgentModelOnce(
  ctx: ExtensionCommandContext,
  configPath: string,
  agent: string,
  presetModel?: string,
  presetReasoning?: string,
): Promise<boolean> {
  const lines = await readLines(configPath);
  const agents = listAgents(lines);
  if (agents.length === 0) {
    ctx.ui.notify("No agents found in the configuration.", "error");
    return false;
  }
  if (!agents.includes(agent)) {
    ctx.ui.notify(`Unknown agent "${agent}". Available: ${agents.join(", ")}`, "error");
    return false;
  }

  const currentReasoning = (() => {
    const block = agentBlock(lines, agent);
    return block ? getBlockField(lines, block, "reasoning") : null;
  })();
  let model = presetModel;
  let pickedModel: PiModel | undefined;
  if (model) {
    pickedModel = findModelRef(model, ctx.modelRegistry);
    if (!pickedModel) {
      ctx.ui.notify(`Model "${model}" is not in Pi's catalog. Run /models; the configuration was not changed.`, "error");
      return false;
    }
    model = `${pickedModel.provider}/${pickedModel.id}`;
  } else {
    const block = agentBlock(lines, agent);
    const current = block ? getBlockField(lines, block, "model") : null;
    const registry = ctx.modelRegistry;
    let catalog = registry.getAvailable();
    if (catalog.length === 0) catalog = registry.getAll();
    if (catalog.length === 0) {
      ctx.ui.notify("No models in the catalog. Run /models and check provider authentication.", "error");
      return false;
    }

    const sorted = [...catalog].sort((a, b) =>
      a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
    );
    const byOption = new Map<string, PiModel>();
    const options = sorted.map((m) => {
      const ref = `${m.provider}/${m.id}`;
      const label = m.name && m.name !== m.id ? `${ref} — ${m.name}` : ref;
      const isCurrent = current === ref || current === m.id;
      const option = isCurrent ? `${label} (current)` : label;
      byOption.set(option, m);
      return option;
    });

    const title = current
      ? `Model for "${agent}" — catalog (current: ${current})`
      : `Model for "${agent}" — available models (${catalog.length})`;
    const choice = await ctx.ui.select(title, options);
    if (!choice) return false;
    pickedModel = byOption.get(choice);
    if (!pickedModel) return false;
    model = `${pickedModel.provider}/${pickedModel.id}`;
  }

  if (!pickedModel) return false;
  const available = supportedReasoningLevels(pickedModel);
  let reasoning = presetReasoning;
  if (reasoning && !available.includes(reasoning as ReasoningLevelArg)) {
    ctx.ui.notify(
      `Effort "${reasoning}" is not supported by "${model}". Available: ${available.join(", ")}. The configuration was not changed.`,
      "error",
    );
    return false;
  }
  if (!reasoning) {
    if (available.length === 1) {
      reasoning = available[0];
    } else {
      const byOption = new Map(available.map((level) => [level === currentReasoning ? `${level} (current)` : level, level]));
      const choice = await ctx.ui.select(`Reasoning effort for "${model}"`, [...byOption.keys()]);
      if (!choice) return false;
      reasoning = byOption.get(choice);
      if (!reasoning) return false;
    }
  }

  await writeLines(configPath, setAgentFields(lines, agent, { model, reasoning }));
  ctx.ui.notify(`agents.${agent} set to model "${model}" and reasoning "${reasoning}"`, "info");
  return true;
}

async function pickAgentModel(
  ctx: ExtensionCommandContext,
  configPath: string,
  presetAgent?: string,
  presetModel?: string,
  presetReasoning?: string,
): Promise<void> {
  // Explicit arguments are a one-shot operation for scripting and RPC users.
  if (presetAgent) {
    await pickAgentModelOnce(ctx, configPath, presetAgent, presetModel, presetReasoning);
    return;
  }

  // Interactive selection stays open until a change is saved and the operator
  // explicitly cancels from the first menu.
  while (true) {
    const lines = await readLines(configPath);
    const agents = listAgents(lines);
    if (agents.length === 0) {
      ctx.ui.notify("No agents found in the configuration.", "error");
      return;
    }
    const options = agents.map((agent) => {
      const block = agentBlock(lines, agent);
      const model = block ? getBlockField(lines, block, "model") : null;
      return model ? `${agent} (${model})` : agent;
    });
    options.push("Cancel");
    const choice = await ctx.ui.select("Select agent", options);
    if (!choice || choice === "Cancel") return;
    const agent = choice.replace(/\s*\(.*\)\s*$/, "");
    if (!await pickAgentModelOnce(ctx, configPath, agent)) return;
  }
}

async function showConfig(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  const lines = await readLines(configPath);
  ctx.ui.notify(summarize(lines, configPath, ctx.cwd), "info");
}

async function runValidation(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  const lines = await readLines(configPath);
  const checks = await validate(lines, configPath, ctx.cwd, ctx.modelRegistry);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    ctx.ui.notify(`Configuration valid: ${checks.length} checks passed.`, "info");
  } else {
    ctx.ui.notify(`${failed.length}/${checks.length} checks failed:\n${formatChecks(checks)}`, "warning");
  }
}

function explainModes(): string {
  return MODES.map((m) => `${m.id}\n  steps: ${m.steps}\n  use when: ${m.when}`).join("\n\n");
}

function explainModels(): string {
  return [
    "The model picker shows Pi's available model catalog directly — choose from the list.",
    "After choosing a model, pick a reasoning effort from the levels supported by that model.",
    "Identifiers use the exact Pi format: <provider>/<model-id> (e.g. opencode-go/gpt-5.1).",
    "Run Pi's /models command to browse or refresh the catalog if a model is missing.",
    "Do not invent model IDs and do not substitute a different model silently.",
  ].join("\n");
}

function explainAutoHarness(on: boolean): string {
  return [
    `auto-harness is ${on ? "ON" : "OFF"}.`,
    on
      ? "Plain requests (no leading /) are consumed and run through the workflow pipeline automatically. Slash commands, steering messages and pipeline-free chat are unaffected... any non-slash text triggers the pipeline."
      : "Plain requests go straight to the model. Use /harness-auto on to enable the pipeline, or /harness-run <task> to run it explicitly.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CONFIG_MENU = [
  "1. Show current configuration",
  "2. Change workflow mode",
  "3. Change an agent model and effort",
  "4. Validate configuration",
  "5. Explain available modes",
  "6. Explain how to choose models with /models",
  "7. Toggle auto-harness (plain requests run the pipeline)",
  "Cancel",
];

export default async function harnessExtension(pi: ExtensionAPI) {
  let pipelineRunning = false;

  // Show the workflow mode in the footer as soon as the session starts
  // (also runs after /reload, which rebuilds the extension runtime).
  pi.on("session_start", (_event, ctx) => {
    lastDecision = null;
    lastDecisionReason = "";
    lastReport = null;
    lastProgress = null;
    return refreshModeStatus(ctx);
  });

  // Move the orchestrator's decision marker out of the visible reply and into
  // the footer: record it, refresh the status bar, strip it from the message.
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as unknown as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return {};
    let decision: HarnessDecision = null;
    let changed = false;
    const content = message.content.map((part) => part);
    // Only the last text part can carry the decision line. A marker quoted
    // earlier belongs to the prose and is left visible: stripping it would
    // delete the sentence the model wrote and let the example decide.
    for (let p = content.length - 1; p >= 0; p--) {
      const part = content[p];
      if (part?.type !== "text" || !part.text) continue;
      const split = splitDecisionLine(part.text);
      if (!split.hadMarker) continue;
      decision = split.decision;
      changed = true;
      content[p] = { ...part, text: split.rest };
      break;
    }
    if (!changed) return {};
    if (decision !== null) {
      // Only when still empty: a harness_decision call runs after this hook
      // (the runtime emits message_end, then executes tool calls) and must
      // keep the last word when both a marker and a tool call disagree.
      if (lastDecision === null) {
        lastDecision = decision;
        lastProgress = await computeDecisionProgress(ctx, decision);
        await refreshModeStatus(ctx);
      }
    }
    return { message: { ...message, content } as unknown as typeof event.message };
  });

  // Auto-harness: consume plain requests and run them through the pipeline.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    if (event.streamingBehavior) return { action: "continue" };
    if (pipelineRunning) return { action: "continue" };
    const task = event.text.trim();
    if (!task || task.startsWith("/")) return { action: "continue" };
    try {
      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) return { action: "continue" };
      const lines = await readLines(configPath);
      if (!isAutoHarness(lines)) return { action: "continue" };
      pipelineRunning = true;
      void runPipeline(pi, ctx, task, () => pollIdle(ctx))
        .catch((error) => ctx.ui.notify(`harness pipeline failed: ${String(error)}`, "error"))
        .finally(() => {
          pipelineRunning = false;
        });
      return { action: "handled" };
    } catch {
      return { action: "continue" };
    }
  });

  pi.registerCommand("harness-config", {
    description: "Configure the Corpustory harness (workflow mode, agent models, validation, auto-harness)",
    handler: async (_args, ctx) => {
      if (!requireUI(ctx)) return;
      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const choice = await ctx.ui.select("Corpustory harness configuration", CONFIG_MENU);
      if (!choice || choice === "Cancel") return;
      if (choice.startsWith("1.")) await showConfig(ctx, configPath);
      else if (choice.startsWith("2.")) await pickMode(ctx, configPath);
      else if (choice.startsWith("3.")) await pickAgentModel(ctx, configPath);
      else if (choice.startsWith("4.")) await runValidation(ctx, configPath);
      else if (choice.startsWith("5.")) ctx.ui.notify(explainModes(), "info");
      else if (choice.startsWith("6.")) ctx.ui.notify(explainModels(), "info");
      else if (choice.startsWith("7.")) {
        const lines = await readLines(configPath);
        const next = !isAutoHarness(lines);
        await writeLines(configPath, setAutoHarness(lines, next));
        await refreshModeStatus(ctx);
        ctx.ui.notify(explainAutoHarness(next), "info");
      }
    },
  });

  pi.registerCommand("harness-mode", {
    description: "Show or change the default harness workflow mode",
    getArgumentCompletions: (prefix) => {
      const filtered = MODE_IDS.filter((id) => id.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((id) => ({ value: `/harness-mode ${id}` })) : null;
    },
    handler: async (args, ctx) => {
      if (!requireUI(ctx)) return;
      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const requested = args.trim();
      if (!requested) {
        await pickMode(ctx, configPath);
        return;
      }
      if (!MODE_IDS.includes(requested)) {
        ctx.ui.notify(`Unknown mode "${requested}". Allowed: ${MODE_IDS.join(", ")}`, "error");
        return;
      }
      const lines = await readLines(configPath);
      await writeLines(configPath, setWorkflowMode(lines, requested));
      await refreshModeStatus(ctx);
      ctx.ui.notify(`defaults.workflow_mode set to "${requested}"`, "info");
    },
  });

  pi.registerCommand("harness-model", {
    description: "Set a harness agent's model and effort (menu, or: <agent> <model-id> [effort])",
    handler: async (args, ctx) => {
      if (!requireUI(ctx)) return;
      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 3) {
        ctx.ui.notify("Usage: /harness-model [agent [model-id [effort]]]", "error");
        return;
      }
      await pickAgentModel(ctx, configPath, parts[0], parts[1], parts[2]);
    },
  });

  pi.registerCommand("harness-run", {
    description: "Run a task through the configured workflow pipeline (delegates step by step)",
    handler: async (args, ctx) => {
      if (!requireUI(ctx)) return;
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /harness-run <task description>", "info");
        return;
      }
      if (pipelineRunning) {
        ctx.ui.notify("A harness pipeline is already running.", "warning");
        return;
      }
      pipelineRunning = true;
      try {
        await runPipeline(pi, ctx, task, () => ctx.waitForIdle());
      } catch (error) {
        ctx.ui.notify(`Pipeline failed: ${String(error)}`, "error");
      } finally {
        pipelineRunning = false;
      }
    },
  });

  pi.registerCommand("harness-delivery", {
    description: "Run the delivery agent without changing defaults.workflow_mode",
    handler: async (args, ctx) => {
      if (!requireUI(ctx)) return;
      if (pipelineRunning) {
        ctx.ui.notify("A harness pipeline is already running.", "warning");
        return;
      }
      const task = args.trim() || "Deliver the current verified changes.";
      pipelineRunning = true;
      try {
        await runPipeline(pi, ctx, task, () => ctx.waitForIdle(), "delivery-only", "delivery");
      } catch (error) {
        ctx.ui.notify(`Delivery failed: ${String(error)}`, "error");
      } finally {
        pipelineRunning = false;
      }
    },
  });

  pi.registerCommand("harness-auto", {
    description: "Show or toggle auto-harness (plain requests run the workflow pipeline automatically)",
    getArgumentCompletions: (prefix) => {
      const filtered = ["on", "off"].filter((v) => v.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v })) : null;
    },
    handler: async (args, ctx) => {
      if (!requireUI(ctx)) return;
      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const lines = await readLines(configPath);
      const requested = args.trim().toLowerCase();
      if (!requested) {
        ctx.ui.notify(explainAutoHarness(isAutoHarness(lines)), "info");
        return;
      }
      if (!["on", "off", "true", "false"].includes(requested)) {
        ctx.ui.notify('Usage: /harness-auto [on|off]', "error");
        return;
      }
      const on = requested === "on" || requested === "true";
      await writeLines(configPath, setAutoHarness(lines, on));
      await refreshModeStatus(ctx);
      ctx.ui.notify(explainAutoHarness(on), "info");
    },
  });

  // Background dispatch: isolated subagents with a curated brief.
  pi.registerTool({
    name: "harness-dispatch",
    label: "Harness dispatch",
    description: [
      "Dispatch independent background tasks to isolated harness agents (separate pi processes with their own context).",
      "Each task carries a curated brief — the only task context the subagent receives; the project rules are injected as its system prompt.",
      `Up to ${DISPATCH_MAX_TASKS} tasks, ${DISPATCH_CONCURRENCY} run at a time.`,
    ].join(" "),
    promptSnippet: "Delegate independent, read-heavy work to isolated harness agents with a curated brief.",
    promptGuidelines: [
      "Use harness-dispatch only for independent work (exploration, reconnaissance, review) — never for steps that depend on each other.",
      "Never paste the conversation into a brief: include objective, relevant files with line refs, constraints, acceptance criteria, expected evidence, non-goals and unknowns.",
      "Compose your final answer from the returned results.",
    ],
    parameters: await buildDispatchParams(),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // The runtime marks a tool call as an error only when execute throws: an
      // `isError` field on a returned result is ignored, and `AgentToolResult`
      // does not define one. Returning a "failed" object would record the
      // call as a success, so every failure path below throws instead.
      const fail = (message: string): never => {
        throw new Error(message);
      };

      const configPath = await resolveConfigPath(ctx.cwd);
      if (!configPath) return fail("No harness configuration found (harness.config.yaml).");
      const lines = await readLines(configPath);
      if (!isAllowDispatch(lines)) return fail("Dispatch is disabled (defaults.allow_dispatch: false).");

      const tasks = params.tasks ?? [];
      if (tasks.length === 0 || tasks.length > DISPATCH_MAX_TASKS) {
        return fail(`Provide between 1 and ${DISPATCH_MAX_TASKS} tasks.`);
      }

      const contract = resolveContractPath(lines, configPath, ctx.cwd);
      if (!contract.path) {
        const tried = contract.candidates.map((candidate) => path.relative(ctx.cwd, candidate) || candidate).join(", ");
        return fail(
          `No contract file found for dispatched subagents (checked: ${tried}). ` +
            `Run 'npx pi-minimal-harness update' in this project, or set defaults.subagent_context_file to a file that exists.`,
        );
      }
      const contractPath = contract.path;

      interface Prepared {
        agent: string;
        brief: string;
        args: string[];
      }
      const prepared: Prepared[] = [];
      const tempDirs: string[] = [];
      const failPrepared = async (message: string): Promise<never> => {
        for (const dir of tempDirs) {
          try {
            await fs.rm(dir, { recursive: true, force: true });
          } catch {
            // best effort cleanup
          }
        }
        throw new Error(message);
      };
      for (const task of tasks) {
        const block = agentBlock(lines, task.agent);
        if (!block) {
          return failPrepared(`Unknown agent "${task.agent}". Available: ${listAgents(lines).join(", ")}`);
        }
        const brief = (task.brief ?? "").trim();
        if (!brief) return failPrepared(`Empty brief for agent "${task.agent}".`);
        const templateRel = getBlockField(lines, block, "prompt_template");
        if (!templateRel) return failPrepared(`Agent "${task.agent}" has no prompt_template.`);
        const templatePath = await resolvePromptTemplatePath(ctx.cwd, configPath, templateRel);
        if (!templatePath) return failPrepared(`Prompt template not found for "${task.agent}": ${templateRel}`);
        const modelRef = getBlockField(lines, block, "model");
        const model = modelRef ? findModelRef(modelRef, ctx.modelRegistry) : undefined;
        const thinking = getBlockField(lines, block, "reasoning");
        if (modelRef && !model) {
          return failPrepared(`Agent "${task.agent}" model "${modelRef}" is not in Pi's catalog. Run /models and refresh authentication.`);
        }
        if (model && thinking && !supportedReasoningLevels(model).includes(thinking as ReasoningLevelArg)) {
          return failPrepared(
            `Agent "${task.agent}" effort "${thinking}" is not supported by "${model.provider}/${model.id}". Available: ${supportedReasoningLevels(model).join(", ")}.`,
          );
        }
        const systemPrompt = await composeDispatchSystemPrompt({
          templatePath,
          contractPath,
          agent: task.agent,
          brief,
        });
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-"));
        tempDirs.push(dir);
        const systemPromptPath = path.join(dir, "system.md");
        await fs.writeFile(systemPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
        prepared.push({
          agent: task.agent,
          brief,
          args: buildDispatchArgs({
            systemPromptPath,
            model: model ? `${model.provider}/${model.id}` : undefined,
            thinking: thinking && (THINKING_LEVELS.has(thinking) || thinking === "off") ? thinking : undefined,
            brief,
          }),
        });
      }

      const statuses = prepared.map(() => "pending");
      const results: Array<DispatchTaskResult | undefined> = prepared.map(() => undefined);
      const total = prepared.length;

      const renderState = () => {
        if (ctx.hasUI) {
          const done = results.filter((r) => r !== undefined).length;
          const ok = results.filter((r) => r?.ok).length;
          ctx.ui.setWidget(
            DISPATCH_WIDGET_KEY,
            [
              `Harness dispatch — ${done}/${total} done, ${ok} ok`,
              ...prepared.map((item, index) => {
                const icon =
                  statuses[index] === "done"
                    ? "✓"
                    : statuses[index] === "failed"
                      ? "✗"
                      : statuses[index] === "running"
                        ? "…"
                        : "·";
                return `${icon} ${item.agent}`;
              }),
            ],
            { placement: "aboveEditor" },
          );
        }
        if (onUpdate) {
          const done = results.filter((r) => r !== undefined).length;
          onUpdate({
            content: [
              {
                type: "text" as const,
                text: `dispatch ${done}/${total} — ${prepared.map((item, i) => `${statuses[i]}: ${item.agent}`).join(" | ")}`,
              },
            ],
          });
        }
      };

      renderState();
      try {
        await mapWithConcurrency(
          prepared,
          params.parallel === false ? 1 : DISPATCH_CONCURRENCY,
          async (item, index) => {
            if (signal?.aborted) {
              results[index] = { agent: item.agent, ok: false, text: "", stopReason: "aborted" };
              statuses[index] = "failed";
              renderState();
              return;
            }
            statuses[index] = "running";
            renderState();
            try {
              results[index] = await runDispatchTask({ cwd: ctx.cwd, agent: item.agent, args: item.args, signal });
            } catch (error) {
              results[index] = { agent: item.agent, ok: false, text: "", stderr: String(error) };
            }
            statuses[index] = results[index]?.ok ? "done" : "failed";
            renderState();
          },
        );
      } finally {
        if (ctx.hasUI) ctx.ui.setWidget(DISPATCH_WIDGET_KEY, undefined);
        for (const dir of tempDirs) {
          try {
            await fs.rm(dir, { recursive: true, force: true });
          } catch {
            // best effort cleanup
          }
        }
      }

      const summaries = prepared.map((item, index) => {
        const result = results[index];
        if (!result) return `### [${item.agent}] missing result`;
        const status = result.ok
          ? "ok"
          : `failed${result.stopReason ? ` (${result.stopReason})` : ""}${result.exitCode !== undefined ? ` exit=${result.exitCode}` : ""}`;
        const body = result.ok
          ? result.text || "(no output)"
          : `${result.stderr ?? ""}${result.text ? `\n${result.text}` : ""}`.trim() || "(no output)";
        return `### [${item.agent}] ${status}\n\n${body}`;
      });
      const failedCount = results.filter((r) => !r?.ok).length;
      const summary = formatDispatchOutcome(total, failedCount, summaries);
      // Throwing is what marks the call as a failure, so a batch where every
      // agent failed throws with the summary in the message: the model still
      // sees which agents failed and why. A partial batch is a success that
      // reports the failures in its text.
      if (failedCount === total) throw new Error(summary);
      return {
        content: [{ type: "text" as const, text: summary }],
        details: undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Control tools: the structured replacement for the textual markers. The
  // markers stay as a one-release fallback for prompts and adopters that have
  // not migrated yet; the tool always wins when both are present.
  // -------------------------------------------------------------------------
  const controlParams = await buildControlToolParams();
  if (controlParams) {
    pi.registerTool({
      name: "harness_decision",
      label: "Harness decision",
      description: [
        "Declare whether this task needs file changes at all.",
        "ANSWER_ONLY ends the harness pipeline after this step; PIPELINE continues with the remaining steps.",
        "Call it once, at the end, instead of writing a HARNESS-DECISION line.",
      ].join(" "),
      promptSnippet: "End a harness orchestrator turn with harness_decision(ANSWER_ONLY | PIPELINE) instead of a text marker.",
      promptGuidelines: [
        "Call harness_decision exactly once, at the end of the turn, when running as the orchestrator step of a harness pipeline.",
        "Do not call it in ordinary conversation: it only has an effect inside a pipeline.",
      ],
      parameters: controlParams.harness_decision as never,
      async execute(_toolCallId, params) {
        const decision = normalizeDecision((params as { decision?: unknown }).decision);
        if (decision === null) {
          // Throw: the runtime marks a thrown tool as an error, while an
          // `isError` field on a returned result is ignored.
          throw new Error('decision must be "ANSWER_ONLY" or "PIPELINE".');
        }
        const reason = typeof (params as { reason?: unknown }).reason === "string" ? (params as { reason: string }).reason : "";
        if (!pipelineActive) {
          return {
            content: [{ type: "text" as const, text: "Recorded. (No harness pipeline is running, so this has no effect.)" }],
            details: undefined,
          };
        }
        // Assign unconditionally: the message_end hook runs BEFORE this
        // execute (the runtime emits message_end, then executes tool calls),
        // so a "only when empty" guard here would let the text marker win.
        lastDecision = decision;
        lastDecisionReason = reason.trim();
        return {
          content: [{ type: "text" as const, text: `Decision recorded: ${decision}.` }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: "harness_report",
      label: "Harness report",
      description: [
        "Record the structured report of a finished harness step.",
        "Use it instead of the HARNESS-DONE line: the harness verifies the tool call, not the text.",
        "The markdown report is still written in the reply; this adds machine-readable data.",
      ].join(" "),
      promptSnippet: "End a harness agent step with harness_report(changed_files, checks, notes, lessons) alongside the written report.",
      promptGuidelines: [
        "Call harness_report exactly once, at the end of the turn, when finishing a harness pipeline step that owes a report.",
        "changed_files lists the paths you actually changed; checks lists the commands you actually ran, with their outcome.",
        "Report every check you could not run as skipped. Do not claim a check you did not run.",
        "Every field is required: a report missing one of them is incomplete and costs a repair turn. Pass [] for a field that is genuinely empty, and lessons when there is anything worth remembering.",
      ],
      parameters: controlParams.harness_report as never,
      async execute(_toolCallId, params) {
        if (!pipelineActive) {
          return {
            content: [{ type: "text" as const, text: "Recorded. (No harness pipeline is running, so this has no effect.)" }],
            details: undefined,
          };
        }
        const raw = params as {
          changed_files?: unknown;
          checks?: unknown;
          notes?: unknown;
          lessons?: unknown;
        };
        // A field the agent omitted (or sent blank) stays null so the driver can
        // call it a gap; [] is the explicit "nothing to record" and is complete.
        const changedFiles = Array.isArray(raw.changed_files)
          ? raw.changed_files.filter((p): p is string => typeof p === "string")
          : null;
        const checks = Array.isArray(raw.checks)
          ? raw.checks
              .filter((c): c is { command: unknown; result?: unknown } => !!c && typeof c === "object")
              .map((c) => ({
                command: String((c as { command: unknown }).command ?? ""),
                result: normalizeCheckResult((c as { result?: unknown }).result),
              }))
          : null;
        const lessons = normalizeLessons(raw.lessons);
        lastReport = {
          changedFiles,
          checks,
          lessons,
          notes: typeof raw.notes === "string" ? raw.notes : "",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Report recorded: ${changedFiles?.length ?? 0} file(s), ${checks?.length ?? 0} check(s), ${lessons?.length ?? 0} lesson(s).`,
            },
          ],
          details: undefined,
        };
      },
    });
  }
}
