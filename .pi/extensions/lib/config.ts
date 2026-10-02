/**
 * Parser for the v2 harness configuration.
 *
 * Dedicated on purpose: v2 is a fixed, tiny shape (scalars under `harness:`
 * plus one block per agent), so a purpose-built parser is shorter and far more
 * testable than the generic line walker in harness.ts and bin/.
 *
 * Parsing and policy are kept apart. The parser reports what it saw, including
 * keys it does not recognise; `validate.ts` decides whether an unknown key is
 * an error and whether it looks like a v1 leftover.
 */

export const CONFIG_VERSION = 2;
export const AGENT_NAMES = ["planner", "explorer", "implementer", "reviewer", "tester", "deliverer"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "off"] as const;

export interface AgentConfig {
  name: string;
  model?: string;
  reasoning?: string;
  capabilities: string[];
}

export interface HarnessConfig {
  version?: number;
  requirementsFile?: string;
  maxRetries?: number;
  agentTimeoutMs?: number;
  autoStart?: boolean;
  subagentContextFile?: string;
  agents: Record<string, AgentConfig>;
}

export interface UnknownKey {
  /** Dotted path, e.g. "agents.implementer.mutates_files". */
  path: string;
  key: string;
}

export interface ParsedConfig {
  /** null when the file could not be read as YAML-ish at all. */
  config: HarnessConfig | null;
  /** Parse-level problems: malformed values, wrong types. */
  issues: string[];
  unknownKeys: UnknownKey[];
  /** True only when `harness.version` is present and equals CONFIG_VERSION. */
  isV2: boolean;
}

export const DEFAULTS = {
  requirementsFile: ".harness/requirements.md",
  maxRetries: 3,
  agentTimeoutMs: 600_000,
  autoStart: true,
  subagentContextFile: "pi-minimal-harness.md",
} as const;

const HARNESS_KEYS = ["version", "requirements_file", "max_retries", "agent_timeout_ms", "auto_start", "subagent_context_file"] as const;
const AGENT_KEYS = ["model", "reasoning", "capabilities"] as const;

interface Line {
  indent: number;
  content: string;
  lineNo: number;
}

/** Strip comments and blank lines, keeping indentation and original line numbers. */
function toLines(input: string | string[]): Line[] {
  const raw = typeof input === "string" ? input.split(/\r?\n/) : input;
  const out: Line[] = [];
  raw.forEach((text, index) => {
    const withoutComment = text.replace(/(^|\s)#.*$/, "$1");
    if (withoutComment.trim() === "") return;
    out.push({ indent: withoutComment.length - withoutComment.trimStart().length, content: withoutComment.trim(), lineNo: index + 1 });
  });
  return out;
}

const keyOf = (content: string): string => {
  const at = content.indexOf(":");
  return (at === -1 ? content : content.slice(0, at)).trim();
};

const valueOf = (content: string): string => {
  const at = content.indexOf(":");
  return (at === -1 ? "" : content.slice(at + 1)).trim();
};

const scalarOf = (raw: string): string => raw.trim();

/** `[read, write]` and a block list both yield the same list. */
const inlineList = (value: string): string[] | null => {
  if (!value.startsWith("[")) return null;
  const inner = value.replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return inner.split(",").map((v) => v.trim()).filter(Boolean);
};

/**
 * Parse the v2 configuration.
 *
 * Never throws: a malformed file comes back as `config: null` plus `issues`,
 * because a broken config must produce readable validation checks rather than
 * a stack trace in the middle of a workflow.
 */
export function parseConfig(input: string | string[]): ParsedConfig {
  const lines = toLines(input);
  const issues: string[] = [];
  const unknownKeys: UnknownKey[] = [];
  const config: HarnessConfig = { agents: {} };
  let sawHarness = false;
  let sawAgents = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indent !== 0) continue;
    const section = keyOf(line.content);

    if (section === "harness") {
      sawHarness = true;
      const block = childBlock(lines, i);
      for (const child of block.children) {
        if (child.indent !== line.indent + 2) continue;
        const key = keyOf(child.content);
        if (!(HARNESS_KEYS as readonly string[]).includes(key)) {
          unknownKeys.push({ path: `harness.${key}`, key });
          continue;
        }
        assignHarness(config, key, valueOf(child.content), child.lineNo, issues);
      }
      i = block.lastIndex;
      continue;
    }

    if (section === "agents") {
      sawAgents = true;
      const block = childBlock(lines, i);
      // Only a line exactly two levels in names an agent; deeper lines belong to
      // the agent above them, so `model: p/m` is never mistaken for a name.
      const headers = block.children.filter((c) => c.indent === line.indent + 2);
      for (let h = 0; h < headers.length; h++) {
        const header = headers[h];
        const name = keyOf(header.content);
        const agent: AgentConfig = { name, capabilities: [] };
        config.agents[name] = agent;
        // Bound the scan to this agent's own range. Filtering on
        // `indent > header.indent` is not enough: the next agent header sits at
        // the same indent and is skipped, but ITS fields are deeper and would
        // be absorbed by the agent above.
        const from = block.children.indexOf(header);
        const to = h + 1 < headers.length ? block.children.indexOf(headers[h + 1]) : block.children.length;
        for (const field of block.children.slice(from + 1, to)) {
          const key = keyOf(field.content);
          if (!(AGENT_KEYS as readonly string[]).includes(key)) {
            unknownKeys.push({ path: `agents.${name}.${key}`, key });
            continue;
          }
          if (key === "capabilities") {
            const inline = inlineList(valueOf(field.content));
            agent.capabilities = inline ?? block.children
              .filter((c) => c.indent > field.indent && c.content.startsWith("-"))
              .map((c) => scalarOf(c.content.slice(1)));
            if (agent.capabilities.length === 0) issues.push(`line ${field.lineNo}: agents.${name}.capabilities is empty`);
            continue;
          }
          const value = valueOf(field.content);
          if (key === "model") agent.model = value;
          if (key === "reasoning") agent.reasoning = value;
          if (value === "") issues.push(`line ${field.lineNo}: agents.${name}.${key} is empty`);
        }
      }
      i = block.lastIndex;
      continue;
    }

    unknownKeys.push({ path: section, key: section });  }

  const isV2 = sawHarness && sawAgents && config.version === CONFIG_VERSION;
  if (!sawHarness) issues.push("no `harness:` section");
  if (!sawAgents) issues.push("no `agents:` section");

  return { config: issues.length > 0 && config === null ? null : config, issues, unknownKeys, isV2 };
}

function childBlock(lines: Line[], parentIndex: number): { children: Line[]; lastIndex: number } {
  const parentIndent = lines[parentIndex].indent;
  const children: Line[] = [];
  let lastIndex = parentIndex;
  for (let i = parentIndex + 1; i < lines.length; i++) {
    if (lines[i].indent <= parentIndent) break;
    children.push(lines[i]);
    lastIndex = i;
  }
  return { children, lastIndex };
}

function assignHarness(config: HarnessConfig, key: string, value: string, lineNo: number, issues: string[]): void {
  const asInt = (): number | null => {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      issues.push(`line ${lineNo}: harness.${key} must be a whole number (got ${JSON.stringify(value)})`);
      return null;
    }
    return n;
  };
  const asBool = (): boolean | null => {
    if (value === "true") return true;
    if (value === "false") return false;
    issues.push(`line ${lineNo}: harness.${key} must be true or false (got ${JSON.stringify(value)})`);
    return null;
  };

  switch (key) {
    case "version": {
      const n = asInt();
      if (n !== null) config.version = n;
      return;
    }
    case "requirements_file":
      if (value === "") issues.push(`line ${lineNo}: harness.requirements_file is empty`);
      else config.requirementsFile = value;
      return;
    case "max_retries": {
      const n = asInt();
      if (n === null) return;
      if (n < 0) issues.push(`line ${lineNo}: harness.max_retries cannot be negative`);
      else config.maxRetries = n;
      return;
    }
    case "agent_timeout_ms": {
      const n = asInt();
      if (n === null) return;
      if (n <= 0) issues.push(`line ${lineNo}: harness.agent_timeout_ms must be greater than zero`);
      else config.agentTimeoutMs = n;
      return;
    }
    case "auto_start": {
      const b = asBool();
      if (b !== null) config.autoStart = b;
      return;
    }
    case "subagent_context_file":
      if (value === "") issues.push(`line ${lineNo}: harness.subagent_context_file is empty`);
      else config.subagentContextFile = value;
      return;
  }
}

/** Resolve the config the runtime should use, filling documented defaults. */
export function withDefaults(config: HarnessConfig): HarnessConfig {
  return {
    ...config,
    requirementsFile: config.requirementsFile ?? DEFAULTS.requirementsFile,
    maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
    agentTimeoutMs: config.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
    autoStart: config.autoStart ?? DEFAULTS.autoStart,
    subagentContextFile: config.subagentContextFile ?? DEFAULTS.subagentContextFile,
  };
}
