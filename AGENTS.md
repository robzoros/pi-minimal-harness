# AGENTS.md — pi-minimal-harness

The operating contract for agents working **in this repository**: the source of
`pi-minimal-harness`, a configuration-driven agent harness published for other
projects.

**Read `pi-minimal-harness.md` for the contract itself.** This file is about
working on the harness, not about using it.

## What is here

| Path | Purpose |
|---|---|
| `pi-minimal-harness.md` | The contract. Copied verbatim to every adopting project |
| `harness.config.yaml` | This project's own v2 configuration. `harness.config.example.yaml` is the template `init` ships |
| `.pi/extensions/harness.ts` | The extension entry point: commands, hooks, footer. Thin by design |
| `.pi/extensions/lib/` | The harness proper — see below |
| `prompts/` | Six role prompts. Identity and method only |
| `.agents/skills/github-delivery/` | The shipped delivery skill |
| `MIGRATION.md` | How a v1 project moves to v2 |
| `tests/` | Node test suites, no framework, no dependencies |

## The shape of the system

The runtime is a **state machine**, not an agent. `lib/transitions.ts` is the
single source of truth for control flow, and it is pure data.

```
START → PLANNING ─┬─ complete ────────────────► DONE
                  ├─ ready_for_approval ──► SUSPENDED ─┬─ approve ──► EXPLORING
                  ├─ needs_input ─────────► SUSPENDED ─┬─ revise ──► PLANNING
                  └─ failed ───────────────► SUSPENDED ─┴─ answer ──► where it was
EXPLORING → IMPLEMENTING → REVIEWING → TESTING → DELIVERING → DONE
                                ▲              │             │
                                └──────────────┴─────────────┘   retry budget, shared
```

Two rules the table enforces, and which no prompt can override:

- **No agent result moves the workflow past `PLANNING`.** The planner declares
  a plan ready; the user approves it. The approval is a user event.
- **An agent cannot choose its successor.** The result envelope has a closed
  shape and unknown fields are rejected by name.

## The modules

| Module | Owns | Knows nothing about |
|---|---|---|
| `transitions.ts` | Every rule about control flow | Files, processes, models |
| `state.ts` | Applying a signal to a state | I/O |
| `result.ts` | The envelope: shape, per-phase verdicts | Agents |
| `escalation.ts` | Which doubts the runtime settles, which reach the user | Anything but topic names |
| `brief.ts` | The context one agent receives | The machine |
| `runner.ts` | Spawning a `pi` process, retries on failure | Workflow phases |
| `capabilities.ts` | Capability → Pi tool names | Agents, configuration |
| `config.ts` / `validate.ts` | Reading and checking the configuration | Everything else |
| `requirements.ts` / `changelog.ts` | The traceability chain | Agents |
| `suspend.ts` | Why a workflow stopped, and where it resumes | Why |
| `driver.ts` | The loop that ties the rest together | — |

The dependency direction is one-way: `driver → everything → transitions`.
Nothing in `lib/` imports `harness.ts`, and nothing imports Pi except a type
annotation.

## Language

Agents talk to **each other in English**, always — a brief written in two
languages is a worse brief. What the user reads is in their language: the
status line, the question a workflow asks, the notifications. The single
exception inside the envelope is the question, because the user reads that one.

## Verifying a change

```bash
npm test
```

Seven suites, no framework, no network, no model. Every command must be bounded:
a suite that spawns processes or contains a manual scan **will hang forever**
rather than fail, and a test that only reads strings will not notice a broken
extension.

Two suites exist because of shipped bugs:

- `tests/extension.test.mjs` imports `.pi/extensions/harness.ts` the way Pi
  does. Without it, a syntax error in the entry point ships with the whole suite
  green — it happened once, and Pi refused to load the extension.
- `tests/prompts.test.mjs` asserts that no prompt or contract restates runtime
  behaviour. A prompt that mentions a field name, a phase or a config key puts
  two sources of truth back into the project.

New modules get tests. **A new module with no test that imports it will break
in production, silently.**

## Rules

- The behaviour of the machine lives in `transitions.ts`. If a rule needs prose,
  it needs a row and a check, not a paragraph.
- Config keys are read or they are deleted. A key nothing reads is worse than
  absent: it looks enforced.
- Nothing outside `lib/` decides anything the machine should decide.
- Do not copy logic between the extension, the contract, the prompts and the
  README. Pick the layer and link.
- No new dependencies. The installer ships to other people's machines and the
  extension loads inside Pi.
- Documentation in English; user-facing strings follow the user.

## Before committing

`npm test` in green, `git status` showing only what you intended, and any check
you could not run stated plainly. TUI behaviour cannot be verified without
`/reload` in an interactive session — say so rather than implying it was tested.