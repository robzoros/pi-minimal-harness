# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Dispatch was broken for the recommended way to adopt the contract. The
  installer pastes the block into the project's `AGENTS.md`, so a project that
  keeps no standalone `AGENTS-addition.md` had no contract to inject, and every
  `harness-dispatch` call threw `subagent_context_file not found` — with
  `allow_dispatch: true` and the agent's own instructions authorising the call —
  while `/harness-config` showed the same failure in red. Neither adoption
  option in `AGENTS-addition.md` mentioned it, because the two options are not
  equivalent. The contract is now resolved by **existence**, in order:
  `defaults.subagent_context_file` when it resolves, an `AGENTS.md` carrying the
  `<!-- BEGIN pi-minimal-harness -->` block, then a standalone
  `AGENTS-addition.md`. A configured key whose file was deleted falls through
  instead of failing, which is the state every pasted-contract project is left
  in after an update, since the additive config merge never removes the key. A
  key that resolves nowhere is reported on its own `/harness-config` check so
  the fallback is visible rather than silent.
- The installer injected the whole of `AGENTS-addition.md` into the adopting
  project's `AGENTS.md`, including the preamble that documents the two
  adoption options and how to re-sync the file — documentation for whoever
  reads the source file, addressed to the agent. The pasted block now starts at
  `## Harness workflow`; a missing heading is a hard error rather than a
  silent full-file paste.
- The contract told agents to keep a tracked `.gitignore` inside `.codegraph/`,
  which is unexecutable for a project whose ignore rules already cover the
  directory, and promised that "this harness ships `github-delivery`" as a fact
  about any adopting project. The index is now described as local state that
  must not be committed, with the ignore file left to the project's own rules,
  and a declared skill is something to verify rather than assume.

- The Engram setup instructions told the reader to run `pi-engram init` as a
  bare command. It is never on the `PATH`: `pi install` keeps package shims in
  npm's private `node_modules/.bin`, which npm only exposes to scripts run
  inside that package. The README now shows the three invocations that work
  (bash, PowerShell and plain `node cli.js`), explains why the shim is not on
  the `PATH`, warns against `npx pi-engram` (the package is `gentle-engram`;
  the binary is only its name), and points at `ENGRAM_BIN` when the Engram
  binary itself is not on the `PATH`.
- The documentation named `~/.pi/agent/mcp.json` as the file where the
  `pi-mcp-adapter` integration registers its servers. That is the legacy file,
  and its `mcpServers` may be owned by Pi's built-in MCP; the adapter's own
  config is `~/.pi/agent/mcp-adapter.json`
  (`%USERPROFILE%\.pi\agent\mcp-adapter.json` on Windows). `README.md`,
  `AGENTS.md` and `AGENTS-addition.md` now point at the adapter file, and the
  README explains that a `pi-engram init` that landed the Engram entry in the
  legacy file has to be moved across.
- The smoke test only ran on Posix hosts: it built its temporary project under
  the hardcoded `/tmp` (absent on Windows) and imported the extension through a
  hand-built `file://` string. It now uses `os.tmpdir()` and `pathToFileURL`,
  and `node tests/harness.test.mjs` works unchanged on Windows, macOS and
  Linux.
- `node tests/harness.test.mjs` failed with `ERR_UNKNOWN_FILE_EXTENSION ".ts"`
  on Node releases before 22.18, which cannot import the TypeScript extension
  without `--experimental-strip-types`. The test now re-runs itself with the
  flag when the runtime lacks TypeScript support.
- A Windows checkout with `core.autocrlf` enabled could rewrite the repository
  to CRLF. `.gitattributes` pins the working tree to LF.

- `harness-dispatch` reported its failures by returning `{ isError: true }`, but
  `AgentToolResult` has no such field and the Pi runtime only marks a tool call
  as an error when `execute` throws. Every dispatch gate failure (disabled
  dispatch, unknown agent, empty brief, missing contract file, unsupported
  model effort) was therefore recorded as a **success**. The failure paths now
  throw, and a batch in which every agent failed throws with the per-agent
  summary in the message so the model still sees why. A partial batch still
  resolves normally and reports the failures in its text.

### Changed

- `defaults.subagent_context_file` is no longer part of the shipped
  configuration: it is optional, because the contract is resolved by
  existence. Existing projects keep the key and keep working, including the
  projects whose key names a file they no longer have.
- `init` and `update` create an empty `CHANGELOG.md` in the adopting project
  when it has none — the contract asks every agent to record its work in a
  changelog, and most projects have no file to write to. The new one holds the
  Keep a Changelog heading and nothing else: no invented history, and an
  existing changelog is never touched.

### Added

- `npx pi-minimal-harness update`: one command that upgrades an existing
  installation. It replaces the upstream-owned files (extension, prompts,
  delivery skill, `AGENTS.md` contract block) and merges the local
  `harness.config.yaml` **additively** — keys the newer template introduced are
  added with their default value and the comment that documents them, while
  every existing value, extra key and YAML sequence is left untouched and no
  key is ever removed. The previous config is kept as `harness.config.yaml.bak`
  (Git-excluded) whenever something is added, `--dry-run` lists every addition
  without writing, and the local file's indentation width and line endings are
  preserved. `init` uses the same merge, so it can no longer be blocked by an
  edited config.
- Control tools `harness_decision` and `harness_report`: the pipeline's
  decision and per-step report are now recorded by a tool call instead of being
  parsed out of the reply. The `HARNESS-DECISION` and `HARNESS-DONE` markers stay
  supported as a fallback for one release, and the tool wins when both are
  present. `harness_report` also captures the changed files and the checks that
  were run, which later steps can verify instead of trusting.
- `defaults.strict_decision_marker` (default `false`; enabled in this
  repository's own config): a multi-step pipeline stops with an error when the
  orchestrator's reply carries no usable decision marker, instead of reading
  its absence as "not `ANSWER_ONLY`" and running the file-mutating steps.
- `defaults.preflight_policy` (`advisory` | `blocking`): under `blocking`, a
  dirty working tree or an open pull request stops the first step that mutates
  files. With a TUI the operator is asked once; without one the step is blocked
  and reported as an error — never silently continued.
- `agents.<name>.mutates_files` marks which steps may modify files, so the
  preflight gate can protect them without naming agents in the extension.
  Agents without the field are assumed to mutate files, and `/harness-config`
  validation lists them.
- A dependency-free `pi-minimal-harness init` installer with dry-run, force,
  idempotent contract merging, and local Git exclusion for the generated config
  and its `update` backup.
- Model-aware reasoning-effort selection in `/harness-model`: after choosing a
  model from Pi's catalog, the operator chooses from the effort levels exposed
  by that model. Model and effort are persisted atomically in the agent block.

### Changed

- `README.md` now documents the full CodeGraph setup — `npm i -g codegraph`,
  `codegraph init` in the project, and the `codegraph` entry to add under
  `mcpServers` in `~/.pi/agent/mcp-adapter.json` (`serve --mcp`, `directTools:
  false`, `lifecycle: "lazy"`) — and the upgrade command shows the common case
  (`cd` into the project, then `npx --yes pi-minimal-harness@latest update`)
  alongside `--project`, with `/reload` and `/harness-config` as the follow-up.
- A turn whose assistant message still carries a pending tool call no longer
  satisfies the auto-harness turn wait, so a step that uses a tool is no longer
  read as finished between the tool call and its follow-up.
- The `HARNESS-DECISION` marker is only read on the **last non-empty line** of
  the orchestrator's reply. A marker quoted earlier (in prose, a code fence or
  a list of examples) no longer decides the pipeline and is no longer stripped
  from the visible reply; a final line naming both variants is ambiguous and
  yields no decision.
- `HARNESS-DONE` is now verified after **every** step instead of only the last
  one, with one repair turn per step naming the step, and the pipeline stops
  when a step still omits its report. A direct `ANSWER_ONLY` answer owes no
  report and is never repaired.
- Configuration validation now checks configured model IDs and model-supported
  reasoning efforts when Pi's catalog is available.
- Pipeline and background dispatch reject or warn about unsupported
  model/effort combinations instead of silently applying them.
- The interactive model/effort picker now returns to the agent menu after each
  saved change, with an explicit `Cancel` action; argument-based selection stays
  one-shot.
- README Engram setup now recommends `pi-engram init` instead of requiring
  manual Pi and MCP configuration.
- Add `/harness-delivery` to run the delivery agent without changing the
  configured workflow mode.
- Add an advisory repository preflight before pipelines to warn about
  uncommitted changes, branch divergence, and open pull requests.

## [0.1.0] - 2026-09-24

First public release as **pi-minimal-harness**.

### Added

- Pipeline driver (`.pi/extensions/harness.ts`): workflow modes
  (`simple`, `full-dry-run`, `full`, `implementation-only`, `delivery-only`)
  executed step by step with per-agent model, reasoning level and prompt
  template.
- Interactive commands: `/harness-config`, `/harness-mode`, `/harness-model`,
  `/harness-run`, `/harness-auto`.
- Question short-circuit: the orchestrator's `HARNESS-DECISION: ANSWER_ONLY`
  stops the pipeline after step 1; the decision is shown in the footer instead
  of the answer.
- Report guarantee: every non-orchestrator agent must end with `HARNESS-DONE`;
  one repair turn is sent when it is missing.
- Auto-harness: plain (non-slash) requests run through the pipeline.
- Footer status: `harness: <mode> [· step] [· decision] · auto: on|off`.
- Background dispatch tool (`harness-dispatch`): independent tasks in isolated
  `pi` subprocesses with curated briefs, gated by `allow_dispatch`.
- Configuration validation (modes, agents, models, templates, workflow steps,
  contract file, delivery skill).
- Prompt templates for the five agent roles (`prompts/`).
- Project skill `github-delivery` (branch → commit → push → PR conventions).
- `AGENTS-addition.md`: generic, paste-able contract for adopting projects.
- Smoke test `tests/harness.test.mjs` (73 checks; no network, no real config
  writes).

### Notes

- Memory (Engram) and CodeGraph are optional, user-level integrations —
  `gentle-engram` + `pi-mcp-adapter` packages, and the `codegraph` CLI. The
  harness does not bundle them.
