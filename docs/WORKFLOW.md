# pi-minimal-harness Workflow

## Purpose

Define the multi-agent workflow used by pi-minimal-harness.

The workflow must help with complex tasks without making simple changes
unnecessarily heavy.

The workflow is intended to be executed from Pi agent. It should rely on files,
prompts, configuration, skills, and Pi task orchestration rather than an
external API service.

## Full Workflow

```text
User requests task
      |
      v
[1] Orchestrator analyzes the request and creates the next-agent prompt
      |
      v
[2] Explorer agent investigates possible solutions
      |
      v
[3] Critic agent reviews, improves, and challenges the plan
      |
      v
[4] Implementer agent performs the change
      |
      v
[5] GitHub delivery agent creates branch, commit, push, and pull request
      |
      v
Pull request
```

## Agent Roles

### 1. Orchestrator

The orchestrator receives the user's request and turns it into a task prompt for
the next agent.

Responsibilities:

- classify the task;
- choose the workflow mode;
- decide whether OpenSpec is needed;
- decide whether Engram should be queried;
- decide whether structural code exploration is useful;
- create the prompt for the explorer or implementer;
- preserve the user's intent without over-expanding the task.

Expected output:

- selected workflow mode;
- task summary;
- constraints;
- relevant context requests;
- next-agent prompt.

### 2. Explorer Agent

The explorer investigates possible solutions before implementation.

Responsibilities:

- read relevant repository files;
- check applicable `AGENTS.md` rules;
- consult OpenSpec when relevant;
- use CodeGraph/CodeCraft when structural exploration helps;
- query Engram when previous knowledge may matter;
- identify likely affected files and tests;
- propose an implementation approach.

Expected output:

- exploration report;
- relevant files and symbols;
- applicable rules;
- risks;
- recommended approach;
- likely tests/checks.

### 3. Critic Agent

The critic reviews the explorer's output and looks for improvements.

Responsibilities:

- challenge assumptions;
- identify missing constraints;
- suggest simpler approaches;
- detect possible regressions;
- decide whether the task scope is too broad;
- confirm whether OpenSpec or additional exploration is needed.

Expected output:

- improvement notes;
- risks or blockers;
- recommended refinements;
- approval to implement or request for more exploration.

### 4. Implementer Agent

The implementer performs the code change.

Responsibilities:

- apply the approved plan;
- respect the working tree;
- keep the change scoped;
- run focused checks and tests;
- inspect the diff;
- record stable learnings for Engram when appropriate.

Expected output:

- changed files;
- implementation summary;
- tests/checks run;
- unresolved risks;
- Engram memory candidates.

### 5. GitHub Delivery Agent

The delivery agent turns verified local work into a pull request.

Responsibilities:

- check repository status;
- create an appropriately named branch;
- stage the intended files only;
- create the commit;
- push the branch;
- create or update the pull request;
- include issue linkage and test evidence when required.

Expected output:

- branch name;
- commit hash;
- pull request URL;
- delivery notes.

## Workflow Modes

### Full

Use for non-trivial behavior, architecture, persistence, workflow, or
cross-cutting changes.

Steps:

```text
orchestrator -> explorer -> critic -> implementer -> delivery
```

### Full Dry Run

Use for non-trivial tasks when the user wants exploration and critique
without editing files.

Steps:

```text
orchestrator -> explorer -> critic
```

### Simple

Use for small and clear changes.

Steps:

```text
orchestrator -> implementer
```

The orchestrator must explicitly state why the full workflow is unnecessary.

### Implementation Only

Use when exploration and critique have already happened, or the user provides a
complete plan.

Steps:

```text
orchestrator -> implementer
```

### Delivery Only

Use when changes already exist locally and the task is only to create the
branch, commit, push, and pull request.

Steps:

```text
orchestrator -> delivery
```

## Configuration Shape

The harness must allow each role to use a different model, reasoning effort,
tool set, and instruction profile. Model and effort remain separate settings so
the same model can be reused by agents that need different amounts of work.

Agent configuration is mandatory for every role. A workflow must not assume that
all agents use the same model or the same tools.

Example:

```yaml
agents:
  orchestrator:
    model: gpt-5.1
    reasoning: medium
    tools:
      - filesystem
      - engram
    prompt_template: prompts/orchestrator.md

  explorer:
    model: gpt-5.1
    reasoning: high
    tools:
      - filesystem
      - openspec
      - engram
      - codegraph
    prompt_template: prompts/explorer.md

  critic:
    model: gpt-5.1-mini
    reasoning: medium
    tools:
      - filesystem
      - openspec
    prompt_template: prompts/critic.md

  implementer:
    model: gpt-5.1
    reasoning: high
    tools:
      - filesystem
      - shell
      - tests
      - engram
    prompt_template: prompts/implementer.md

  delivery:
    model: gpt-5.1-mini
    reasoning: low
    tools:
      - git
      - github
    skills:
      - github-delivery
    prompt_template: prompts/delivery.md
```

The configuration should support overrides per task. For example, a risky
database migration may use a stronger model for the critic and implementer,
while a small copy change may use simple mode with a cheaper implementer model.

## Pi Slash Command Interface

The harness should be configurable from Pi with slash commands.

Desired commands:

```text
/harness mode
/harness mode simple
/harness mode full-dry-run
/harness mode full
/harness mode implementation-only
/harness mode delivery-only

/harness models
/harness model set orchestrator <model-id> [effort]
/harness model set explorer <model-id> [effort]
/harness model set critic <model-id> [effort]
/harness model set implementer <model-id> [effort]
/harness model set delivery <model-id> [effort]

/harness config show
/harness config validate
/harness run "<task>"
```

Model selection must use Pi's available model list. The operator should run
`/models` first, then choose one of the returned model identifiers. The harness
must not invent model IDs or silently substitute another model.

After selecting a model, the harness must ask for one of the reasoning efforts
supported by that model according to Pi's catalog metadata. It writes the model
and `agents.<agent>.reasoning` atomically, rejects unsupported combinations, and
stores `off` for a model without reasoning. After a successful interactive
selection, the agent menu is shown again so multiple agents can be configured;
`Cancel` exits the picker. Pipeline execution and background dispatch must
validate the same combination before applying it.

Native project commands are registered by `.pi/extensions/harness.ts`:
`/harness-config`, `/harness-mode`, `/harness-model`, `/harness-run` and
`/harness-auto`. The former skill fallbacks (`/skill:harness-*` and
`$harness-*`) no longer exist; use the native commands.

The command interface is a thin layer over `.agents/harness/harness.config.yaml`
and the workflow files. It should update configuration, not duplicate it.

## Pi Execution Layout

The adopting repository should keep Pi-facing harness files separate from
product documentation:

```text
your-project/
├── AGENTS.md
├── .agents/
│   └── skills/
│       └── github-delivery/
│           └── SKILL.md
└── .pi/
    └── harness/
        ├── harness.config.yaml
        ├── workflows/
        │   ├── full.yaml
        │   ├── simple.yaml
        │   ├── implementation-only.yaml
        │   └── delivery-only.yaml
        └── prompts/
            ├── orchestrator.md
            ├── explorer.md
            ├── critic.md
            ├── implementer.md
            └── delivery.md
```

`.agents/skills` contains shared project procedures. `.pi/harness` contains
Pi-specific runtime configuration and prompts.

If `.pi/` is local runtime state in the real repository, use a tracked
alternative such as `.agents/harness/` for shared harness files and let Pi copy
or reference them at runtime. The important boundary is that these files do not
replace the target project's product README or application docs.

## Skills

Create a project skill when a repeated procedure is important enough that the
agent should not rediscover it each time.

Good skill candidates:

- harness configuration;
- harness model selection;
- harness execution;
- GitHub delivery;
- SQLite migrations;
- release preparation;
- export pipeline changes;
- editor persistence changes;
- cross-platform filesystem changes.

Skills should live in `.agents/skills/<skill-name>/SKILL.md` when they are
shared project knowledge. They should be small, procedural, and focused on how
to perform one recurring operation safely.

The GitHub delivery agent should use the `github-delivery` skill.

The Pi configuration commands should use the `harness-config` skill. Model
selection (model and reasoning effort) should use the `harness-model` skill.
The Pi run commands should use the `harness-run` skill.

## Memory Policy

Engram may be read by the orchestrator, explorer, or implementer when previous
project knowledge is likely to matter.

Engram writes should be explicit and selective. Store stable knowledge, not
transcripts or temporary progress.
