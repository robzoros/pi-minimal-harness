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

function usage() {
  return `Usage: pi-minimal-harness <command> [options]

Commands:
  init     Install the pi-minimal-harness extension, prompts, delivery skill,
           local config, and AGENTS.md contract into a project.
  update   Refresh an existing installation. Upstream-owned files (extension,
           prompts, delivery skill, AGENTS.md contract) are replaced; missing
           keys are added to harness.config.yaml. Existing values are never
           overwritten and no key is ever removed.

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
 * The contract an adopting project receives: AGENTS-addition.md from the
 * "## Harness workflow" heading onward. Everything above that heading is
 * documentation for whoever reads the source file (the two adoption options,
 * how to re-sync it) and must not be injected into the project's AGENTS.md.
 */
async function harnessContractText() {
  const source = path.join(PACKAGE_ROOT, "AGENTS-addition.md");
  const text = (await fs.readFile(source, "utf8")).trim();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Harness workflow\s*$/.test(line));
  if (start === -1) {
    throw new Error(
      `AGENTS-addition.md has no "## Harness workflow" section; refusing to guess what the contract is.`,
    );
  }
  return lines.slice(start).join("\n").trim();
}

async function appendHarnessContract(project, options, report) {
  const destination = path.join(project, "AGENTS.md");
  const contract = await harnessContractText();
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
  await mergeLocalConfig(
    path.join(PACKAGE_ROOT, "harness.config.example.yaml"),
    path.join(options.project, "harness.config.yaml"),
    options,
    report,
  );
  await appendHarnessContract(options.project, options, report);
  await ensureChangelog(options.project, options, report);
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
