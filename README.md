# pi-minimal-harness

A configuration-driven agent harness for [Pi](https://github.com/badlogic/pi-mono).
Work runs through a state machine that hands each step to an isolated agent with
only the context that step needs.

You write a configuration and a set of role prompts. The harness decides who
runs, what they see, when to loop, when to stop and when to ask you.

```bash
npx pi-minimal-harness init
```

## What it does

```
you ─▶ planner ─▶ explorer ─▶ implementer ─▶ reviewer ─▶ tester ─▶ deliverer
                   │                          ▲            │
                   │                          └── retry ────┘
                   ▼
             you approve
```

Each agent is a separate `pi` process with its own model, its own tools and its
own context. Nothing is inherited from a conversation, because there is no
conversation.

Two rules the runtime enforces rather than documents:

- **The planner cannot approve its own plan.** It declares the plan ready, the
  workflow suspends, and *you* decide. No agent result moves the workflow past
  `planning`.
- **An agent cannot choose its successor.** The result envelope has a closed
  shape; a field that is not part of the contract is rejected and named back.

## Requirements, and traceability

The planner maintains a requirements file with stable identifiers. Every other
role reports contradictions rather than editing it. Between them they form one
chain:

```
requirement → change → review → check → delivery
```

The deliverer refuses to ship while any link is missing — including a delivered
requirement that is not cited in the changelog.

## Commands

| Command | What it does |
|---|---|
| `/harness-run <task>` | Start a workflow |
| `/harness-answer <text>` | Answer one that is waiting for you |
| `/harness-config` | Show and validate the configuration |
| `/harness-model <agent>` | Choose a model and effort for one agent |
| `/harness-status` | Which phase the workflow is in, and why |

With `harness.auto_start` on, a plain message starts a workflow — unless one is
already waiting, in which case your message is the answer.

## Configuration

```yaml
harness:
  version: 2
  requirements_file: .harness/requirements.md
  max_retries: 3
  agent_timeout_ms: 600000
  auto_start: true
  subagent_context_file: pi-minimal-harness.md

agents:
  implementer:
    model: provider/model-id
    reasoning: high
    capabilities: [read, write, shell, vcs, github, memory]
```

Every key is read by the runtime. There are no documentation-only keys, and
`/harness-config` rejects anything it does not recognise — including a leftover
from an older version.

### Capabilities

| Capability | Enforced? | Becomes |
|---|---|---|
| `read` | yes | `read`, `find`, `grep`, `ls` |
| `write` | yes | `edit`, `write` |
| `shell` | yes | `bash` |
| `memory` | declared | `mem_*`; warns and degrades if absent |
| `graph` | declared | `codegraph_*`; degrades to `grep`/`rg` |
| `vcs` | declared | `git`; **requires** `shell` |
| `github` | declared | `gh`; **requires** `shell` |

Only the first three map to Pi tool names, because Pi's vocabulary is
`{read, bash, edit, write, find, grep, ls, powershell}`. What enforcement buys
is real, though: an agent without `shell` cannot run a single command.

`write` is a **capability boundary, not a sandbox**. Both the planner and the
implementer hold it, and those tools cannot be restricted to a path.

## When the workflow stops

It stops when it needs you: the plan is ready, an agent cannot decide something
alone, the retry budget is spent, or delivery is blocked. Every suspension says
which of those it is and exactly where it resumes — `retry_limit` returns to the
implementer, a question returns to whoever asked it.

## Layout

```
.pi/extensions/harness.ts     commands, hooks, footer
.pi/extensions/lib/           the machine: transitions, state, runner, driver
prompts/                      six role prompts
pi-minimal-harness.md         the contract, copied to adopters
MIGRATION.md                  moving a v1 project to v2
tests/                        seven suites, no framework
```

## Migrating from v1

The configuration format changed completely and cannot be edited into shape.
See [MIGRATION.md](MIGRATION.md).

## Tests

```bash
npm test
```

Seven suites, 463 checks plus 15 installer tests, no network, no model, no dependencies.

## Licence

MIT.