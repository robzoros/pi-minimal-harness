/**
 * Validation for the v2 configuration.
 *
 * Two decisions shape everything here:
 *   - Fail closed (C2). A key that is not in the schema is an ERROR, because a
 *     typo that is only a warning is a typo nobody notices.
 *   - Separate what is broken from what is merely absent (C4/C5). `memory` and
 *     `graph` missing from the registry WARN, since the agent degrades to a
 *     fallback. `vcs`/`github` without `shell`, or a missing `read`, ERROR,
 *     because those are inconsistencies inside the file itself.
 */

import { capabilitiesToTools, isCapability, ALL_CAPABILITIES } from "./capabilities.ts";
import { AGENT_NAMES, REASONING_LEVELS, type ParsedConfig } from "./config.ts";

export type Severity = "error" | "warning";

export interface Check {
  label: string;
  ok: boolean;
  severity: Severity;
  detail?: string;
}

export interface ValidateOptions {
  /** Tool names from `pi.getAllTools()`. Injected so this stays pure. */
  availableTools?: string[];
  /**
   * `provider/id` of every model the runtime can actually call. Injected so
   * this stays pure. A configured model that is not in this set will fail
   * minutes into a workflow, which is the worst place to find out.
   */
  usableModels?: string[];
}

/**
 * Keys that existed in v1. Seeing one means the file predates the rewrite, and
 * the error should say so instead of listing it as an unknown key.
 */
export const V1_KEYS: ReadonlySet<string> = new Set([
  "project",
  "defaults",
  "commands",
  "workflows",
  "skills",
  "workflow_mode",
  "auto_harness",
  "question_short_circuit",
  "allow_dispatch",
  "allow_simple_mode",
  "strict_decision_marker",
  "preflight_policy",
  "preferred_interface",
  "fallback_interface",
  "model_catalog_source",
  "subagent_context_file",
  "mutates_files",
  "tools",
  "responsibilities",
  "prompt_template",
]);

const MIGRATION_HINT = "this is a v1 configuration; run `npx pi-minimal-harness update` to migrate it to v2";

/**
 * The only agents that may hold `write`, and why.
 *
 * The planner owns the requirements file, so it needs the capability to edit it
 * and nothing else. Everyone else must not have it — an agent that cannot write
 * cannot damage the repository, whatever it decides to do.
 *
 * This is a CAPABILITY rule, not an isolation one: `write` maps to the same
 * tools for both, with no path, so neither agent is confined to its own file.
 * Keeping the requirements file out of everyone else's hands rests on the role
 * boundary and on review, not on this check.
 */
export const WRITE_CAPABLE_AGENTS: readonly string[] = ["planner", "implementer"];

/** The placeholders `init` ships, which no agent can run with. */
export const TEMPLATE_PLACEHOLDERS: readonly string[] = ["provider/model-id", "model-id", "your-model"];

/** MCP tool names the declarative capabilities depend on. */
const TOOL_PREFIXES: Record<string, string[]> = {
  memory: ["mem_"],
  graph: ["codegraph"],
};

export function validateConfig(parsed: ParsedConfig, options: ValidateOptions = {}): Check[] {
  const checks: Check[] = [];
  const available = new Set(options.availableTools ?? []);

  checks.push({
    label: "configuration declares harness.version 2",
    ok: parsed.isV2,
    severity: "error",
    detail: parsed.config?.version === undefined ? "harness.version is missing" : `version is ${parsed.config.version}`,
  });

  for (const issue of parsed.issues) {
    checks.push({ label: "configuration parses", ok: false, severity: "error", detail: issue });
  }

  for (const unknown of parsed.unknownKeys) {
    const legacy = V1_KEYS.has(unknown.key) || [...V1_KEYS].some((k) => unknown.path.endsWith(`.${k}`));
    checks.push({
      label: legacy ? "no v1 keys remain" : "no unknown keys",
      ok: false,
      severity: "error",
      detail: legacy ? `${unknown.path} — ${MIGRATION_HINT}` : `${unknown.path} is not part of the v2 schema`,
    });
  }

  const config = parsed.config;
  if (!config) {
    checks.push({ label: "configuration is usable", ok: false, severity: "error", detail: "nothing could be parsed" });
    return checks;
  }

  // --- agents ---------------------------------------------------------------

  for (const required of AGENT_NAMES) {
    checks.push({
      label: `agent "${required}" is defined`,
      ok: Boolean(config.agents[required]),
      severity: "error",
      detail: config.agents[required] ? undefined : `missing (known: ${AGENT_NAMES.join(", ")})`,
    });
  }
  for (const name of Object.keys(config.agents)) {
    const agent = config.agents[name];
    if (!(AGENT_NAMES as readonly string[]).includes(name)) {
      checks.push({ label: `agent "${name}" is part of the workflow`, ok: false, severity: "error", detail: `unknown agent; expected one of ${AGENT_NAMES.join(", ")}` });
      continue;
    }
    checks.push({ label: `agent "${name}" has a model`, ok: Boolean(agent.model), severity: "error", detail: agent.model });
    if (agent.model && TEMPLATE_PLACEHOLDERS.includes(agent.model.trim())) {
      // init ships placeholders. Running with one is not a degraded run, it is
      // no run: Pi falls back to a custom model id and the step fails.
      checks.push({
        label: `agent "${name}" has a real model`,
        ok: false,
        severity: "error",
        detail: `${agent.model} is the template placeholder; run /harness-model ${name}`,
      });
    }
    if (options.usableModels && agent.model && !options.usableModels.includes(agent.model)) {
      checks.push({
        label: `agent "${name}" has a usable model`,
        ok: false,
        severity: "warning",
        detail: `${agent.model} is not in Pi's usable set; run /models to authenticate, then /harness-model ${name}`,
      });
    }
    checks.push({
      label: `agent "${name}" has a valid reasoning level`,
      ok: typeof agent.reasoning === "string" && (REASONING_LEVELS as readonly string[]).includes(agent.reasoning),
      severity: "error",
      detail: agent.reasoning ?? "(missing)",
    });
    checks.push({
      label: `agent "${name}" declares capabilities`,
      ok: agent.capabilities.length > 0,
      severity: "error",
      detail: agent.capabilities.join(", ") || "(none)",
    });

    // --- capability invariants (C5) ---------------------------------------
    const unknownCapabilities = agent.capabilities.filter((c) => !isCapability(c));
    checks.push({
      label: `agent "${name}" uses known capabilities`,
      ok: unknownCapabilities.length === 0,
      severity: "error",
      detail: unknownCapabilities.length > 0 ? `${unknownCapabilities.join(", ")} (known: ${ALL_CAPABILITIES.join(", ")})` : agent.capabilities.join(", "),
    });

    const mapping = capabilitiesToTools(agent.capabilities);
    for (const error of mapping.errors) {
      checks.push({ label: `agent "${name}" capabilities are consistent`, ok: false, severity: "error", detail: error });
    }
    if (mapping.errors.length === 0) {
      checks.push({
        label: `agent "${name}" capabilities are consistent`,
        ok: true,
        severity: "error",
        detail: mapping.tools.length > 0 ? `tools: ${mapping.tools.join(",")}` : "no enforceable tools",
      });
    }

    // --- environment (C4) --------------------------------------------------
    if (options.availableTools) {
      for (const capability of mapping.declarative) {
        const prefixes = TOOL_PREFIXES[capability];
        if (!prefixes) continue;
        const found = [...available].some((tool) => prefixes.some((p) => tool.startsWith(p)));
        checks.push({
          label: `agent "${name}" can use ${capability}`,
          ok: found,
          severity: "warning",
          detail: found
            ? undefined
            : `no tool matching ${prefixes.join("/")} is registered; the agent must fall back${
                capability === "memory" ? " to the lessons field" : " to grep/rg and say so"
              }`,
        });
      }
    }
  }

  // Who may write. Enumerated rather than derived, so adding a fourth writable
  // agent has to be a decision instead of a side effect of editing a list.
  for (const agent of AGENT_NAMES) {
    const holds = config.agents[agent]?.capabilities.includes("write") ?? false;
    const should = WRITE_CAPABLE_AGENTS.includes(agent);
    if (holds !== should) {
      checks.push({
        label: `agent "${agent}" has the right to write`,
        ok: false,
        severity: "error",
        detail: holds
          ? `"write" is reserved to ${WRITE_CAPABLE_AGENTS.join(" and ")}`
          : `"write" is required: the ${agent} owns a file it must be able to edit`,
      });
    }
  }

  return checks;
}

/** Convenience for callers that only care whether anything is fatal. */
export function hasErrors(checks: Check[]): boolean {
  return checks.some((c) => !c.ok && c.severity === "error");
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "OK  " : c.severity === "error" ? "FAIL" : "WARN"} ${c.label}${c.detail ? ` [${c.detail}]` : ""}`).join("\n");
}
