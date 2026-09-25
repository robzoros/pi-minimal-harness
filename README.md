# pi-minimal-harness

A minimal, configuration-driven **agent harness for [Pi](https://github.com/earendil-works/pi)**:
a multi-agent workflow (orchestrator → explorer → critic → implementer →
delivery) that the Pi runtime executes step by step, with per-agent models,
reasoning efforts, prompt templates, interactive slash commands, and
evidence-based reports.

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
| Pipeline driver | Steps run in order as separate turns: model + supported reasoning effort + prompt template switched per step |
| Question short-circuit | Questions end at the orchestrator (`HARNESS-DECISION: ANSWER_ONLY`); the rest never runs |
| Report guarantee | The final agent must end with `HARNESS-DONE`; otherwise the harness sends exactly one repair turn |
| Interactive commands | `/harness-config`, `/harness-mode`, `/harness-model` (model + effort), `/harness-run`, `/harness-delivery`, `/harness-auto` |
| Footer status | `harness: <mode> [· step] [· decision: …] · auto: on\|off` |
| Auto-harness | Plain (non-slash) requests run through the pipeline; `/harness-auto off` to disable |
| Background dispatch | `harness-dispatch` tool: independent tasks in isolated `pi` subprocesses with curated briefs |
| Installer | `npx pi-minimal-harness init` installs resources, prompts, delivery skill, local config, and the AGENTS.md contract |
| Tests | `node tests/harness.test.mjs` (92 checks) and `node tests/install.test.mjs` (3 installer tests) |

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
│   ├── orchestrator.md
│   ├── explorer.md
│   ├── critic.md
│   └── implementer.md
│   ├── delivery.md
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
   `/models` output** (never invent IDs), set each agent's supported reasoning
   effort, and set `defaults.workflow_mode`.
4. Start Pi in your project and run `/reload`.
5. Try it: `/harness-mode full-dry-run`, then a plain question (it should stop
   at the orchestrator), then `/harness-run "a small task"`.

## Automated project installation

Install this harness into an existing project with:

```bash
npx pi-minimal-harness init
```

The two commands have different effects:

| Command | Effect |
|---|---|
| `npx pi-minimal-harness init` | **Installs** the extension, prompts, delivery skill, `harness.config.yaml`, and the generic `AGENTS.md` contract. |
| `npx pi-minimal-harness init --project /path/to/project --dry-run` | **Only previews** the changes; it writes no files. |

The installer is idempotent: running it again does not duplicate the contract
or rewrite identical files. It refuses to overwrite conflicting files unless
`--force` is supplied.

The generated `harness.config.yaml` is treated as local configuration. When the
project is inside a Git repository, the installer adds it to the repository's
local `.git/info/exclude`, so model choices and workflow settings do not appear
in `git status` or travel with pushes. The versionable source template is
`harness.config.example.yaml`.

Other useful options:

```bash
# Install into a specific project
npx pi-minimal-harness init --project /path/to/project

# Replace conflicting generated files
npx pi-minimal-harness init --force

# Show the command help
npx pi-minimal-harness init --help
```

After installation, configure models in `harness.config.yaml`, run `/reload`,
and validate with `/harness-config`.

**Optional integrations** (both recommended, both independent of the harness):

- **Engram**: install the Engram binary on your `PATH`, then let its Pi helper
  configure the integration:

  ```bash
  pi install npm:gentle-engram
  pi install npm:pi-mcp-adapter
  pi-engram init
  ```

  Restart Pi (or run `/reload`) afterward. `pi-engram init` writes the package
  declarations to Pi's `settings.json` and the Engram MCP server to
  `~/.pi/agent/mcp.json`, including `engram mcp --tools=agent`; it also keeps
  MCP tools from duplicating Pi's native `mem_*` tools. The Engram binary itself
  must be installed separately. Normally you do not need to run `engram serve`:
  Engram starts it on demand. Use `pi-engram init --force` only to replace an
  existing Engram MCP entry. See [`AGENTS-addition.md`](AGENTS-addition.md) for
  the memory protocol.
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
    reasoning: medium            # effort supported by the selected model; off for non-reasoning models
    prompt_template: prompts/orchestrator.md
skills:
  project_directory: .agents/skills
  current: [github-delivery]
```

`/harness-model` reads Pi's live model catalog. After choosing a model, it asks
for an effort only among the levels exposed by that model's provider metadata;
non-reasoning models are saved as `reasoning: off`. After a successful
interactive change, the picker returns to the agent menu so several agents can
be configured in one session; choose `Cancel` there to return to the prompt.
Explicit argument forms remain one-shot operations. Model and effort are written
together, so cancelling or choosing an unsupported effort leaves the existing
configuration unchanged.

Validate any time with `/harness-config` → *Validate configuration* (checks
modes, agents, catalog model IDs, model-supported reasoning efforts, templates,
workflow steps, the contract file and the delivery skill).

Before starting a pipeline, the harness performs an advisory repository
preflight. It warns about uncommitted changes, an upstream branch that is ahead
or behind, and an open pull request when GitHub CLI is available. The warning
does not block the task; resolve or synchronize the repository when the warning
applies. `/harness-delivery` is intended for delivering the current verified
changes without changing `defaults.workflow_mode`.

## Commands and markers

| Command / marker | Meaning |
|---|---|
| `/harness-config` | Interactive menu: show, set mode, set model + effort, validate, explain |
| `/harness-mode [mode]` | Show or change `defaults.workflow_mode` |
| `/harness-model [agent [model-id [effort]]]` | Interactively change models/efforts for one or more agents; arguments are one-shot |
| `/harness-run <task>` | Force the pipeline for one task |
| `/harness-delivery [instructions]` | Run only the delivery agent without changing `defaults.workflow_mode` |
| `/harness-auto [on\|off]` | Plain requests → pipeline |
| `HARNESS-DECISION: ANSWER_ONLY\|PIPELINE` | Orchestrator's decision  |
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
- [`gentle-shell`](https://github.com/Gentleman-Programming/gentle-shell) de **Gentleman Programming** — the inspiration (not a fork; go look
  at it). 
- [`engram`](https://github.com/Gentleman-Programming/engram) comes from the same ecosystem:
  .
- CodeGraph — structural exploration for source trees.
