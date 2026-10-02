/**
 * Tests for the agent prompts and the contract.
 *
 * Run with:  node tests/prompts.test.mjs
 *
 * This is the only test that can police the layering the whole rewrite rests on:
 * a prompt that restates control flow puts two sources of truth back in the
 * project. The forbidden-token list below is therefore the enforcement, and it
 * is deliberately broad.
 *
 * Platform: Windows, macOS and Linux; reads only repository files.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

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

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const AGENTS = ["planner", "explorer", "implementer", "reviewer", "tester", "deliverer"];
const V1_AGENTS = ["critic", "delivery"];
/**
 * `orchestrator` is NOT a v2 role and its scaffold is gone. v2 has no LLM
 * orchestrator: the runtime is the state machine. The file existed only so the
 * live v1 session could keep running while the rewrite was in flight, and Phase
 * 5 removed it together with the v1 extension.
 *
 * Kept as an empty list so the check below still says "the six, and nothing
 * else" — if a future file turns up in prompts/ it will fail here rather than
 * ship.
 */
const TEMPORARY_SCAFFOLD = [];

const promptText = {};
for (const agent of AGENTS) {
  promptText[agent] = await fs.readFile(path.join(ROOT, "prompts", `${agent}.md`), "utf8");
}
const contract = await fs.readFile(path.join(ROOT, "pi-minimal-harness.md"), "utf8");
const contractBody = contract.slice(contract.search(/^## /m));

/**
 * Tokens that must never appear in prose written for a model.
 *
 * Three categories, and each one names where the truth actually lives:
 *  - result-envelope field names        -> rendered from lib/result.ts at runtime
 *  - control flow and config identifiers -> lib/transitions.ts and the config
 *  - v1 leftovers                        -> removed in the v2 rewrite
 */
const FORBIDDEN = [
  ["changed_files", "envelope field"],
  ["untraceable", "envelope field"],
  ["status:", "envelope field"],
  ["verdict:", "envelope field"],
  ["checks:", "envelope field"],
  ["question:", "envelope field"],
  ["PLANNING", "transition state"],
  ["EXPLORING", "transition state"],
  ["IMPLEMENTING", "transition state"],
  ["REVIEWING", "transition state"],
  ["TESTING", "transition state"],
  ["DELIVERING", "transition state"],
  ["SUSPENDED", "transition state"],
  ["max_retries", "config key"],
  ["mutates_files", "v1 config key"],
  ["workflow_mode", "v1 config key"],
  ["capabilities:", "config key"],
  ["ANSWER_ONLY", "v1 marker"],
  ["PIPELINE", "v1 marker"],
  ["HARNESS-DONE", "v1 marker"],
  ["HARNESS-DECISION", "v1 marker"],
  ["{{task}}", "v1 placeholder"],
  ["{{mode}}", "v1 placeholder"],
  ["{{step}}", "v1 placeholder"],
  ["{{steps}}", "v1 placeholder"],
];

/**
 * The corrected language model: the envelope is English because the next agent
 * reads it. Anything telling an agent to write the envelope in the user's
 * language reintroduces the bug these checks exist to prevent.
 */
const FORBIDDEN_LANGUAGE = [
  "in the language the user used",
  "user-facing prose",
  "prose in the language",
  "the language of the user's request for prose",
  "same language as the user's request",
  "in the same language as the user",
];

// --- 1. the six roles exist, the v1 ones are gone --------------------------

{
  check("1. all six agent prompts exist", AGENTS.every((a) => Object.keys(promptText).includes(a) && promptText[a].length > 500));
  for (const old of V1_AGENTS) {
    const gone = await fs.access(path.join(ROOT, "prompts", `${old}.md`)).then(() => false, () => true);
    check(`1. the v1 prompt "${old}.md" is gone`, gone);
  }
  const onDisk = (await fs.readdir(path.join(ROOT, "prompts"))).sort();
  const expected = [...AGENTS, ...TEMPORARY_SCAFFOLD].map((a) => `${a}.md`).sort();
  check("1. prompts/ holds the six roles and nothing else", onDisk.join(",") === expected.join(","), onDisk.join(","));
  const scaffoldGone = await fs.access(path.join(ROOT, "prompts", "orchestrator.md")).then(() => false, () => true);
  check("1. the v1 orchestrator scaffold is gone", scaffoldGone);
}

// --- 2. no prompt restates runtime, config or the envelope ----------------

{
  for (const agent of AGENTS) {
    const leaked = FORBIDDEN.filter(([token]) => promptText[agent].includes(token)).map(([token, why]) => `${token} (${why})`);
    check(`2. ${agent}.md restates nothing from the runtime or the config`, leaked.length === 0, leaked.join(", "));
  }
  const contractLeaked = FORBIDDEN.filter(([token]) => contractBody.includes(token)).map(([token, why]) => `${token} (${why})`);
  check("2. the contract restates nothing from the runtime or the config", contractLeaked.length === 0, contractLeaked.join(", "));
}

// --- 3. each prompt states its role and its boundary ----------------------

{
  for (const agent of AGENTS) {
    const text = promptText[agent];
    check(`3. ${agent}.md names its role in the title`, new RegExp(`^# ${agent[0].toUpperCase()}${agent.slice(1)} `, "im").test(text), text.split("\n")[0]);
    check(`3. ${agent}.md says what it must not do`, /must not do/i.test(text));
    check(`3. ${agent}.md says what goes in the reply`, /goes in your reply/i.test(text));
    check(`3. ${agent}.md says what to do when blocked`, /cannot continue/i.test(text));
    check(`3. ${agent}.md points at the injected result contract`, /injected result contract/i.test(text));
  }
}

// --- 3b. a prompt may not ask for a capability the agent lacks -------------

{
  const { parseConfig } = await import(pathToFileURL(path.join(ROOT, ".pi", "extensions", "lib", "config.ts")).href);
  const { ALL_CAPABILITIES } = await import(pathToFileURL(path.join(ROOT, ".pi", "extensions", "lib", "capabilities.ts")).href);
  const config = parseConfig(await fs.readFile(path.join(ROOT, "harness.config.yaml"), "utf8")).config;
  const REMINDERS = [
    ["memory", /memory tools?|mem_save/i, "record what is worth reusing with your memory tools"],
    ["graph", /structural exploration|CodeGraph/i, "use structural exploration when the project has it"],
  ];
  for (const agent of AGENTS) {
    const held = new Set(config.agents[agent].capabilities);
    const asked = REMINDERS.filter(([, re]) => re.test(promptText[agent])).map(([cap]) => cap);
    const missing = asked.filter((c) => !held.has(c));
    // A prompt may mention something as an OPTION the agent might not have; it
    // may not instruct it to use what it was not given.
    const instructed = REMINDERS
      .filter(([, re]) => re.test(promptText[agent]))
      .filter(([cap]) => !held.has(cap))
      .map(([cap]) => cap);
    check(`3b. ${agent}.md asks only for capabilities it holds`, instructed.length === 0,
      `${agent} is told to use ${instructed.join(", ")} but holds ${[...held].join(",")}`);
    check(`3b. ${agent}.md's capabilities are all known`, config.agents[agent].capabilities.every((c) => ALL_CAPABILITIES.includes(c)),
      config.agents[agent].capabilities.join(","));
  }
}

// --- 4. role boundaries are explicit --------------------------------------

{
  check("4. the planner is told not to write code", /do not write code|does not write code|not touch the repository's source/i.test(promptText.planner));
  check("4. the explorer is told not to modify anything", /does not modify anything|do not edit any file/i.test(promptText.explorer));
  check("4. the implementer is the only one that changes files", /only agent that changes files/i.test(promptText.implementer));
  check("4. the implementer must not guess an ambiguous requirement", /do not decide an ambiguous requirement on your own/i.test(promptText.implementer));
  check("4. the implementer must not claim an unrun check", /claim a check passed that you did not run/i.test(promptText.implementer));
  check("4. the reviewer is told not to fix anything", /does not fix anything|do not fix anything|do not edit the implementation/i.test(promptText.reviewer));
  check("4. the tester never contacts the implementer directly", /never contacts the implementer directly/i.test(promptText.tester));
  check("4. the tester must not modify to make a check pass", /do not modify source, tests or configuration/i.test(promptText.tester));
  check("4. the deliverer may refuse", /may refuse/i.test(promptText.deliverer));
  check("4. the deliverer must not merge", /do not merge/i.test(promptText.deliverer));
}

// --- 5. the implementer derives the default branch ------------------------

{
  const t = promptText.implementer;
  check("5. the implementer is told not to assume the default branch is main", /do not assume it is called `?main`?/i.test(t));
  check("5. the implementer must derive it from the repository", /derive it from the repository/i.test(t));
  check("5. the implementer handles the issue and the branch", /create the issue/i.test(t) && /working branch/i.test(t));
  check("5. the implementer is the only one writing the changelog", /only agent that writes it/i.test(t));
}

// --- 6. the contract covers the norm --------------------------------------

{
  const sections = [...contractBody.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  check("6. the contract has a preamble and a body", contractBody.length > 2000, String(contractBody.length));
  check("6. the contract keeps its preamble commented", contract.slice(0, contract.search(/^## /m)).trim().startsWith("<!--"));
  check("6. the contract preamble closes before the body", !contract.slice(0, contract.search(/^## /m)).includes("\n## "));
  for (const topic of ["agent", "requirement", "changelog", "ask", "repl", "skill"]) {
    check(`6. the contract covers "${topic}"`, sections.some((s) => s.toLowerCase().includes(topic)), sections.join(" | "));
  }
  for (const agent of AGENTS) {
    check(`6. the contract names the ${agent}`, new RegExp(`\\*\\*${agent[0].toUpperCase()}${agent.slice(1)}\\*\\*`, "i").test(contractBody));
  }
  check("6. the contract says the orchestrator is runtime, not an agent", /state machine in the harness runtime, not an agent/i.test(contractBody));
  check("6. the contract says project rules win", /project rules win|AGENTS\.md.*wins|beats this file/i.test(contractBody));
  check("6. the contract states the traceability chain",
    /requirement\s*→\s*change\s*→\s*review\s*→\s*check\s*→\s*delivery/.test(contractBody));
  check("6. the contract says only the planner writes requirements", /only the planner writes it/i.test(contractBody));
  check("6. the contract gives the changelog a single author and a validator",
    /only agent that writes it/i.test(contractBody) && /deliverer verifies it/i.test(contractBody));
  check("6. the contract requires agents to ask instead of guessing", /does not choose|instead of guessing/i.test(contractBody));
  // The language split: the envelope is English because the next agent reads
  // it; the question is the single field the user reads.
  check("6. the contract says the result object is English", /object is English/i.test(contractBody));
  check("6. the contract names the question as the exception", /one exception/i.test(contractBody) && /question is the one field the user reads/i.test(contractBody));
  check("6. the contract says agents talk to each other in English", /agents talk to each other in english/i.test(contractBody));
  const wrongLanguage = [...FORBIDDEN_LANGUAGE];
  check("6. the contract does not put the result object in the user's language", wrongLanguage.filter((t) => contractBody.includes(t)).length === 0, wrongLanguage.join(" | "));
  for (const agent of AGENTS) {
    const leaked = wrongLanguage.filter((t) => promptText[agent].includes(t));
    check(`6. ${agent}.md does not put the result object in the user's language`, leaked.length === 0, leaked.join(" | "));
  }
  check("6. the contract forbids claiming an unrun check", /never claim a check you did not run/i.test(contractBody));
  check("6. the contract does not document the slash commands", !/\/harness-(run|mode|config|model|auto|delivery)/.test(contractBody));
  check("6. the contract says two roles can write, not one",
    /exactly two roles can write/i.test(contractBody) && !/exactly one role modifies files/i.test(contractBody));
  check("6. the contract says this is not a sandbox",
    /capability boundary, not a sandbox/i.test(contractBody));
  check("6. the contract says the result shape is closed",
    /closed shape/i.test(contractBody) && /names it back/i.test(contractBody));
}

// --- 7. nothing project-specific leaks into the published surface ---------

{
  const LEAKY = ["harness.config", "pi-minimal-harness.md", ".pi/extensions", "tests/", "harness.ts", "corpustory", "orchestrator", "critic"];
  for (const agent of AGENTS) {
    const leaked = LEAKY.filter((t) => promptText[agent].toLowerCase().includes(t));
    check(`7. ${agent}.md carries nothing specific to this repository`, leaked.length === 0, leaked.join(", "));
  }
  const contractLeaky = LEAKY.filter((t) => contractBody.toLowerCase().includes(t));
  check("7. the contract carries nothing specific to this repository", contractLeaky.length === 0, contractLeaky.join(", "));
}

// --- 8. the delivery skill matches the new role ---------------------------

{
  const skill = await fs.readFile(path.join(ROOT, ".agents", "skills", "github-delivery", "SKILL.md"), "utf8");
  check("8. the skill requires traceability before delivery", /every delivered requirement is traced/i.test(skill));
  check("8. the skill requires the review to be resolved", /review's findings were resolved/i.test(skill));
  check("8. the skill requires the changelog to be current", /changelog is current/i.test(skill));
  check("8. the skill still refuses delivery around a blocker", /do not deliver around a blocker/i.test(skill));
  check("8. the skill still forbids merging", /do not merge/i.test(skill));
  check("8. the skill keeps its git procedure", /gh pr create/.test(skill) && /Conventional Commits/.test(skill));
}

// --- 9. the obsolete design docs are gone --------------------------------

{
  for (const doc of ["WORKFLOW.md", "DISPATCH-PLAN.md"]) {
    const gone = await fs.access(path.join(ROOT, "docs", doc)).then(() => false, () => true);
    check(`9. the obsolete docs/${doc} is gone`, gone);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
