# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A dependency-free `pi-minimal-harness init` installer with dry-run, force,
  idempotent contract merging, and local Git exclusion for the generated config.
- Model-aware reasoning-effort selection in `/harness-model`: after choosing a
  model from Pi's catalog, the operator chooses from the effort levels exposed
  by that model. Model and effort are persisted atomically in the agent block.

### Changed

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
