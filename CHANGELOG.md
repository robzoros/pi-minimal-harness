# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
