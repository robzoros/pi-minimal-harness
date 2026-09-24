# pi-minimal-harness

A minimal, configuration-driven **agent harness for [Pi](https://github.com/earendil-works/pi)**:
a multi-agent workflow (orchestrator → explorer → critic → implementer →
delivery) that the Pi runtime executes step by step, with per-agent models,
prompt templates, interactive slash commands, and evidence-based reports.

Drop it into a Pi project, edit one YAML file, and your requests run through a
workflow you can actually audit.

## Inspiration

- **Inspired by `gentle-pi` (Gentleman Programming)** — this is **not a fork**
  of gentle-pi. If you are starting from zero, **use gentle-pi or at least look
  at it first**; it is a battle-tested, opinionated Pi workflow with a whole
  ecosystem around it. `pi-minimal-harness` is the stripped-down,
  YAML-configured alternative you take when you want the harness to be a
  handful of files you fully understand and can rewrite.
  <!-- TODO: confirm the gentle-pi repository URL before publishing -->
- **Why Engram**: persistent memory that survives sessions, compactions and
  agents. Local-first (one Go binary, SQLite + FTS5), a disciplined save/search
  protocol instead of stuffing raw context into the prompt, and one brain
  shared by every MCP-capable tool — the same reasons the inspired ecosystem
  uses it. Optional packages: [`gentle-engram`](https://www.npmjs.com/package/gentle-engram)
  + `pi-mcp-adapter`.
- **Why CodeGraph**: structural exploration on demand (callers, impact,
  affected tests) instead of guessing from grep. Used **selectively** — only
  when relationships matter; simple changes are read directly from source.

## What you get

| Piece | What it does |
|---|---|
| Workflow modes | `simple`, `full-dry-run`, `full`, `implementation-only`, `delivery-only` — ordered agent steps from one YAML |
| Pipeline driver | Steps run in order as separate turns: model + reasoning + prompt template switched per step |
| Question short-circuit | Questions end at the orchestrator (`HARNESS-DECISION: ANSWER_ONLY`); the rest never runs |
| Report guarantee | The final agent must end with `HARNESS-DONE`; otherwise the harness sends exactly one repair turn |
| Interactive commands | `/harness-config`, `/harness-mode`, `/harness-model`, `/harness-run`, `/harness-auto` |
| Footer status | `harness: <mode> [· step] [· decision: …] · auto: on\|off` |
| Auto-harness | Plain (non-slash) requests run through the pipeline; `/harness-auto off` to disable |
| Background dispatch | `harness-dispatch` tool: independent tasks in isolated `pi` subprocesses with curated briefs |
| Smoke tests | `node tests/harness.test.mjs` —73 checks, no network, no real config writes |

## Install in your Pi project

**Prerequisites:** Pi (tested with v0.87.x) and Node ≥22 (Pi runs the
extension with `jiti`; no build step, no `package.json` needed).

**Files to copy into the adopting project:**

```text
your-project/
├── .pi/
│   └── extensions/
│       └── harness.ts          # the whole harness (commands, driver, dispatch)
├── harness.config.yaml         # modes, agents, models, gates
├── prompts/                    # the five agent prompt templates
│   ├── orchestrator.md  explorer.md  critic.md
│   └── implementer.md  delivery.md
├── .agents/
│   ├── skills/
│   │   └── github-delivery/SKILL.md
│   └── harness/                # optional: extra design notes
├── tests/
│   └── harness.test.mjs        # optional but recommended
└── AGENTS.md                   # add the section from AGENTS-addition.md
```

**Steps:**

1. Copy the files above.
2. **Paste `AGENTS-addition.md` into your project's `AGENTS.md`** (or reference
   it / use `.pi/APPEND_SYSTEM.md` — the two options are explained at the top
   of that file). Keep `subagent_context_file: AGENTS-addition.md` in the
   config if you keep the file under that name.
3. Edit `harness.config.yaml`: set `project:`, pick models **from Pi's
   `/models` output** (never invent IDs), and set `defaults.workflow_mode`.
4. Start Pi in your project and run `/reload`.
5. Try it: `/harness-mode full-dry-run`, then a plain question (it should stop
   at the orchestrator), then `/harness-run "a small task"`.

**Optional integrations** (both recommended, both independent of the harness):

- **Engram**: install the `gentle-engram` and `pi-mcp-adapter` packages in
  Pi's `settings.json`, register `engram mcp --tools=agent` in
  `~/.pi/agent/mcp.json`, and run `engram serve`. See
  [`AGENTS-addition.md`](AGENTS-addition.md) for the memory protocol.
- **CodeGraph**: `npm i -g codegraph`, then `codegraph init --cwd <repo root>`
  in the project.

## Configuration reference

`harness.config.yaml` (line-oriented YAML; the extension preserves your
formatting when it edits):

```yaml
project: my-project
defaults:
  workflow_mode: simple          # simple | full-dry-run | full | implementation-only | delivery-only
  auto_harness: true             # plain requests run through the pipeline
  question_short_circuit: true   # orchestrator's ANSWER_ONLY stops the pipeline
  allow_dispatch: true           # enable the harness-dispatch tool
  subagent_context_file: AGENTS-addition.md   # injected into dispatched subagents
workflows:
  full: { steps: [orchestrator, explorer, critic, implementer, delivery] }
agents:
  orchestrator:
    model: provider/model-id     # exact id from /models
    reasoning: medium            # minimal | low | medium | high | xhigh | max
    prompt_template: prompts/orchestrator.md
skills:
  project_directory: .agents/skills
  current: [github-delivery]
```

Validate any time with `/harness-config` → *Validate configuration* (checks
modes, agents, models, templates, workflow steps, the contract file and the
delivery skill).

## Commands and markers

| Command / marker | Meaning |
|---|---|
| `/harness-config` | Interactive menu: show, set mode, set model, validate, explain |
| `/harness-mode [mode]` | Show or change `defaults.workflow_mode` |
| `/harness-model [agent model-id]` | Pick an agent's model from Pi's catalog |
| `/harness-run <task>` | Force the pipeline for one task |
| `/harness-auto [on\|off]` | Plain requests → pipeline |
| `HARNESS-DECISION: ANSWER_ONLY\|PIPELINE` | Orchestrator's decision (moved to the footer, not shown in the answer) |
| `HARNESS-DONE` | Mandatory last line of every non-orchestrator agent reply |

## Skills

[Skills](https://github.com/earendil-works/pi) are Markdown procedures Pi loads
when a task matches their description — they keep instructions out of context
until needed.

- **Shipped:** `.agents/skills/github-delivery/SKILL.md` — delivers verified
  work through GitHub: branch → Conventional Commit → push → PR with issue
  linkage and one `type:*` label. Invoke it explicitly with
  `/skill:github-delivery`, or let Pi auto-invoke it when you ask to deliver.
- **Usage:** a skill is a directory with `SKILL.md` (frontmatter `name` +
  `description`). The description decides when the model loads it — state both
  what it does and when it applies.
- **Add your own:** `.agents/skills/<name>/SKILL.md`. Create one only for
  recurring procedures with safety or ordering constraints; the harness
  validates that `github-delivery` exists (the delivery agent depends on it).

## Documentation map

- [`AGENTS-addition.md`](AGENTS-addition.md) — the contract you add to your
  project's `AGENTS.md` (harness rules, memory, CodeGraph, verification,
  skills) and the two adoption strategies.
- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — agent roles, modes and the
  configuration shape in depth.
- [`docs/DISPATCH-PLAN.md`](docs/DISPATCH-PLAN.md) — background dispatch design
  (milestones M1–M4 implemented; M5 = manual end-to-end).
- [`CHANGELOG.md`](CHANGELOG.md) — releases.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Pi](https://github.com/earendil-works/pi) — the agent runtime this harness
  extends.
- **gentle-pi / Gentleman Programming** — the inspiration (not a fork; go look
  at it). Engram comes from the same ecosystem:
  [`gentle-engram`](https://www.npmjs.com/package/gentle-engram).
- CodeGraph — structural exploration for source trees.
