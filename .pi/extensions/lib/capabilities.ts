/**
 * Capabilities -> Pi tool names.
 *
 * Only three capabilities are enforceable, and that is a property of Pi, not of
 * this harness: Pi's tool vocabulary is `{read, bash, edit, write, find, grep,
 * ls, powershell}`, so anything else is either an MCP server whose name depends
 * on the user's own configuration, or a shell command. Those are declared in
 * the brief and verified against `pi.getAllTools()` at runtime, not imposed
 * with `--tools`.
 *
 * What enforcement still buys: an agent without `shell` cannot run a single
 * command, because bash is gone from its tool set.
 */

/** Capabilities whose presence maps to concrete Pi tool names. */
export const ENFORCEABLE = ["read", "write", "shell"] as const;

/** Capabilities that are declared to the agent but cannot be imposed. */
export const DECLARATIVE = ["memory", "graph", "vcs", "github"] as const;

export type EnforceableCapability = (typeof ENFORCEABLE)[number];
export type DeclarativeCapability = (typeof DECLARATIVE)[number];
export type Capability = EnforceableCapability | DeclarativeCapability;

export const ALL_CAPABILITIES: readonly Capability[] = [...ENFORCEABLE, ...DECLARATIVE] as const;

/** Declarative capabilities that are meaningless without a shell to run them. */
const NEEDS_SHELL: readonly DeclarativeCapability[] = ["vcs", "github"];

const TOOL_NAMES: Record<EnforceableCapability, readonly string[]> = {
  read: ["read", "find", "grep", "ls"],
  write: ["edit", "write"],
  // Both shells Pi registers. `--tools` ignores names that are not registered,
  // so listing both is safe on a machine that has only one — and without
  // `powershell` here, a Windows agent could not run codegraph, which ships as
  // a .cmd.
  shell: ["bash", "powershell"],
};

export interface CapabilityMapping {
  /** Concrete Pi tool names for `--tools`; empty when nothing is enforceable. */
  tools: string[];
  /** Capabilities handed to the agent in prose instead. */
  declarative: string[];
  /** Everything wrong with the requested set; the caller decides, this never throws. */
  errors: string[];
}

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function isEnforceable(value: string): boolean {
  return (ENFORCEABLE as readonly string[]).includes(value);
}

/**
 * Resolve a capability list to tool names.
 *
 * Order is canonical rather than input order, so two agents with the same
 * capabilities always produce byte-identical `--tools`, which is what lets the
 * tests assert on the argv.
 */
export function capabilitiesToTools(capabilities: readonly string[]): CapabilityMapping {
  const errors: string[] = [];
  const requested = new Set<string>();
  for (const raw of capabilities ?? []) {
    const name = String(raw).trim();
    if (name === "") continue;
    if (!isCapability(name)) {
      errors.push(`unknown capability "${name}" (known: ${ALL_CAPABILITIES.join(", ")})`);
      continue;
    }
    requested.add(name);
  }

  // No reading means no exploration, so this is an error rather than a warning.
  if (!requested.has("read")) {
    errors.push(`every agent needs "read" (known: ${ALL_CAPABILITIES.join(", ")})`);
  }
  if (!requested.has("shell")) {
    for (const name of NEEDS_SHELL) {
      if (requested.has(name)) errors.push(`capability "${name}" requires "shell"`);
    }
  }

  const tools: string[] = [];
  for (const name of ENFORCEABLE) {
    if (!requested.has(name)) continue;
    for (const tool of TOOL_NAMES[name]) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }

  const declarative = DECLARATIVE.filter((name) => requested.has(name));
  return { tools, declarative, errors };
}

/** Capability names whose tools the runtime should look up in `pi.getAllTools()`. */
export function verifiableCapabilities(capabilities: readonly string[]): string[] {
  return capabilitiesToTools(capabilities).declarative.filter((name) => name === "memory" || name === "graph");
}
