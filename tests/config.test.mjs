/**
 * Tests for the v2 configuration: parser, validation, requirements file and
 * changelog gate.
 *
 * Run with:  node tests/config.test.mjs
 *
 * Pure except for reading the shipped template and two temp files. The final
 * check parses `harness.config.example.yaml` from disk, which is what keeps
 * the parser and the template from drifting apart.
 *
 * Platform: Windows, macOS and Linux; temp paths come from `os.tmpdir()`.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
const lib = (name) => pathToFileURL(path.join(ROOT, ".pi", "extensions", "lib", name)).href;

if (!process.features?.typescript && !process.env.PI_HARNESS_TS_RESPAWN) {
  const respawn = spawnSync(process.execPath, ["--experimental-strip-types", SELF], {
    stdio: "inherit",
    env: { ...process.env, PI_HARNESS_TS_RESPAWN: "1" },
  });
  if (respawn.error) {
    console.error(`FAIL cannot re-run with --experimental-strip-types — ${respawn.error.message}`);
    process.exit(1);
  }
  process.exit(respawn.status ?? 1);
}

const config = await import(lib("config.ts"));
const validate = await import(lib("validate.ts"));
const reqs = await import(lib("requirements.ts"));
const changelog = await import(lib("changelog.ts"));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const errorsOf = (checks) => checks.filter((c) => !c.ok && c.severity === "error");
const warnOf = (checks) => checks.filter((c) => !c.ok && c.severity === "warning");
const has = (checks, needle) => checks.some((c) => !c.ok && c.detail?.includes(needle));

// The two write-capable roles are the planner (it owns the requirements file)
// and the implementer (it owns the code). Every fixture has to honour that.
const WRITE_CAPABLE = ["planner", "implementer"];
const DEFAULT_CAPS = (name) => (WRITE_CAPABLE.includes(name) ? "[read, write]" : "[read]");

const AGENT_BLOCK = (name, caps = DEFAULT_CAPS(name)) =>
  `  ${name}:\n    model: p/m\n    reasoning: medium\n    capabilities: ${caps}`;

const AGENTS = config.AGENT_NAMES.map((name) => AGENT_BLOCK(name)).join("\n");

const MINIMAL = `harness:\n  version: 2\nagents:\n${AGENTS}\n`;

/** The minimal config with exactly one agent's capabilities replaced. */
const withCaps = (name, caps) =>
  config.parseConfig(MINIMAL.replace(AGENT_BLOCK(name), AGENT_BLOCK(name, `[${caps}]`)));

/** Replace one agent's capabilities while keeping what that role requires. */
const withAgentCaps = (name, caps) => {
  const keepWrite = DEFAULT_CAPS(name).includes("write");
  return withCaps(name, keepWrite ? `read, write, ${caps}` : caps);
};
const FULL = `harness:
  version: 2
  requirements_file: .harness/requirements.md
  max_retries: 5
  agent_timeout_ms: 900000
  auto_start: false
  subagent_context_file: contracts/harness.md
agents:
  planner:
    model: p/m1
    reasoning: high
    capabilities: [read, write, memory, graph]
  explorer:
    model: p/m2
    reasoning: medium
    capabilities: [read, memory, graph]
  implementer:
    model: p/m3
    reasoning: high
    capabilities: [read, write, shell, vcs, github, memory]
  reviewer:
    model: p/m4
    reasoning: high
    capabilities: [read, graph]
  tester:
    model: p/m5
    reasoning: high
    capabilities: [read, shell]
  deliverer:
    model: p/m6
    reasoning: low
    capabilities: [read, shell, vcs, github]
`;

// --- 1. parsing ------------------------------------------------------------

{
  const full = config.parseConfig(FULL);
  check("1. a full config parses without issues", full.issues.length === 0, full.issues.join("; "));
  check("1. it is recognised as v2", full.isV2);
  check("1. every harness value is read",
    full.config.requirementsFile === ".harness/requirements.md" && full.config.maxRetries === 5 &&
    full.config.agentTimeoutMs === 900000 && full.config.autoStart === false &&
    full.config.subagentContextFile === "contracts/harness.md",
    JSON.stringify(full.config));
  check("1. all six agents are read", config.AGENT_NAMES.every((n) => Boolean(full.config.agents[n])));
  check("1. agent fields are read",
    full.config.agents.implementer.model === "p/m3" && full.config.agents.implementer.reasoning === "high" &&
    full.config.agents.implementer.capabilities.join(",") === "read,write,shell,vcs,github,memory",
    JSON.stringify(full.config.agents.implementer));

  const min = config.parseConfig(MINIMAL);
  check("1. a minimal config parses and is v2", min.isV2 && min.issues.length === 0, min.issues.join("; "));
  const filled = config.withDefaults(min.config);
  check("1. defaults fill the omitted values",
    filled.maxRetries === config.DEFAULTS.maxRetries && filled.agentTimeoutMs === config.DEFAULTS.agentTimeoutMs &&
    filled.requirementsFile === config.DEFAULTS.requirementsFile && filled.autoStart === true,
    JSON.stringify(filled));

  const bad = config.parseConfig(`harness:\n  version: 2\n  max_retries: three\n  auto_start: maybe\nagents:\n${AGENTS}\n`);
  check("1. a non-numeric max_retries is reported with its line",
    bad.issues.some((i) => i.includes("max_retries must be a whole number") && i.includes("line 3")), bad.issues.join("; "));
  check("1. a non-boolean auto_start is reported", bad.issues.some((i) => i.includes("auto_start must be true or false")));
  check("1. a negative max_retries is refused", config.parseConfig(MINIMAL.replace("  version: 2", "  version: 2\n  max_retries: -1")).issues.some((i) => i.includes("cannot be negative")));
  check("1. comments and blank lines are ignored", config.parseConfig("# a\n\n" + MINIMAL).isV2);

  const noSections = config.parseConfig("");
  check("1. an empty file reports both missing sections",
    noSections.issues.includes("no `harness:` section") && noSections.issues.includes("no `agents:` section"), noSections.issues.join("; "));
}

// --- 2. version detection --------------------------------------------------

{
  check("2. a config without harness.version is not v2", config.parseConfig(`harness:\n  max_retries: 2\nagents:\n${AGENTS}\n`).isV2 === false);
  check("2. a config with version 1 is not v2", config.parseConfig(MINIMAL.replace("version: 2", "version: 1")).isV2 === false);
  check("2. a config without agents is not v2", config.parseConfig("harness:\n  version: 2\n").isV2 === false);
  check("2. a version mismatch is a fatal check", errorsOf(validate.validateConfig(config.parseConfig(MINIMAL.replace("version: 2", "version: 1")))).length > 0);
}

// --- 3. fail-closed on unknown keys ----------------------------------------

{
  const checks = validate.validateConfig(config.parseConfig(MINIMAL));
  check("3. a clean config has no errors", errorsOf(checks).length === 0, errorsOf(checks).map((c) => c.label).join("; "));

  const topLevel = validate.validateConfig(config.parseConfig(MINIMAL + "\nworkflows:\n  simple:\n    steps:\n      - planner\n"));
  check("3. an unknown top-level key is an error", has(topLevel, "workflows"), errorsOf(topLevel).map((c) => c.detail).join("; "));
  check("3. an unknown top-level key is not a warning", warnOf(topLevel).length === 0);

  const inHarness = validate.validateConfig(config.parseConfig(MINIMAL.replace("  version: 2", "  version: 2\n  mystery: 1")));
  check("3. an unknown key under harness: is an error", has(inHarness, "harness.mystery"), errorsOf(inHarness).map((c) => c.detail).join("; "));

  const inAgent = validate.validateConfig(config.parseConfig(MINIMAL.replace(AGENT_BLOCK("planner"), AGENT_BLOCK("planner").replace("    model: p/m", "    model: p/m\n    extra_field: 1"))));
  check("3. an unknown key inside an agent is an error", errorsOf(inAgent).some((c) => c.detail?.includes("extra_field")), errorsOf(inAgent).map((c) => c.detail).join("; "));

  const typo = validate.validateConfig(config.parseConfig(FULL.replace("max_retries", "max_retry")));
  check("3. a typo is an error, not a warning", has(typo, "harness.max_retry"));
}

// --- 4. v1 keys produce a migration hint -----------------------------------

{
  for (const [snippet, label] of [
    [`harness:\n  version: 2\ndefaults:\n  auto_harness: true\nagents:\n${AGENTS}\n`, "defaults"],
    [MINIMAL + "\ncommands:\n  preferred_interface: slash\n", "commands"],
    [MINIMAL.replace(AGENT_BLOCK("planner"), AGENT_BLOCK("planner").replace("    model: p/m", `    model: p/m\n    mutates_files: false`)), "agents.planner.mutates_files"],
    [MINIMAL.replace(AGENT_BLOCK("planner"), AGENT_BLOCK("planner").replace("    model: p/m", `    model: p/m\n    tools: [read]`)), "agents.planner.tools"],
    [MINIMAL.replace(AGENT_BLOCK("planner"), AGENT_BLOCK("planner").replace("    model: p/m", `    model: p/m\n    responsibilities: [plan]`)), "agents.planner.responsibilities"],
    [MINIMAL.replace(AGENT_BLOCK("planner"), AGENT_BLOCK("planner").replace("    model: p/m", `    model: p/m\n    prompt_template: prompts/x.md`)), "agents.planner.prompt_template"],
  ]) {
    const checks = validate.validateConfig(config.parseConfig(snippet));
    const migration = errorsOf(checks).find((c) => c.detail?.includes("npx pi-minimal-harness update"));
    check(`4. a v1 "${label}" key names the migration`, Boolean(migration), migration?.detail ?? errorsOf(checks).map((c) => c.detail).join("; "));
    if (migration) check(`4. the "${label}" hint names the key`, migration.detail.includes(label));
  }
}

// --- 5. agent completeness -------------------------------------------------

{
  const missingOne = config.parseConfig(MINIMAL.replace("  tester:\n    model: p/m\n    reasoning: medium\n    capabilities: [read]\n", ""));
  check("5. a missing agent is an error", errorsOf(validate.validateConfig(missingOne)).some((c) => c.label.includes('"tester" is defined')));
  const extra = config.parseConfig(MINIMAL + "  critic:\n    model: p/m\n    reasoning: high\n    capabilities: [read]\n");
  check("5. an agent outside the six is an error", errorsOf(validate.validateConfig(extra)).some((c) => c.label.includes('"critic" is part of the workflow')));
  const noModel = config.parseConfig(MINIMAL.replace("    model: p/m\n    reasoning: medium\n    capabilities: [read]\n", "    reasoning: medium\n    capabilities: [read]\n"));
  check("5. a missing model is an error", errorsOf(validate.validateConfig(noModel)).some((c) => c.label.includes("has a model")));
  const badLevel = config.parseConfig(MINIMAL.replace("reasoning: medium", "reasoning: extreme"));
  check("5. an unknown reasoning level is an error", errorsOf(validate.validateConfig(badLevel)).some((c) => c.label.includes("valid reasoning level")));
  const emptyCaps = config.parseConfig(MINIMAL.replace("capabilities: [read]", "capabilities: []"));
  check("5. empty capabilities are an error", errorsOf(validate.validateConfig(emptyCaps)).some((c) => c.label.includes("declares capabilities")));
}

// --- 6. capability invariants ----------------------------------------------

{
  const errorsFor = (name, caps) => errorsOf(validate.validateConfig(withCaps(name, caps)))
    .filter((c) => c.detail?.includes('"') === false || c.detail.includes(name))
    .map((c) => c.detail ?? "");
  const plannerErrors = (caps) =>
    errorsOf(validate.validateConfig(withCaps("planner", caps))).map((c) => c.detail ?? "");

  check("6. vcs without shell is an error", plannerErrors("read, vcs").some((d) => d.includes('requires "shell"')), plannerErrors("read, vcs").join("; "));
  check("6. github without shell is an error", plannerErrors("read, github").some((d) => d.includes('requires "shell"')));
  check("6. a missing read is an error", plannerErrors("shell").some((d) => d.includes('needs "read"')), plannerErrors("shell").join("; "));
  check("6. an unknown capability is an error", plannerErrors("read, telepathy").some((d) => d.includes("telepathy")), plannerErrors("read, telepathy").join("; "));
  check("6. a consistent set passes", errorsOf(validate.validateConfig(withAgentCaps("planner", "shell, vcs, github"))).length === 0);
  check("6. the check reports the resolved tools",
    validate.validateConfig(withCaps("reviewer", "read, shell")).some((c) => c.detail === "tools: read,find,grep,ls,bash,powershell"));
  check("6. only the targeted agent changed", errorsFor.length >= 0 && withCaps("planner", "read").config.agents.explorer.capabilities.join(",") === "read");
}

// --- 7. environment is a warning, not an error -----------------------------

{
  // FULL, not MINIMAL: only FULL grants memory and graph, which are the
  // declarative capabilities under test.
  const toolSet = (tools) => validate.validateConfig(config.parseConfig(FULL), { availableTools: tools });
  check("7. no registry means no environment checks", toolSet(undefined).filter((c) => c.label.includes("can use")).length === 0);
  check("7. environment checks exist when a registry is supplied", toolSet(["read"]).filter((c) => c.label.includes("can use")).length > 0);
  check("7. a present MCP tool produces no warning",
    warnOf(toolSet(["read", "grep", "mem_save", "codegraph_explore"])).filter((c) => c.label.includes("can use")).length === 0);
  const absent = toolSet(["read", "grep"]);
  check("7. an absent memory tool is a warning", warnOf(absent).some((c) => c.label.includes("can use memory") && c.detail.includes("lessons")), warnOf(absent).map((c) => c.detail).join("; "));
  check("7. an absent graph tool is a warning", warnOf(absent).some((c) => c.label.includes("can use graph") && c.detail.includes("grep/rg")));
  check("7. missing MCP tools never make the config invalid", errorsOf(absent).length === 0);

  // A configured model you cannot call fails minutes into a workflow.
  const withModels = (list) => validate.validateConfig(config.parseConfig(MINIMAL), { usableModels: list });
  check("7. a model outside the usable set is a warning",
    withModels(["p/other"]).some((c) => !c.ok && c.severity === "warning" && c.detail.includes("usable set")),
    withModels(["p/other"]).filter((c) => !c.ok).map((c) => c.detail).join("; "));
  check("7. and never an error", errorsOf(withModels(["p/other"])).length === 0);
  check("7. a configured model in the usable set warns about nothing",
    withModels(["p/m"]).filter((c) => !c.ok).length === 0);
  check("7. with no registry the check stays silent",
    validate.validateConfig(config.parseConfig(MINIMAL)).filter((c) => c.label.includes("usable model")).length === 0);

  // The write rule: exactly the planner and the implementer.
  const writeChecks = (cfg) => validate.validateConfig(cfg).filter((c) => c.label.includes("the right to write"));
  const takeWrite = (name) => config.parseConfig(MINIMAL.replace(AGENT_BLOCK(name), AGENT_BLOCK(name, "[read, write]")));
  const dropWrite = (name) => config.parseConfig(MINIMAL.replace(AGENT_BLOCK(name), AGENT_BLOCK(name, "[read]")));
  check("7. the planner is required to hold write",
    writeChecks(dropWrite("planner")).some((c) => !c.ok && c.detail.includes("owns a file")), writeChecks(dropWrite("planner")).map((c) => c.detail).join("; "));
  check("7. a read-only role holding write is an error",
    writeChecks(takeWrite("reviewer")).some((c) => !c.ok && c.detail.includes("reserved to")), writeChecks(takeWrite("reviewer")).map((c) => c.detail).join("; "));
  check("7. the minimal config holds exactly those two", writeChecks(config.parseConfig(MINIMAL)).filter((c) => !c.ok).length === 0);
}

// --- 8. requirements -------------------------------------------------------

const REQ_MD = `# Requirements

## REQ-001 — add the thing
- **Status:** delivered
- **Acceptance:** npm test passes
- **Changes:** src/a.ts, src/b.ts
- **Validated by:** npm test

## REQ-002 — document it
- **Status:** approved
- **Acceptance:** README mentions it
`;

{
  const parsed = reqs.parseRequirements(REQ_MD);
  check("8. two requirements are read", parsed.requirements.length === 2, String(parsed.requirements.length));
  check("8. fields are read",
    parsed.requirements[0].status === "delivered" && parsed.requirements[0].acceptance === "npm test passes" &&
    parsed.requirements[0].changes.join(",") === "src/a.ts,src/b.ts" && parsed.requirements[0].validatedBy.join(",") === "npm test");
  check("8. the title is read", parsed.requirements[1].title === "document it", parsed.requirements[1].title);
  check("8. a well-formed file has no issues", parsed.issues.length === 0, parsed.issues.join("; "));

  const noAcceptance = reqs.parseRequirements("## REQ-001 — x\n- **Status:** approved\n");
  check("8. a missing Acceptance is an issue", noAcceptance.issues.some((i) => i.includes("REQ-001 has no Acceptance")));
  const noStatus = reqs.parseRequirements("## REQ-001 — x\n- **Acceptance:** y\n");
  check("8. a missing Status is an issue", noStatus.issues.some((i) => i.includes("REQ-001 has no Status")));
  const dup = reqs.parseRequirements("## REQ-001 — a\n- **Status:** approved\n- **Acceptance:** x\n\n## REQ-001 — b\n- **Status:** approved\n- **Acceptance:** y\n");
  check("8. a duplicated id is an issue", dup.issues.some((i) => i.includes("more than once")), dup.issues.join("; "));
  const backwards = reqs.parseRequirements("## REQ-002 — a\n- **Status:** approved\n- **Acceptance:** x\n\n## REQ-001 — b\n- **Status:** approved\n- **Acceptance:** y\n");
  check("8. a rewound id order is an issue", backwards.issues.some((i) => i.includes("ascending id order")), backwards.issues.join("; "));
  const deliveredNoChanges = reqs.parseRequirements("## REQ-001 — a\n- **Status:** delivered\n- **Acceptance:** x\n- **Validated by:** t\n");
  check("8. delivered without Changes is an issue", deliveredNoChanges.issues.some((i) => i.includes("lists no Changes")), deliveredNoChanges.issues.join("; "));
  const validatedNoEvidence = reqs.parseRequirements("## REQ-001 — a\n- **Status:** validated\n- **Acceptance:** x\n");
  check("8. validated without evidence is an issue", validatedNoEvidence.issues.some((i) => i.includes("Validated by")), validatedNoEvidence.issues.join("; "));
  const badStatus = reqs.parseRequirements("## REQ-001 — a\n- **Status:** finished\n- **Acceptance:** x\n");
  check("8. an unknown status is an issue", badStatus.issues.some((i) => i.includes("unknown status")));
  check("8. an empty file is an issue", reqs.parseRequirements("").issues.some((i) => i.includes("no REQ-NNN")));

  check("8. atLeast filters by status depth", reqs.atLeast(parsed.requirements, "validated").length === 1);
  check("8. citedIds finds and dedupes", reqs.citedIds("REQ-001 and REQ-001 and REQ-002").join(",") === "REQ-001,REQ-002");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-req-"));
  const missing = await reqs.readRequirementsFile(path.join(tmp, "nope.md"));
  check("8. a missing file is an issue, not a throw", missing.exists === false && missing.issues.length === 1, missing.issues.join("; "));
  const realPath = path.join(tmp, "requirements.md");
  await fs.writeFile(realPath, REQ_MD, "utf8");
  check("8. a real file is read and parsed", (await reqs.readRequirementsFile(realPath)).requirements.length === 2);
  await fs.rm(tmp, { recursive: true, force: true });
}

// --- 9. changelog gate -----------------------------------------------------

{
  const CL = `# Changelog

## [Unreleased]

### Added
- REQ-001: the thing, citing src/a.ts

## [0.1.0]

- REQ-999: an old release
`;
  const delivered = reqs.parseRequirements(REQ_MD).requirements;
  const good = changelog.validateChangelog(CL, delivered);
  check("9. a fully cited changelog passes", errorsOf(good).length === 0, errorsOf(good).map((c) => c.detail).join("; "));
  check("9. only the [Unreleased] section counts", changelog.unreleasedSection(CL).includes("REQ-001") && !changelog.unreleasedSection(CL).includes("REQ-999"));
  check("9. the released section is not scanned", !reqs.citedIds(changelog.unreleasedSection(CL)).includes("REQ-999"));

  const missingCite = changelog.validateChangelog("# Changelog\n\n## [Unreleased]\n\n- something changed\n", delivered);
  check("9. an uncited delivered requirement is an error", errorsOf(missingCite).some((c) => c.detail?.includes("REQ-001")), errorsOf(missingCite).map((c) => c.detail).join("; "));
  check("9. the error names every missing id",
    errorsOf(changelog.validateChangelog("# Changelog\n\n## [Unreleased]\n\n- x\n", [...delivered, { id: "REQ-005", title: "t", status: "delivered" }])).some((c) => c.detail?.includes("REQ-001, REQ-005")));

  check("9. a missing changelog is an error", errorsOf(changelog.validateChangelog("", delivered)).length > 0);
  check("9. a missing [Unreleased] section is an error", errorsOf(changelog.validateChangelog("# Changelog\n\n## [0.1.0]\n- x\n", delivered)).some((c) => c.label.includes("[Unreleased]")));
  check("9. nothing delivered means no entry is owed",
    errorsOf(changelog.validateChangelog("# Changelog\n", reqs.parseRequirements("## REQ-001 — a\n- **Status:** approved\n- **Acceptance:** x\n").requirements)).length === 0);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-cl-"));
  check("9. an unreadable changelog path is an error", (await changelog.readAndValidateChangelog(path.join(tmp, "nope.md"), delivered)).length > 0);
  const real = path.join(tmp, "CHANGELOG.md");
  await fs.writeFile(real, CL, "utf8");
  check("9. a real changelog file validates", errorsOf(await changelog.readAndValidateChangelog(real, delivered)).length === 0);
  await fs.rm(tmp, { recursive: true, force: true });
}

// --- 10. the shipped template ---------------------------------------------

{
  const template = await fs.readFile(path.join(ROOT, "harness.config.example.yaml"), "utf8");
  const parsed = config.parseConfig(template);
  check("10. the shipped template parses", parsed.issues.length === 0 && parsed.isV2, parsed.issues.join("; "));
  const checks = validate.validateConfig(parsed);
  // The template is SUPPOSED to carry placeholder models, so the six
  // placeholder findings are the expected truth, not a defect. Anything else
  // fatal would be.
  const fatal = errorsOf(checks);
  const onlyPlaceholders = fatal.length > 0 && fatal.every((c) => c.detail?.includes("template placeholder"));
  check("10. the template's only fatal findings are its own model placeholders",
    onlyPlaceholders, fatal.map((c) => `${c.label} [${c.detail}]`).join("; "));
  check("10. and there are exactly six of them", fatal.length === 6, String(fatal.length));
  const live = validate.validateConfig(config.parseConfig(await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8")));
  check("10. this project's own config has no placeholder", errorsOf(live).length === 0,
    errorsOf(live).map((c) => `${c.label} [${c.detail}]`).join("; "));
  check("10. the template has no unknown keys", parsed.unknownKeys.length === 0, parsed.unknownKeys.map((u) => u.path).join(", "));
  check("10. the template declares all six agents", config.AGENT_NAMES.every((n) => Boolean(parsed.config.agents[n])));
  check("10. only the planner and the implementer may write",
    config.AGENT_NAMES.filter((n) => parsed.config.agents[n].capabilities.includes("write")).sort().join(",") === "implementer,planner",
    config.AGENT_NAMES.filter((n) => parsed.config.agents[n].capabilities.includes("write")).join(","));
  check("10. the planner can write the file it owns",
    parsed.config.agents.planner.capabilities.includes("write"));
  check("10. the four read-only roles cannot",
    ["explorer", "reviewer", "tester", "deliverer"].every((n) => !parsed.config.agents[n].capabilities.includes("write")));
  check("10. the reviewer has no shell", !parsed.config.agents.reviewer.capabilities.includes("shell"));
  check("10. the template keeps a readable capability reference",
    template.includes("enforced with --tools") && template.includes("REQUIRES `shell`"));
}

await fs.rm(os.tmpdir(), { recursive: false, force: true }).catch(() => {});
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
