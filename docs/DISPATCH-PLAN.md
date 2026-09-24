# Dispatch Plan — Curated Background Subagents

Status: **implemented (milestones M1–M4)**. Pending: M5 (manual end-to-end with
a real dispatch). This document is a harness design document for
**pi-minimal-harness** (see `README.md`). It describes how the
harness will dispatch work to isolated subagents without losing the current
sequential pipeline.

## 1. Goal

Add opt-in, curated background dispatch:

- the orchestrator sends each isolated agent only a **brief** with the relevant
  information, never the conversation;
- independent agents run in **parallel**;
- the orchestrator composes the **final answer** from their results;
- the TUI shows per-agent progress while they work.

The in-session sequential pipeline (`workflows.<mode>` → driver) stays the
default for dependent steps. Dispatch is additive.

## 2. Non-goals

- Replacing the sequential pipeline. Dispatch is opt-in and complementary.
- Dumping the conversation, transcript or full history into subagents.
- Adding npm dependencies to the extension.
- Mapping the logical `agents.*.tools` names (`filesystem`, `openspec`, …) to
  real Pi tools. That is a separate gap and stays out of this plan.

## 3. Two-channel context model

The value of a subagent is receiving a small, relevant brief instead of the
whole history. That requires separating the **stable** from the **variable**:

| Channel | Content | Injection | Notes |
|---|---|---|---|
| Stable contract | `AGENTS-addition.md` (project rules) | subagent system prompt (`--append-system-prompt`) | fixed per agent, cacheable |
| Curated brief | objective, relevant files with refs, constraints, acceptance criteria, expected evidence, non-goals, unknowns | subagent user message | the orchestrator's handoff — the *only* task context |

If the brief omits something the subagent needs, the subagent reads files to
expand it (it keeps its read tools). The brief must therefore cite paths and
line references and list what is still unknown.

## 4. Mechanism (Pi-native)

Register one tool, `harness-dispatch`, with the model:

```
{ tasks: [{ agent, brief, cwd? }], parallel?: boolean }
```

- **Spawn per task:**
  `pi --mode json -p --no-session --append-system-prompt <tmp> [--model <ref>] [--thinking <level>]`
  with the brief as the prompt. Reuse the cross-platform `getPiInvocation`
  logic from Pi's `examples/extensions/subagent/index.ts` (it handles the
  `process.execPath` vs `pi` case on Windows/macOS/Linux).
- **Model/thinking:** resolved per agent from `harness.config.yaml`
  (`agents.<name>.model` / `.reasoning`) with the same catalog resolution the
  pipeline driver already uses; never invent a model id.
- **Output:** parse the JSON event lines, collect the final assistant text per
  task, cap it at 50 KB per task before returning it to the orchestrator.
- **Limits:** max 8 tasks, 4 concurrent (same as Pi's subagent example).
- **Progress:** `onUpdate` streams per-agent state into the tool row, and
  `ctx.ui.setWidget("harness-dispatch", lines)` shows a persistent panel while
  the dispatch runs (TUI only); both are cleared in `finally`.
- **Abort:** propagate the tool `signal` to the children (SIGTERM, then
  SIGKILL after a grace period).
- **Errors:** report per task (exit code, `stopReason`, stderr) and never drop a
  failed task silently.
- **Return:** the collected results go back to the orchestrator as the tool
  result; the orchestrator writes the final answer.

## 5. Configuration

New keys in `harness.config.yaml` `defaults:`, with safe defaults:

| Key | Default | Purpose |
|---|---|---|
| `allow_dispatch` | to decide (see §10) | master gate for the tool |
| `subagent_context_file` | `AGENTS-addition.md` | stable contract injected into each subagent |

Constants (documented, not configurable): max tasks 8, concurrency 4, output cap
50 KB per task.

`validate()` gains one check: when `allow_dispatch` is true, the
`subagent_context_file` must exist.

## 6. Prompt changes (implementation step only)

- `prompts/orchestrator.md`: when to dispatch (independent, read-heavy work —
  not dependent steps), the mandatory brief format, "the brief is the only task
  context", never paste the transcript, and compose the final answer from the
  returned results.
- `prompts/<agent>.md` (explorer, critic, implementer, delivery): a "context
  contract" header — brief plus injected project rules only, no prior
  conversation, may read files to expand.

## 7. Testability

- Factor `runDispatchTask(..., spawnFn = node:child_process.spawn)` and
  `buildDispatchArgs(...)` as exported seams.
- Smoke test with a fake `spawnFn` that emits JSON lines: assert the argv
  (`--no-session`, `--model`, `--append-system-prompt`, brief last), result
  aggregation, 50 KB truncation, and error propagation.
- Add the `validate()` context-file check to the smoke test.
- A real `pi`-subprocess end-to-end needs provider auth and cannot run in this
  workspace: report it as not run.

## 8. Milestones

| # | Milestone | Verifiable by |
|---|---|---|
| M1 | Config keys + `validate()` check + two-channel docs | smoke test |
| M2 | `runDispatchTask` / `buildDispatchArgs` / JSON parsing | fake-spawn tests |
| M3 | `harness-dispatch` tool registration (schema, execute, progress, widget, abort, errors) | fake-spawn tests |
| M4 | Prompt updates + docs (`AGENTS.md`, `WORKFLOW.md`) | review |
| M5 | Manual TUI end-to-end with a real dispatch | user-run, then tune |

Each milestone is independently testable and leaves the harness working.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spawning `pi` costs tokens / may be unavailable | opt-in gate, per-task error reporting |
| Cross-platform process invocation | reuse the subagent example's invocation logic |
| Weak curation (brief misses context) | enforced brief format; subagents keep read tools; brief lists unknowns |
| `harness.ts` grows too large | optional later refactor into `.pi/extensions/harness/{index,config,pipeline,dispatch}.ts` |
| Parallel calls hit provider rate limits | concurrency capped at 4; per-task error reporting |

## 10. Decisions (resolved)

1. `allow_dispatch` default: **`true`** — the tool stays registered; the prompt
   decides when to use it, and the gate allows disabling it per project.
2. Availability: **registered globally** and gated by `allow_dispatch`, with
   prompt guidance restricting it to orchestrator-style delegation.
   Per-agent tool mapping stays out of scope (the known `tools:` gap).
3. Subagent system prompt: **the agent template rendered (`{{task}}` = brief
   objective) plus `subagent_context_file`**; the full brief is the user message.
4. Document name: **kept `DISPATCH-PLAN.md`**.

## References

- Pi extension examples: `examples/extensions/subagent/index.ts` (parallel
  subprocesses, JSON parsing, progress rendering) and
  `examples/extensions/handoff.ts` (focused context transfer).
- Current sequential driver: `.pi/extensions/harness.ts` (`runPipeline`).
- Workflow modes: `harness.config.yaml` (`workflows:`) and `WORKFLOW.md`.
