import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "bin", "pi-minimal-harness.mjs");

function runInstaller(args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

async function tempProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pi-minimal-install-"));
}

/** A local config that the user has already edited: own values, own section, own sequence. */
const LOCAL_CONFIG = `project: local-project

defaults:
  workflow_mode: full

workflows:
  simple:
    steps:
      - only-me

custom_section:
  my_own_key: keep-me
`;

async function exists(filePath) {
  return await fs.access(filePath).then(() => true, () => false);
}

test("init --dry-run reports changes without writing", async () => {
  const project = await tempProject();
  try {
    const result = runInstaller(["init", "--project", project, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run/);
    assert.equal(await fs.access(path.join(project, ".pi", "extensions", "harness.ts")).then(() => true, () => false), false);
    assert.match(result.stdout, /create CHANGELOG\.md/);
    assert.equal(await exists(path.join(project, "CHANGELOG.md")), false);
    assert.match(result.stdout, /create REQUIREMENTS\.md/);
    assert.equal(await exists(path.join(project, "REQUIREMENTS.md")), false);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init installs resources and is idempotent", async () => {
  const project = await tempProject();
  try {
    const first = runInstaller(["init", "--project", project]);
    assert.equal(first.status, 0, first.stderr);
    for (const relative of [
      ".pi/extensions/harness.ts",
      "prompts/orchestrator.md",
      ".agents/skills/github-delivery/SKILL.md",
      "harness.config.yaml",
      "pi-minimal-harness.md",
      "AGENTS.md",
    ]) {
      await fs.access(path.join(project, relative));
    }
    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
    assert.match(agents, /^## pi-minimal-harness instructions$/m);
    assert.match(agents, /^\* \*\*Harness Rules:\*\* Read pi-minimal-harness\.md and strictly follow its guidelines for this project's harness\.$/m);
    assert.match(
      agents,
      /^\* \*\*Conflict Resolution:\*\* If any rules in AGENTS\.md conflict with pi-minimal-harness\.md, the rules in AGENTS\.md take precedence\.$/m,
    );
    // The contract is a file of its own: AGENTS.md points at it, never copies it.
    assert.doesNotMatch(agents, /## Harness workflow/);

    const second = runInstaller(["init", "--project", project]);
    assert.equal(second.status, 0, second.stderr);
    const agentsAgain = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agentsAgain.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
    assert.match(second.stdout, /unchanged AGENTS\.md \(harness reference already present\)/);
    assert.equal(agentsAgain, agents);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init refuses conflicts unless --force is supplied", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const extension = path.join(project, ".pi", "extensions", "harness.ts");
    await fs.writeFile(extension, "local change\n", "utf8");

    const conflict = runInstaller(["init", "--project", project]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /Refusing to overwrite/);
    // The old message pointed at --force, which is what the next error used to
    // tell you to do. The conflict has to name the command that upgrades.
    assert.match(conflict.stderr, /pi-minimal-harness update/);
    assert.equal(await fs.readFile(extension, "utf8"), "local change\n");

    const forced = runInstaller(["init", "--project", project, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.notEqual(await fs.readFile(extension, "utf8"), "local change\n");
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a reference written by hand is recognised and never rewritten", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    const handWritten = [
      "# Project",
      "",
      "## pi-minimal-harness instructions",
      "* **Harness Rules:** Read pi-minimal-harness.md and strictly follow its guidelines for this project's harness.",
      "* **Conflict Resolution:** If any rules in AGENTS.md conflict with pi-minimal-harness.md, the rules in AGENTS.md take precedence.",
      "",
      "- a rule of this project",
      "",
    ].join("\n");
    await fs.writeFile(agents, handWritten, "utf8");

    for (const args of [["update"], ["init", "--force"]]) {
      const result = runInstaller([...args, "--project", project]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /AGENTS\.md \(harness reference already present\)/);
      assert.equal(await fs.readFile(agents, "utf8"), handWritten);
    }
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update replaces a pasted contract with the reference, init only notes it", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    const legacy = [
      "# Project",
      "",
      "- a rule of this project",
      "",
      "<!-- BEGIN pi-minimal-harness -->",
      "## Harness workflow",
      "",
      "- the contract an older release pasted here",
      "<!-- END pi-minimal-harness -->",
      "",
    ].join("\n");
    await fs.writeFile(agents, legacy, "utf8");

    // init is not an upgrade: it says so and leaves the marked block alone.
    const init = runInstaller(["init", "--project", project]);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /note AGENTS\.md carries a pasted harness contract/);
    assert.equal(await fs.readFile(agents, "utf8"), legacy);

    const update = runInstaller(["update", "--project", project]);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /replace the pasted harness contract in AGENTS\.md/);
    const migrated = await fs.readFile(agents, "utf8");
    assert.match(migrated, /^# Project$/m);
    assert.match(migrated, /^- a rule of this project$/m);
    assert.match(migrated, /^## pi-minimal-harness instructions$/m);
    assert.doesNotMatch(migrated, /## Harness workflow/);
    assert.equal((migrated.match(/BEGIN pi-minimal-harness/g) ?? []).length, 1);
    assert.equal((migrated.match(/END pi-minimal-harness/g) ?? []).length, 1);

    // The contract the paste pointed at now lives in its own file, refreshed
    // by the same run.
    const contract = await fs.readFile(path.join(project, "pi-minimal-harness.md"), "utf8");
    assert.match(contract, /^## Harness workflow$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a contract pasted by hand is kept and the reference is added next to it", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    const handPasted = ["# Project", "", "## Harness workflow", "", "- rules this project pasted", ""].join("\n");
    await fs.writeFile(agents, handPasted, "utf8");

    const dry = runInstaller(["update", "--project", project, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /note AGENTS\.md carries a hand-pasted harness contract/);
    assert.equal(await fs.readFile(agents, "utf8"), handPasted);

    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /append harness reference to AGENTS\.md/);
    const updated = await fs.readFile(agents, "utf8");
    // The project's own text is never rewritten: the reference is additive and
    // a repeat run finds it.
    assert.match(updated, /^- rules this project pasted$/m);
    assert.match(updated, /^## pi-minimal-harness instructions$/m);
    const again = runInstaller(["update", "--project", project]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(await fs.readFile(agents, "utf8"), updated);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a half-written reference is left untouched", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    const partial = ["# Project", "", "## pi-minimal-harness instructions", "* **Harness Rules:** Read pi-minimal-harness.md.", ""].join("\n");
    await fs.writeFile(agents, partial, "utf8");

    for (const args of [["update"], ["init", "--force"]]) {
      const result = runInstaller([...args, "--project", project]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /differs from this release/);
      assert.equal(await fs.readFile(agents, "utf8"), partial);
    }
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init on an installed project names update as the upgrade command", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG, "utf8");

    const result = runInstaller(["init", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /note .*already here: this is an install, not an upgrade/);
    assert.match(result.stdout, /pi-minimal-harness update/);
    // Still additive: the local values are intact, which is why this is a note.
    assert.match(await fs.readFile(config, "utf8"), /^ {2}workflow_mode: full$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a fresh install reports the template placeholders it shipped", async () => {
  const project = await tempProject();
  try {
    const result = runInstaller(["init", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /warning 6 agent\(s\) still use the template model placeholder/);
    assert.match(result.stdout, /warning project: is still the template placeholder/);

    // Once the models are real the warning goes away, and dry-run shows it too.
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(
      config,
      (await fs.readFile(config, "utf8")).replace(/model: provider\/model-id/g, "model: opencode-go/gpt-5.1").replace("project: my-project", "project: my-app"),
      "utf8",
    );
    const after = runInstaller(["update", "--project", project, "--dry-run"]);
    assert.equal(after.status, 0, after.stderr);
    assert.doesNotMatch(after.stdout, /template model placeholder/);
    assert.doesNotMatch(after.stdout, /template placeholder/);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init ships the contract with its preamble commented, and creates a changelog when missing", async () => {
  const project = await tempProject();
  try {
    const result = runInstaller(["init", "--project", project]);
    assert.equal(result.status, 0, result.stderr);

    const contract = await fs.readFile(path.join(project, "pi-minimal-harness.md"), "utf8");
    // The preamble is documentation for whoever reads the file, not an
    // instruction for an agent, so everything above the first section is
    // inside an HTML comment.
    const preamble = contract.slice(0, contract.indexOf("## Harness workflow"));
    assert.equal(preamble.replace(/<!--[\s\S]*?-->/g, "").replace(/---/g, "").trim(), "");
    assert.match(contract, /^## Harness workflow$/m);
    // The whole file is the contract now: there is no slice to take.
    assert.doesNotMatch(contract, /Two ways to adopt/);

    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.doesNotMatch(agents, /Two ways to adopt/);
    assert.doesNotMatch(agents, /^# pi-minimal-harness\.md/m);
    assert.match(agents, /^## pi-minimal-harness instructions$/m);
    assert.equal((agents.match(/BEGIN pi-minimal-harness/g) ?? []).length, 1);
    assert.equal((agents.match(/END pi-minimal-harness/g) ?? []).length, 1);

    const changelog = await fs.readFile(path.join(project, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^# Changelog$/m);
    assert.match(result.stdout, /create CHANGELOG\.md/);

    // An existing changelog belongs to the project and is never rewritten.
    const own = "# Changelog\n\n- our own history\n";
    await fs.writeFile(path.join(project, "CHANGELOG.md"), own, "utf8");
    const again = runInstaller(["init", "--project", project]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged CHANGELOG\.md/);
    assert.equal(await fs.readFile(path.join(project, "CHANGELOG.md"), "utf8"), own);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update adds missing keys and never overwrites local values", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG, "utf8");

    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /add defaults\.auto_harness in harness\.config\.yaml/);
    assert.match(result.stdout, /existing values untouched/);

    const merged = await fs.readFile(config, "utf8");
    assert.match(merged, /^project: local-project$/m);
    assert.match(merged, /^ {2}workflow_mode: full$/m);
    assert.match(merged, /^ {2}auto_harness: true$/m);
    assert.match(merged, /^ {2}preflight_policy: advisory$/m);
    assert.match(merged, /^ {2}my_own_key: keep-me$/m);
    assert.match(merged, /^ {4}steps:\n {6}- only-me$/m);
    // The local sequence is kept verbatim: nothing is inserted into it and it
    // is not replaced by the template's steps for that mode.
    const simpleBlock = merged.match(/^ {2}simple:\n(?: {4,}.*\n)*/m)?.[0] ?? "";
    assert.equal(simpleBlock.trimEnd(), "  simple:\n    steps:\n      - only-me");
    assert.equal(await fs.readFile(`${config}.bak`, "utf8"), LOCAL_CONFIG);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update is idempotent and reports when no key is missing", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG, "utf8");
    assert.equal(runInstaller(["update", "--project", project]).status, 0);

    const merged = await fs.readFile(config, "utf8");
    const again = runInstaller(["update", "--project", project]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged harness\.config\.yaml \(no new keys/);
    assert.equal(await fs.readFile(config, "utf8"), merged);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update --dry-run reports additions without writing", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG, "utf8");

    const result = runInstaller(["update", "--project", project, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run/);
    assert.match(result.stdout, /add defaults\./);
    assert.equal(await fs.readFile(config, "utf8"), LOCAL_CONFIG);
    assert.equal(await exists(`${config}.bak`), false);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init adds missing keys to an existing config without --force", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG, "utf8");

    const result = runInstaller(["init", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /add defaults\./);
    const merged = await fs.readFile(config, "utf8");
    assert.match(merged, /^ {2}workflow_mode: full$/m);
    assert.match(merged, /^ {2}auto_harness: true$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update replaces upstream files and keeps the local indentation width", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const extension = path.join(project, ".pi", "extensions", "harness.ts");
    const prompt = path.join(project, "prompts", "orchestrator.md");
    const contract = path.join(project, "pi-minimal-harness.md");
    await fs.writeFile(extension, "local change\n", "utf8");
    await fs.writeFile(prompt, "stale prompt\n", "utf8");
    await fs.writeFile(contract, "stale contract\n", "utf8");
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG.replace(/^ {2}/gm, "    "), "utf8");

    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /replace .*harness\.ts/);
    assert.match(result.stdout, /replace .*pi-minimal-harness\.md/);
    assert.equal(
      await fs.readFile(prompt, "utf8"),
      await fs.readFile(path.join(ROOT, "prompts", "orchestrator.md"), "utf8"),
    );
    assert.equal(
      await fs.readFile(contract, "utf8"),
      await fs.readFile(path.join(ROOT, "pi-minimal-harness.md"), "utf8"),
    );
    const merged = await fs.readFile(config, "utf8");
    assert.match(merged, /^ {4}workflow_mode: full$/m);
    assert.match(merged, /^ {4}auto_harness: true$/m);
    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
    assert.match(agents, /^## pi-minimal-harness instructions$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("init and update create the requirements file, and never overwrite one", async () => {
  const project = await tempProject();
  try {
    const first = runInstaller(["init", "--project", project]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /create REQUIREMENTS\.md/);
    const requirements = await fs.readFile(path.join(project, "REQUIREMENTS.md"), "utf8");
    assert.match(requirements, /^# Requirements$/m);
    assert.match(requirements, /^## Additions$/m);

    // Project-owned, exactly like the changelog: `update` leaves it alone.
    const own = "# Requirements\n\n- our own scope\n";
    await fs.writeFile(path.join(project, "REQUIREMENTS.md"), own, "utf8");
    const again = runInstaller(["update", "--project", project]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged REQUIREMENTS\.md/);
    assert.equal(await fs.readFile(path.join(project, "REQUIREMENTS.md"), "utf8"), own);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

// REQ-006: the shape is the project's choice, read from
// `defaults.requirements_format`. The harness never parses the file, so a
// typo must fall back rather than break the install.
test("requirements_format chooses the shape init writes, and an unknown value falls back", async () => {
  const cases = [
    { configured: "req-n", expectBlocks: true },
    { configured: "reqnn", expectBlocks: false },
  ];
  for (const { configured, expectBlocks } of cases) {
    const project = await tempProject();
    try {
      // `init` writes the config, so the key has to exist before the run that
      // is supposed to read it. Deleting the file it wrote is what makes the
      // next run create it again in the shape under test.
      runInstaller(["init", "--project", project]);
      const configPath = path.join(project, "harness.config.yaml");
      const config = await fs.readFile(configPath, "utf8");
      await fs.writeFile(configPath, config.replace(/^ {2}requirements_format: .*$/m, `  requirements_format: ${configured}`), "utf8");
      await fs.rm(path.join(project, "REQUIREMENTS.md"), { force: true });

      const result = runInstaller(["update", "--project", project]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`create REQUIREMENTS\\.md \\(${configured === "req-n" ? "req-n" : "sections"}`));

      const requirements = await fs.readFile(path.join(project, "REQUIREMENTS.md"), "utf8");
      assert.match(requirements, /^# Requirements$/m);
      assert.match(requirements, /^## Additions$/m);
      assert.equal(/^### REQ-001/m.test(requirements), expectBlocks, configured);
      if (expectBlocks) {
        // The block carries the fields that make a requirement checkable.
        assert.match(requirements, /\*\*Statement\*\*/);
        assert.match(requirements, /\*\*Acceptance\*\*/);
        assert.match(requirements, /\*\*Traces\*\*/);
      }
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  }
});

// The installer previously ignored `defaults.requirements_file` and always
// wrote a literal REQUIREMENTS.md, so a project that configured another name
// got a file the architect would never look at.
test("init honours defaults.requirements_file when creating the requirements file", async () => {
  const project = await tempProject();
  try {
    runInstaller(["init", "--project", project]);
    const configPath = path.join(project, "harness.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config.replace(/^ {2}requirements_file: .*$/m, "  requirements_file: docs/REQ.md"), "utf8");
    await fs.rm(path.join(project, "REQUIREMENTS.md"), { force: true });

    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create docs[\\/]REQ\.md/);
    assert.match(await fs.readFile(path.join(project, "docs", "REQ.md"), "utf8"), /^# Requirements$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update migrates a retired defaults.workflow_mode to a mode that exists", async () => {
  const project = await tempProject();
  try {
    runInstaller(["init", "--project", project]);
    const config = path.join(project, "harness.config.yaml");
    // The merge is additive and never overwrites a local scalar, so an
    // installation on a retired mode would keep it and then resolve a mode
    // with no steps.
    await fs.writeFile(
      config,
      (await fs.readFile(config, "utf8")).replace(/^ {2}workflow_mode: .*$/m, "  workflow_mode: delivery-only"),
    );

    const dry = runInstaller(["update", "--project", project, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /migrate .*workflow_mode "delivery-only" is gone, using "full"/);
    assert.match(await fs.readFile(config, "utf8"), /^ {2}workflow_mode: delivery-only$/m);

    const migrated = runInstaller(["update", "--project", project]);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(await fs.readFile(config, "utf8"), /^ {2}workflow_mode: full$/m);

    // Idempotent: a second update has nothing to migrate.
    const again = runInstaller(["update", "--project", project]);
    assert.doesNotMatch(again.stdout, /migrate .*workflow_mode/);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("update adds the architect agent to a configuration that predates it", async () => {
  const project = await tempProject();
  try {
    await fs.writeFile(path.join(project, "harness.config.yaml"), LOCAL_CONFIG);
    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    const config = await fs.readFile(path.join(project, "harness.config.yaml"), "utf8");
    // A wholly missing nested mapping is inserted whole, so a required new
    // agent cannot leave an existing installation failing validation.
    assert.match(config, /^ {2}architect:$/m);
    assert.match(config, /^ {2}analysis:$/m);
    // The project's own values are untouched.
    assert.match(config, /^project: local-project$/m);
    assert.match(config, /^ {2}my_own_key: keep-me$/m);
    assert.match(config, /^ {6}- only-me$/m);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
