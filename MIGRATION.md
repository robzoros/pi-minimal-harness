# Migrating to pi-minimal-harness 2.0

Version 2 replaces the workflow engine. The configuration format changed
completely, and there is no automatic migration: the old file describes a
different system, not an older version of the same one.

## Before you start

**Back up your work.** There is a clean tree check before every workflow, but
`update` replaces files. Commit or stash first.

There is one prompt you may want to read: `prompts/orchestrator.md`, if you
carried it over from a v1 checkout. Version 2 has no LLM orchestrator — the
runtime is a state machine — so that file is removed.

## What changed

| | v1 | v2 |
|---|---|---|
| Workflow | Fixed list of steps per mode | State machine, transitions decided by the runtime |
| Agents | 5, with an LLM orchestrator | 6, none of them an orchestrator |
| Approval | The planner approved its own plan | The planner declares readiness; **the user approves** |
| Retries | None | One shared budget, configurable |
| Tools per agent | Prose in the prompt | `capabilities`, mapped to real tools where possible |
| Contract file | `pi-minimal-harness.md` | Unchanged |

## Migration

### 1. Update the harness

```bash
npx pi-minimal-harness update
```

This replaces the extension, the prompts, the delivery skill and
`pi-minimal-harness.md`, and adds the reference to your `AGENTS.md`. It leaves
your configuration alone, which is the point of the next step.

### 2. Replace your configuration

The old file cannot be edited into shape: its keys describe concepts that no
longer exist. Generate a fresh one:

```bash
rm harness.config.yaml
npx pi-minimal-harness init
```

You will get a v2 file with placeholder models. **Nothing works until you set
them**, because a step with no model cannot run.

### 3. Set the models

```bash
/harness-model planner
/harness-model explorer
/harness-model implementer
/harness-model reviewer
/harness-model tester
/harness-model deliverer
```

Or edit the file directly with identifiers in Pi's `provider/id` format. Do not
invent them; run `/models` to see what you actually have.

### 4. Check it

```bash
/harness-config
```

Every finding is either an error or a warning. Errors stop a workflow from
starting. Warnings about `memory` or `graph` mean those tools are not installed
in your runtime — the agent degrades to a documented fallback and says so.

### 5. Try it

```bash
/harness-run "a small, reversible change"
```

## What you lose, and what replaces it

| v1 | v2 | Notes |
|---|---|---|
| `defaults.workflow_mode` | — | One workflow now |
| `workflows.<mode>.steps` | — | The flow is fixed |
| `defaults.question_short_circuit` | — | The orchestrator is gone, so there is no decision to short-circuit |
| `defaults.strict_decision_marker` | — | Same |
| `defaults.allow_dispatch` | — | Agents always run as isolated processes |
| `defaults.preflight_policy` | — | The implementer checks repository state itself |
| `agents.*.mutates_files` | derived from `capabilities` | `write` means it mutates |
| `agents.*.tools` | `agents.*.capabilities` | Different vocabulary: `read`, `write`, `shell`, `memory`, `graph`, `vcs`, `github` |
| `agents.*.responsibilities` | — | The role lives in `prompts/<agent>.md` |
| `agents.*.prompt_template` | — | Prompts are at `prompts/<agent>.md` by convention |
| `commands.model_catalog_source` | — | Pi's registry is the catalog |
| `skills`, `project`, `allow_simple_mode`, `preferred_interface`, `fallback_interface` | — | Read nothing, ever |

New in v2: `harness.requirements_file`, `harness.agent_timeout_ms`,
`harness.version`.

## Two things that are enforced rather than documented

**The planner cannot approve.** It returns `ready_for_approval`, the workflow
suspends, and the user answers. No agent result moves the workflow past
`PLANNING` — it is a property of the transition table, not a rule in a prompt.

**An agent cannot choose its successor.** The result envelope has a closed
shape; a field that is not part of the contract is rejected and named back.

## Things worth knowing

**The requirements file is new.** The planner maintains it; every other role
reports contradictions to the orchestrator instead of editing it. Nothing else
writes it — but note that this is a role boundary, not a sandbox: the implementer
holds the same write tools and cannot be confined to a path.

**The workflow waits for you.** If an agent cannot decide something, or the
plan is ready, the run suspends and says so. Answer in the chat or with
`/harness-answer`.

**/harness-mode and /harness-delivery are gone.** There are no modes, and
delivery is a step rather than a mode. `/harness-status` shows where a run is.

## If something breaks

Run `/harness-config` first. Almost every failure is a missing model, an agent
the configuration does not define, or a capability combination that contradicts
itself.