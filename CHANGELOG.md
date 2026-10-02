# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0]

The workflow engine is replaced. This is a breaking change to the configuration
format; see [MIGRATION.md](MIGRATION.md).

### Added

- **A real state machine.** Control flow is a transition table in
  `.pi/extensions/lib/transitions.ts`: pure data, and the single source of
  truth for what runs when. Two rules are enforced by the table rather than
  stated in a prompt — no agent result moves the workflow past `PLANNING`, and
  an agent cannot choose its successor, because the result envelope is a closed
  shape and unknown fields are rejected by name.
- **A user approval gate.** The planner declares a plan ready; the workflow
  suspends; the user approves, asks for changes or stops. v1 let the planner
  approve its own plan.
- **Structured suspensions.** Every stop declares its reason (`needs_input`,
  `awaiting_approval`, `retry_limit`, `delivery_blocked`, `agent_failed`) and
  its resume point as data. v1 inferred the reason from the wording of a
  synthesised question, and always resumed at the planner.
- **A shared retry budget.** One unit is spent whenever the workflow re-enters
  `IMPLEMENTING`, whether the reviewer or the tester sent it back.
  `harness.max_retries` replaces having no policy at all.
- **Doubt escalation.** An agent that cannot decide something hands the doubt
  to the runtime first. The runtime settles it when it is checkable in the
  repository or the configuration, and escalates to the user when the topic is
  one only they can decide — scope, requirements, behaviour, architecture,
  strategy or acceptance criteria.
- **Requirements and traceability.** `.harness/requirements.md` with stable
  `REQ-NNN` identifiers, maintained by the planner and reported by everyone
  else, forming one chain: requirement → change → review → check → delivery.
- **A changelog gate.** The implementer is the only agent that writes the
  changelog; the deliverer refuses to ship while a delivered requirement is not
  cited in `[Unreleased]`.
- **`capabilities` instead of `tools`.** Capabilities map to real Pi tools where
  Pi has them — so an agent without `shell` cannot run a command — and degrade
  to a documented fallback where it does not. v1's `tools` was read by nobody
  except a test.
- **`tests/extension.test.mjs`.** Loads the extension the way Pi does. Added
  after a v2 `harness.ts` shipped with broken template literals and the whole
  suite stayed green, because the entry point was the only file nothing
  imported.

### Changed

- The extension is now a thin entry point over `.pi/extensions/lib/`: 2423
  lines become 329. Commands are `/harness-run`, `/harness-answer`,
  `/harness-config`, `/harness-model` and `/harness-status`; `/harness-mode`,
  `/harness-delivery`, the `harness-dispatch`, `harness_decision` and
  `harness_report` tools are gone.
- Agents are isolated processes and the driver waits on them, so the session is
  no longer driven turn by turn: no idle polling, and two workflows cannot
  interleave.
- Agent-to-agent traffic is English. What the user reads follows the user's
  language; the question is the only field inside the envelope that does.
- The installer now copies `.pi/extensions/lib/`, without which every adopter
  would have received an extension whose imports all failed, and ships an
  allowlist rather than matching `prompts/` as a substring.

### Removed

- Workflow modes and `workflows.<mode>.steps`. The flow is fixed.
- `question_short_circuit`, `strict_decision_marker`, `allow_dispatch`,
  `preflight_policy`, `mutates_files`, `prompt_template`, `responsibilities`,
  `skills`, `model_catalog_source`, `project`, `allow_simple_mode`,
  `preferred_interface` and `fallback_interface`: keys nothing read, or concepts
  the orchestrator removal made meaningless.

### Fixed

- The installer matched upstream files by substring, so a stray file in
  `prompts/` would have been copied into every adopting project.
- `findModelRef` and `supportedReasoningLevels` existed only in the v1
  extension and nowhere else; `/harness-model` could not have worked.

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
