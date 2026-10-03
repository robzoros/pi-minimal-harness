#!/usr/bin/env node

/**
 * Install pi-minimal-harness resources into a project.
 *
 * The installer is intentionally dependency-free and conservative: existing
 * files are preserved unless --force is supplied, and the local harness config
 * is excluded from the repository's local Git exclude file when possible.
 *
 * The local harness.config.yaml belongs to the user, so it is never copied over:
 * it is created from the template when missing and otherwise merged additively
 * (missing keys are added, existing values, keys and sequences are kept).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_BLOCK_START = "<!-- BEGIN pi-minimal-harness -->";
const HARNESS_BLOCK_END = "<!-- END pi-minimal-harness -->";
/** The contract, copied verbatim to the root of every adopting project. */
const CONTRACT_FILE = "pi-minimal-harness.md";
/** What the project's AGENTS.md gets: a pointer to the contract, not a copy. */
const HARNESS_REFERENCE = [
  "## pi-minimal-harness instructions",
  "* **Harness Rules:** Read pi-minimal-harness.md and strictly follow its guidelines for this project's harness.",
  "* **Conflict Resolution:** If any rules in AGENTS.md conflict with pi-minimal-harness.md, the rules in AGENTS.md take precedence.",
].join("\n");
const [REFERENCE_HEADING, ...REFERENCE_BULLETS] = HARNESS_REFERENCE.split("\n");

function usage() {
  return `Usage: pi-minimal-harness <command> [options]

Commands:
  init     Install the pi-minimal-harness extension, prompts, delivery skill,
           local config, the ${CONTRACT_FILE} contract and the AGENTS.md
           reference to it into a project.
  update   Refresh an existing installation. Upstream-owned files (extension,
           prompts, delivery skill, ${CONTRACT_FILE}) are replaced; a pasted
           AGENTS.md contract becomes a reference to the contract file, and
           missing keys are added to harness.config.yaml. Existing values are
           never overwritten and no key is ever removed.

Options:
  --project <path>  Project directory (default: current directory)
  --dry-run         Show planned changes without writing files
  --force           Replace conflicting generated files (init only; update
                    always replaces upstream-owned files)
  -h, --help        Show this help
`;
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    return { help: true, project: process.cwd(), dryRun: false, force: false };
  }
  const command = argv[0];
  if (command !== "init" && command !== "update") {
    throw new Error(`Unknown command. Use: pi-minimal-harness init|update\n\n${usage()}`);
  }
  // `update` always refreshes upstream-owned files; the local config is merged
  // additively instead, so --force never reaches harness.config.yaml.
  const options = { command, project: process.cwd(), dryRun: false, force: command === "update" };
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
      const hint = harnessOwned(destination)
        ? " This project already has the harness: 'npx pi-minimal-harness update' refreshes an installation."
        : "";
      throw new Error(`Refusing to overwrite ${destination}. Re-run with --force to replace it.${hint}`);
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

/** True for the files the harness owns, which an installation always has. */
function harnessOwned(destination) {
  const relative = destination.split(path.sep).join("/");
  return (
    relative.includes("/.pi/extensions/harness.ts") ||
    relative.includes("/prompts/") ||
    relative.endsWith(`/${CONTRACT_FILE}`)
  );
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

// ---------------------------------------------------------------------------
// Additive merge of the project's local harness.config.yaml
// ---------------------------------------------------------------------------
// The local config belongs to the user. An update may ADD the keys a newer
// template introduced, but it must never overwrite an existing value, never
// remove a key and never rewrite a YAML sequence. The merge is line based (no
// parser, no dependency) and preserves the file's line endings and the
// indentation width already used by the local file.

const KEY_PATTERN = /^([ \t]*)([A-Za-z0-9_.$-]+):([ \t]|$)/;

function indentWidth(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function isBlankOrComment(line) {
  return line.trim() === "" || /^\s*#/.test(line);
}

/** Last line (inclusive) that belongs to the key at `keyIndex`. */
function blockEnd(lines, keyIndex, limit) {
  const indent = indentWidth(lines[keyIndex]);
  let last = keyIndex;
  for (let i = keyIndex + 1; i < limit; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentWidth(lines[i]) > indent) {
      last = i;
      continue;
    }
    break;
  }
  return last;
}

/** Ordered entries of a key block; each entry covers its key line and children. */
function parseEntries(lines, start, limit) {
  const entries = [];
  for (let i = start; i < limit; i++) {
    const match = lines[i].match(KEY_PATTERN);
    if (!match) continue;
    const end = blockEnd(lines, i, limit);
    entries.push({ key: match[2], indent: match[1].length, start: i, end });
    i = end;
  }
  return entries;
}

/** Direct children of an entry (the shallowest keys inside its block). */
function childEntries(lines, entry) {
  const candidates = parseEntries(lines, entry.start + 1, entry.end + 1);
  if (candidates.length === 0) return [];
  const indent = Math.min(...candidates.map((candidate) => candidate.indent));
  return candidates.filter((candidate) => candidate.indent === indent);
}

/** Shape of an entry: "scalar", "sequence" or "mapping". */
function kindOf(lines, entry) {
  for (let i = entry.start + 1; i <= entry.end; i++) {
    if (isBlankOrComment(lines[i])) continue;
    return /^\s*-\s/.test(lines[i]) ? "sequence" : "mapping";
  }
  return "scalar";
}

/** Comment lines written just above an entry, up to the previous content line. */
function leadingComments(lines, entry, limit) {
  const collected = [];
  for (let i = entry.start - 1; i >= limit; i--) {
    if (!isBlankOrComment(lines[i])) break;
    collected.unshift(lines[i]);
  }
  const blank = collected.findIndex((line) => line.trim() === "");
  return blank === -1 ? collected : collected.slice(blank + 1);
}

/** Shift a line's leading whitespace by `delta` spaces (non-content lines are kept). */
function shiftLine(line, delta) {
  if (line.trim() === "" || delta === 0) return line;
  return delta > 0 ? " ".repeat(delta) + line : line.slice(-delta);
}

/** The entry's lines, re-indented for the local file. */
function reindent(lines, entry, targetIndent) {
  const delta = targetIndent - entry.indent;
  return lines.slice(entry.start, entry.end + 1).map((line) => shiftLine(line, delta));
}

/** Line index where a new key of the current level must be inserted. */
function insertionIndex(lines, limit) {
  for (let i = limit - 1; i >= 0; i--) {
    if (!isBlankOrComment(lines[i])) return i + 1;
  }
  return 0;
}

/**
 * Merge `templateLines` into `localLines` additively.
 * Returns the new lines plus the key paths added and kept as they were.
 */
function mergeAdditive(templateLines, localLines) {
  const insertions = new Map();
  const added = [];
  const kept = [];

  const walk = (templateEntries, localEntries, localLimit, prefix, templateParent, localParent, localStep, levelStart) => {
    const taken = new Set();
    for (const entry of templateEntries) {
      const keyPath = prefix ? `${prefix}.${entry.key}` : entry.key;
      const localIndex = localEntries.findIndex((candidate, i) => candidate.key === entry.key && !taken.has(i));
      const local = localIndex === -1 ? null : localEntries[localIndex];
      if (local) taken.add(localIndex);
      const templateKind = kindOf(templateLines, entry);
      const templateStep = entry.indent - templateParent;

      if (!local) {
        // New keys use the indentation step the local file already applies.
        const targetIndent = localParent === null ? entry.indent : localParent + localStep;
        const delta = targetIndent - entry.indent;
        const text = [
          ...leadingComments(templateLines, entry, levelStart).map((line) => shiftLine(line, delta)),
          ...reindent(templateLines, entry, targetIndent),
        ];
        const index = insertionIndex(localLines, localLimit);
        if (localParent === null && index > 0) text.unshift("");
        if (!insertions.has(index)) insertions.set(index, []);
        insertions.get(index).push(text);
        added.push(keyPath);
        continue;
      }

      if (templateKind === "mapping" && kindOf(localLines, local) === "mapping") {
        const localChildren = childEntries(localLines, local);
        const step =
          localChildren.length > 0 ? Math.min(...localChildren.map((child) => child.indent)) - local.indent : templateStep;
        walk(
          childEntries(templateLines, entry),
          localChildren,
          local.end + 1,
          keyPath,
          entry.indent,
          local.indent,
          step,
          entry.start + 1,
        );
        continue;
      }
      if (templateKind !== kindOf(localLines, local)) {
        kept.push(keyPath);
      }
      // Same shape (scalar or sequence): the user's value always wins.
    }
  };

  walk(
    parseEntries(templateLines, 0, templateLines.length),
    parseEntries(localLines, 0, localLines.length),
    localLines.length,
    "",
    null,
    null,
    2,
    0,
  );

  const lines = [...localLines];
  for (const index of [...insertions.keys()].sort((a, b) => b - a)) {
    lines.splice(index, 0, ...insertions.get(index).flat());
  }
  return { lines, added, kept };
}

async function mergeLocalConfig(source, destination, options, report) {
  const relative = path.relative(options.project, destination) || destination;
  if (!(await pathExists(source))) throw new Error(`Installer source is missing: ${source}`);
  if (!(await pathExists(destination))) {
    report.push(`create ${relative}`);
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
    return;
  }

  const localText = await fs.readFile(destination, "utf8");
  const eol = localText.includes("\r\n") ? "\r\n" : "\n";
  const templateLines = (await fs.readFile(source, "utf8")).split(/\r?\n/);
  const localLines = localText.split(/\r?\n/);
  const { lines, added, kept } = mergeAdditive(templateLines, localLines);

  for (const keyPath of kept) {
    report.push(`keep ${keyPath} in ${relative} (local shape differs from the template)`);
  }
  if (added.length === 0) {
    report.push(`unchanged ${relative} (no new keys; local values kept)`);
    return;
  }
  for (const keyPath of added) report.push(`add ${keyPath} in ${relative}`);
  report.push(
    `${options.dryRun ? "would add" : "added"} ${added.length} key(s) to ${relative} (existing values untouched)`,
  );
  if (options.dryRun) return;
  const backup = `${destination}.bak`;
  report.push(`backup ${path.relative(options.project, backup) || backup}`);
  await fs.copyFile(destination, backup);
  await fs.writeFile(destination, lines.join(eol), "utf8");
}

/**
 * The project's AGENTS.md gets a pointer to the contract, never a copy of it:
 * the reference lines are appended once, inside the installer's markers, and a
 * second run finds them and changes nothing. An installation that still carries
 * the contract an older release pasted between those markers is migrated in
 * place by `update`; anything the project wrote itself is left alone.
 */
async function ensureHarnessReference(project, options, report) {
  const destination = path.join(project, "AGENTS.md");
  const relative = path.relative(project, destination) || destination;
  let current = "";
  if (await pathExists(destination)) current = await fs.readFile(destination, "utf8");

  if (REFERENCE_BULLETS.every((line) => current.includes(line)) && current.includes(REFERENCE_HEADING)) {
    report.push(`unchanged ${relative} (harness reference already present)`);
    return;
  }
  if (current.includes(REFERENCE_HEADING)) {
    report.push(
      `note ${relative} has a "${REFERENCE_HEADING}" section that differs from this release; left exactly as it is`,
    );
    return;
  }

  const block = `${HARNESS_BLOCK_START}\n${HARNESS_REFERENCE}\n${HARNESS_BLOCK_END}\n`;
  const start = current.indexOf(HARNESS_BLOCK_START);
  const end = current.indexOf(HARNESS_BLOCK_END);
  if (start >= 0 && end > start) {
    // A contract an older release pasted between the markers. Replacing the
    // marked region is the one edit `update` is allowed to make here: the
    // marker block is the harness's own, and the contract now lives in its
    // own file, which the same run copies in.
    if (!options.force) {
      report.push(
        `note ${relative} carries a pasted harness contract: "npx pi-minimal-harness update" replaces it with the ${CONTRACT_FILE} reference`,
      );
      return;
    }
    const updated = `${current.slice(0, start)}${block}${current.slice(end + HARNESS_BLOCK_END.length)}`;
    report.push(`replace the pasted harness contract in ${relative} with the ${CONTRACT_FILE} reference`);
    if (!options.dryRun) await fs.writeFile(destination, updated, "utf8");
    return;
  }
  if (/^##\s+Harness workflow\s*$/m.test(current)) {
    // Pasted by hand, so it has no markers and its extent is the project's
    // guess. Keep it, point at the contract as well, and say what it means.
    report.push(
      `note ${relative} carries a hand-pasted harness contract; it is kept and is superseded by ${CONTRACT_FILE}`,
    );
  }
  const updated = current ? `${current.trimEnd()}\n\n${block}` : block;
  report.push(`${current ? "append harness reference to" : "create"} ${relative}`);
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
  const wanted = [`/${relativeConfig}`, `/${relativeConfig}.bak`];
  const lines = exclude.split(/\r?\n/);
  const missing = wanted.filter((entry) => !lines.includes(entry) && !lines.includes(entry.slice(1)));
  if (missing.length === 0) {
    report.push(`unchanged ${path.relative(project, excludePath) || excludePath} (local config excluded)`);
    return;
  }
  report.push(`exclude ${missing.join(", ")} in ${path.relative(project, excludePath) || excludePath}`);
  if (!options.dryRun) {
    await fs.mkdir(infoDir, { recursive: true });
    const prefix = exclude && !exclude.endsWith("\n") ? "\n" : "";
    await fs.writeFile(
      excludePath,
      `${exclude}${prefix}\n# pi-minimal-harness local configuration\n${missing.join("\n")}\n`,
      "utf8",
    );
  }
}

/**
 * The contract tells every agent to record its work in a changelog, so an
 * adopting project needs one. Only a missing file is created: an existing
 * changelog belongs to the project and is never touched, and the new one holds
 * the heading and nothing else — no invented history.
 */
async function ensureChangelog(project, options, report) {
  const destination = path.join(project, "CHANGELOG.md");
  const relative = path.relative(project, destination) || destination;
  if (await pathExists(destination)) {
    report.push(`unchanged ${relative} (project changelog kept)`);
    return;
  }
  report.push(`create ${relative} (empty: the project has no changelog yet)`);
  if (options.dryRun) return;
  const heading = ["# Changelog", "", "All notable changes to this project are documented in this file.", ""].join("\n");
  await fs.writeFile(destination, heading, "utf8");
}

/**
 * An adopting project needs models before the pipeline can run, and the
 * template ships placeholders. They are reported, never rejected: the installer
 * has no model catalog, so /harness-config is what turns this into a hard
 * failure, and by then the user knows why.
 */
async function reportTemplatePlaceholders(destination, report) {
  if (!(await pathExists(destination))) return;
  const lines = (await fs.readFile(destination, "utf8")).split(/\r?\n/);
  const placeholders = lines.filter((line) => /^ {4}model:\s*provider\/model-id\s*$/.test(line)).length;
  const project = lines.find((line) => /^project:\s*(.*)$/.test(line));
  const projectPlaceholder = project && /^project:\s*my-project\s*$/.test(project);
  if (placeholders > 0) {
    report.push(`warning ${placeholders} agent(s) still use the template model placeholder (model: provider/model-id)`);
  }
  if (projectPlaceholder) {
    report.push("warning project: is still the template placeholder (project: my-project)");
  }
}

/** Documented prerequisite: the extension needs a Node that can load TypeScript. */
function reportPrerequisites(report) {
  const [major] = process.versions.node.split(".").map(Number);
  if (Number.isFinite(major) && major < 22) {
    report.push(`warning Node ${process.versions.node} found; the harness needs Node >= 22 to load the extension`);
  }
}

/**
 * `init` is for a project that does not have the harness yet. Once it is
 * installed, `update` is the command that refreshes it: a half-applied `init`
 * leaves the user believing they upgraded, so route instead of half-doing.
 */
async function findExistingInstall(project) {
  if (await pathExists(path.join(project, "harness.config.yaml"))) return "harness.config.yaml";
  if (await pathExists(path.join(project, ".pi", "extensions", "harness.ts"))) return path.join(".pi", "extensions", "harness.ts");
  return null;
}

/**
 * The architect keeps the formal requirements of the work in design, so an
 * adopting project needs the file before the first design session. Only a
 * missing file is created: it belongs to the project, like its changelog, and
 * is never touched again — so it must stay out of the harness-owned set that
 * `update` replaces.
 */
async function ensureRequirements(project, options, report) {
  const destination = path.join(project, "REQUIREMENTS.md");
  const relative = path.relative(project, destination) || destination;
  if (await pathExists(destination)) {
    report.push(`unchanged ${relative} (project requirements kept)`);
    return;
  }
  report.push(`create ${relative} (empty: the architect fills it during design)`);
  if (options.dryRun) return;
  const heading = [
    "# Requirements",
    "",
    "The formal scope of the work in design, maintained by the architect.",
    "",
    "## Additions",
    "",
    "## Modifications",
    "",
    "## Out of scope",
    "",
  ].join("\n");
  await fs.writeFile(destination, heading, "utf8");
}

/**
 * Modes this harness no longer offers. An installation that names one keeps
 * its value: the merge is additive and never overwrites a local scalar, so
 * without this the pipeline would resolve a mode with no steps and auto-harness
 * would stop working with no error the user could act on.
 */
const RETIRED_MODES = ["simple", "implementation-only", "delivery-only"];
const REPLACEMENT_MODE = "full";

/** Rewrite `defaults.workflow_mode` when it names a retired mode. */
async function migrateWorkflowMode(destination, options, report) {
  if (!(await pathExists(destination))) return;
  const text = await fs.readFile(destination, "utf8");
  const match = /^ {2}workflow_mode:\s*(\S+)\s*$/m.exec(text);
  if (!match || !RETIRED_MODES.includes(match[1])) return;
  const relative = path.relative(options.project, destination) || destination;
  report.push(`migrate ${relative}: workflow_mode "${match[1]}" is gone, using "${REPLACEMENT_MODE}"`);
  if (options.dryRun) return;
  const next = text.replace(/^ {2}workflow_mode:\s*\S+\s*$/m, `  workflow_mode: ${REPLACEMENT_MODE}`);
  await fs.writeFile(destination, next, "utf8");
}

async function install(options) {
  const report = [];
  await fs.mkdir(options.project, {recursive: true });
  reportPrerequisites(report);
  if (options.command === "init") {
    const existing = await findExistingInstall(options.project);
    if (existing && !options.dryRun) {
      // Not an error: init stays idempotent and additive on purpose, so a
      // project with an edited config can still run it. But say plainly that
      // update is the command that refreshes an installation, before doing
      // anything, so nobody reads this run as an upgrade.
      report.push(`note ${existing} is already here: this is an install, not an upgrade — 'npx pi-minimal-harness update' refreshes one`);
    }
  }
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
    path.join(PACKAGE_ROOT, CONTRACT_FILE),
    path.join(options.project, CONTRACT_FILE),
    options,
    report,
  );
  await mergeLocalConfig(
    path.join(PACKAGE_ROOT, "harness.config.example.yaml"),
    path.join(options.project, "harness.config.yaml"),
    options,
    report,
  );
  await ensureHarnessReference(options.project, options, report);
  await migrateWorkflowMode(path.join(options.project, "harness.config.yaml"), options, report);
  await ensureChangelog(options.project, options, report);
  await ensureRequirements(options.project, options, report);
  await reportTemplatePlaceholders(path.join(options.project, "harness.config.yaml"), report);
  await addLocalConfigExclude(options.project, options, report);

  const header = options.dryRun
    ? "Dry run — no files were changed:"
    : options.command === "update"
      ? "Updated pi-minimal-harness:"
      : "Installed pi-minimal-harness:";
  console.log(header);
  for (const line of report) console.log(`  ${line}`);
  console.log("\nNext steps:");
  if (options.command === "update") {
    console.log("  1. Run /reload in Pi to load the updated extension and prompts.");
    console.log("  2. Run /harness-config to validate the configuration.");
  } else {
    console.log("  1. Set models in harness.config.yaml using Pi's /models output.");
    console.log("  2. Run /reload in Pi.");
    console.log("  3. Run /harness-config to validate the installation.");
  }
  console.log("\nLater upgrades: npx pi-minimal-harness update");
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
