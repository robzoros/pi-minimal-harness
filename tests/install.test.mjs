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

test("init --dry-run reports changes without writing", async () => {
  const project = await tempProject();
  try {
    const result = runInstaller(["init", "--project", project, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run/);
    assert.equal(await fs.access(path.join(project, ".pi", "extensions", "harness.ts")).then(() => true, () => false), false);
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
    assert.equal(await fs.readFile(extension, "utf8"), "local change\n");

    const forced = runInstaller(["init", "--project", project, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.notEqual(await fs.readFile(extension, "utf8"), "local change\n");
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
