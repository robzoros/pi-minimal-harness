#!/usr/bin/env node

/**
 * Install pi-minimal-harness resources into a project.
 *
 * The installer is intentionally dependency-free and conservative: existing
 * files are preserved unless --force is supplied, and the local harness config
 * is excluded from the repository's local Git exclude file when possible.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_BLOCK_START = "<!-- BEGIN pi-minimal-harness -->";
const HARNESS_BLOCK_END = "<!-- END pi-minimal-harness -->";

function usage() {
  return `Usage: pi-minimal-harness init [options]

Install the pi-minimal-harness extension, prompts, delivery skill, local config,
and AGENTS.md contract into a project.

Options:
  --project <path>  Project directory (default: current directory)
  --dry-run         Show planned changes without writing files
  --force           Replace conflicting generated files
  -h, --help        Show this help
`;
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    return { help: true, project: process.cwd(), dryRun: false, force: false };
  }
  if (argv[0] !== "init") {
    throw new Error(`Unknown command. Use: pi-minimal-harness init\n\n${usage()}`);
  }
  const options = { project: process.cwd(), dryRun: false, force: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--project") {
      const value = argv[++i];
      if (!value) throw new Error("--project requires a path");
      options.project = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function filesEqual(left, right) {
  try {
    return (await fs.readFile(left, "utf8")) === (await fs.readFile(right, "utf8"));
  } catch {
    return false;
  }
}

async function copyFileIfAllowed(source, destination, options, report) {
  if (!(await pathExists(source))) throw new Error(`Installer source is missing: ${source}`);
  if (await pathExists(destination)) {
    if (await filesEqual(source, destination)) {
      report.push(`unchanged ${path.relative(options.project, destination) || destination}`);
      return;
    }
    if (!options.force) {
      throw new Error(`Refusing to overwrite ${destination}. Re-run with --force to replace it.`);
    }
    report.push(`replace ${path.relative(options.project, destination) || destination}`);
  } else {
    report.push(`create ${path.relative(options.project, destination) || destination}`);
  }
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function walkFiles(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

async function copyTree(sourceDirectory, destinationDirectory, options, report) {
  const files = await walkFiles(sourceDirectory);
  for (const source of files) {
    const relative = path.relative(sourceDirectory, source);
    await copyFileIfAllowed(source, path.join(destinationDirectory, relative), options, report);
  }
}

async function appendHarnessContract(project, options, report) {
  const source = path.join(PACKAGE_ROOT, "AGENTS-addition.md");
  const destination = path.join(project, "AGENTS.md");
  const contract = (await fs.readFile(source, "utf8")).trim();
  const block = `${HARNESS_BLOCK_START}\n${contract}\n${HARNESS_BLOCK_END}\n`;
  let current = "";
  if (await pathExists(destination)) current = await fs.readFile(destination, "utf8");
  const start = current.indexOf(HARNESS_BLOCK_START);
  const end = current.indexOf(HARNESS_BLOCK_END);
  if (start >= 0 && end >= start) {
    if (!options.force) {
      report.push(`unchanged ${path.relative(project, destination) || destination} (harness contract already present)`);
      return;
    }
    const updated = `${current.slice(0, start)}${block}${current.slice(end + HARNESS_BLOCK_END.length)}`;
    report.push(`replace harness contract in ${path.relative(project, destination) || destination}`);
    if (!options.dryRun) await fs.writeFile(destination, updated, "utf8");
    return;
  }
  if (/## Harness workflow\b/.test(current)) {
    if (!options.force) {
      report.push(`unchanged ${path.relative(project, destination) || destination} (existing harness workflow detected)`);
      return;
    }
    throw new Error(
      `AGENTS.md already contains a harness workflow section without installer markers. Refusing to edit it automatically; merge the section manually or use a clean file.`,
    );
  }
  const updated = current ? `${current.trimEnd()}\n\n${block}` : block;
  report.push(`${current ? "append harness contract to" : "create"} ${path.relative(project, destination) || destination}`);
  if (!options.dryRun) await fs.writeFile(destination, updated, "utf8");
}

async function findGitRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function addLocalConfigExclude(project, options, report) {
  const gitRoot = await findGitRoot(project);
  if (!gitRoot) {
    report.push("skip local config Git exclude (project is not inside a Git repository)");
    return;
  }
  const configPath = path.join(project, "harness.config.yaml");
  const relativeConfig = path.relative(gitRoot, configPath).split(path.sep).join("/");
  const infoDir = path.join(gitRoot, ".git", "info");
  const excludePath = path.join(infoDir, "exclude");
  let exclude = "";
  if (await pathExists(excludePath)) exclude = await fs.readFile(excludePath, "utf8");
  const lines = exclude.split(/\r?\n/);
  if (lines.includes(`/${relativeConfig}`) || lines.includes(relativeConfig)) {
    report.push(`unchanged ${path.relative(project, excludePath) || excludePath} (local config excluded)`);
    return;
  }
  report.push(`exclude ${relativeConfig} in ${path.relative(project, excludePath) || excludePath}`);
  if (!options.dryRun) {
    await fs.mkdir(infoDir, { recursive: true });
    const prefix = exclude && !exclude.endsWith("\n") ? "\n" : "";
    await fs.writeFile(excludePath, `${exclude}${prefix}\n# pi-minimal-harness local configuration\n/${relativeConfig}\n`, "utf8");
  }
}

async function install(options) {
  const report = [];
  await fs.mkdir(options.project, { recursive: true });
  await copyFileIfAllowed(
    path.join(PACKAGE_ROOT, ".pi", "extensions", "harness.ts"),
    path.join(options.project, ".pi", "extensions", "harness.ts"),
    options,
    report,
  );
  await copyTree(path.join(PACKAGE_ROOT, "prompts"), path.join(options.project, "prompts"), options, report);
  await copyTree(
    path.join(PACKAGE_ROOT, ".agents", "skills", "github-delivery"),
    path.join(options.project, ".agents", "skills", "github-delivery"),
    options,
    report,
  );
  await copyFileIfAllowed(
    path.join(PACKAGE_ROOT, "harness.config.example.yaml"),
    path.join(options.project, "harness.config.yaml"),
    options,
    report,
  );
  await appendHarnessContract(options.project, options, report);
  await addLocalConfigExclude(options.project, options, report);

  console.log(options.dryRun ? "Dry run — no files were changed:" : "Installed pi-minimal-harness:");
  for (const line of report) console.log(`  ${line}`);
  console.log("\nNext steps:");
  console.log("  1. Set models in harness.config.yaml using Pi's /models output.");
  console.log("  2. Run /reload in Pi.");
  console.log("  3. Run /harness-config to validate the installation.");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    await install(options);
  }
} catch (error) {
  console.error(`pi-minimal-harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
