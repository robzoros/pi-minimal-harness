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
      "AGENTS.md",
    ]) {
      await fs.access(path.join(project, relative));
    }
    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
    assert.match(agents, /## Harness workflow/);

    const second = runInstaller(["init", "--project", project]);
    assert.equal(second.status, 0, second.stderr);
    const agentsAgain = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agentsAgain.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
    assert.match(second.stdout, /unchanged/);
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

test("a contract pasted without installer markers is recognised by content", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    // The documented adoption path pastes the section and never writes markers.
    const marked = await fs.readFile(agents, "utf8");
    const pasted = marked.replace(/<!-- BEGIN pi-minimal-harness -->\n|<!-- END pi-minimal-harness -->\n/g, "");
    await fs.writeFile(agents, pasted, "utf8");

    for (const args of [["update"], ["init", "--force"]]) {
      const result = runInstaller([...args, "--project", project]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /AGENTS\.md \(harness contract already present, pasted without installer markers\)/);
      assert.equal(await fs.readFile(agents, "utf8"), pasted);
    }

    // A project rule after the section is the point of pasting, not a conflict.
    const withRule = `${pasted}\n- a rule of this project\n`;
    await fs.writeFile(agents, withRule, "utf8");
    const kept = runInstaller(["update", "--project", project]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(await fs.readFile(agents, "utf8"), withRule);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a hand-edited contract is refused and left untouched", async () => {
  const project = await tempProject();
  try {
    assert.equal(runInstaller(["init", "--project", project]).status, 0);
    const agents = path.join(project, "AGENTS.md");
    const pasted = (await fs.readFile(agents, "utf8")).replace(
      /<!-- BEGIN pi-minimal-harness -->\n|<!-- END pi-minimal-harness -->\n/g,
      "",
    );
    const edited = pasted.replace(
      "- Work is executed through the `pi-minimal-harness` pipeline.",
      "- Work is executed the way this project prefers.",
    );
    await fs.writeFile(agents, edited, "utf8");

    for (const args of [["update"], ["init", "--force"]]) {
      const result = runInstaller([...args, "--project", project]);
      assert.notEqual(result.status, 0, `${args.join(" ")} should refuse`);
      assert.match(result.stderr, /differs from this release/);
      assert.equal(await fs.readFile(agents, "utf8"), edited);
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
    assert.match(result.stdout, /warning 5 agent\(s\) still use the template model placeholder/);
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

test("init writes only the contract section, and creates a changelog when missing", async () => {
  const project = await tempProject();
  try {
    const result = runInstaller(["init", "--project", project]);
    assert.equal(result.status, 0, result.stderr);

    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    // The preamble is documentation for whoever reads AGENTS-addition.md, not
    // part of what an agent should receive.
    assert.doesNotMatch(agents, /Two ways to adopt/);
    assert.doesNotMatch(agents, /^# AGENTS-addition\.md/m);
    assert.match(agents, /^## Harness workflow$/m);
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
    await fs.writeFile(extension, "local change\n", "utf8");
    await fs.writeFile(prompt, "stale prompt\n", "utf8");
    const config = path.join(project, "harness.config.yaml");
    await fs.writeFile(config, LOCAL_CONFIG.replace(/^ {2}/gm, "    "), "utf8");

    const result = runInstaller(["update", "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /replace .*harness\.ts/);
    assert.equal(
      await fs.readFile(prompt, "utf8"),
      await fs.readFile(path.join(ROOT, "prompts", "orchestrator.md"), "utf8"),
    );
    const merged = await fs.readFile(config, "utf8");
    assert.match(merged, /^ {4}workflow_mode: full$/m);
    assert.match(merged, /^ {4}auto_harness: true$/m);
    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/<!-- BEGIN pi-minimal-harness -->/g) ?? []).length, 1);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
