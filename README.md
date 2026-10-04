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
| Workflow modes | `full`, `full-dry-run`, `analysis` — ordered agent steps from one YAML |
| Pipeline driver | Steps run in order as separate turns: model + supported reasoning effort + prompt template switched per step |
| Router | The orchestrator sends a question or an idea to the `analysis` workflow (`orchestrator -> architect`), and a closed requirements contract down `full` |
| Report guarantee | Every step that owes a report calls `harness_report` with all its fields (fallback: ends with `HARNESS-DONE`); an incomplete report earns one repair turn per step, and the pipeline stops if it is still incomplete |
| Control tools | `harness_decision` and `harness_report` replace the textual markers as the primary signal; the markers stay as a one-release fallback |
| Interactive commands | `/harness-config`, `/harness-mode`, `/harness-model` (model + effort), `/harness-run`, `/harness-resume`, `/harness-delivery`, `/harness-auto` |
| Footer status | `harness: <mode> [· step] [· decision: …] · auto: on\|off` |
| Auto-harness | Plain (non-slash) requests run through the pipeline; `/harness-auto off` to disable |
| Background dispatch | `harness-dispatch` tool: independent tasks in isolated `pi` subprocesses with curated briefs; each subagent's system prompt is its own prompt template, its declared project skills, the harness contract and the project's `AGENTS.md` (when present, read last so project rules win) |
| Installer | `npx pi-minimal-harness init` installs resources, prompts, delivery skill, local config, and the AGENTS.md contract |
| Upgrade | `npx pi-minimal-harness update` refreshes upstream files and **only adds** missing keys to your config |
| Tests | `node tests/harness.test.mjs` (196 checks) and `node tests/install.test.mjs` (15 installer tests) |

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
├── pi-minimal-harness.md       # the harness contract (AGENTS.md points at it)
└── AGENTS.md                   # your rules + the reference to the contract
```

**Steps:**

1. Copy the files above.
2. **Point your project's `AGENTS.md` at `pi-minimal-harness.md`** by adding
   the reference the installer writes (or let `npx pi-minimal-harness init`
   write it for you):

   ```markdown
   ## pi-minimal-harness instructions
   * **Harness Rules:** Read pi-minimal-harness.md and strictly follow its guidelines for this project's harness.
   * **Conflict Resolution:** If any rules in AGENTS.md conflict with pi-minimal-harness.md, the rules in AGENTS.md take precedence.
   ```

   The contract is a file of its own, not a section pasted into `AGENTS.md`:
   `update` replaces it wholesale, and a paste would be lost on the next
   upgrade. Dispatched subagents get it from the first file that exists, in this
   order: `defaults.subagent_context_file`, `pi-minimal-harness.md`, an
   `AGENTS.md` that carries the harness block, then a legacy
   `AGENTS-addition.md`. Leave the key unset and every variant works.
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

The commands differ in effect:

| Command | Effect |
|---|---|
| `npx pi-minimal-harness init` | **Installs** the extension, prompts, delivery skill, `harness.config.yaml`, and the `AGENTS.md` contract. |
| `npx pi-minimal-harness init --dry-run` | **Only previews** the changes; it writes no files. |
| `npx pi-minimal-harness update` | **Upgrades** an installation: refreshes what Pi runs and only adds missing config keys. |

`init` is for a project that does not have the harness yet. Running it on one
that does still works — it is idempotent and additive — but it is not an
upgrade, so the report says so and names `update`. The only two situations that
make an installer command stop are worth knowing:

- a **conflict** in a file the harness owns: refused, with `--force` or
  `update` named in the message;
- an `AGENTS.md` whose `## Harness workflow` section has been **edited by
  hand**: refused, and the file is left byte-for-byte untouched, `--force`
  included. A contract that is present but unmodified — pasted without the
  installer markers, which is the documented adoption path — is recognised as
  present and never rewritten.

A fresh install ships the template's placeholders, and the report says so
loudly rather than leaving it in a "Next steps" line nobody reads:

```text
  warning 5 agent(s) still use the template model placeholder (model: provider/model-id)
  warning project: is still the template placeholder (project: my-project)
```

`/harness-config` fails until the models come from Pi's `/models` output.

The installer is idempotent: running it again does not duplicate the contract
or rewrite identical files. It refuses to overwrite conflicting files unless
`--force` is supplied. Your `harness.config.yaml` is never overwritten: it is
created from `harness.config.example.yaml` when missing and otherwise merged
additively, so a new upstream key is added and your values are kept.

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

## Upgrade an existing installation

```bash
cd /path/to/project
npx --yes pi-minimal-harness@latest update
```

Pass `--project /path/to/project` to update a project without changing
directory; without it `update` works on the current directory.

`update` replaces everything Pi executes — the extension, the prompts, the
delivery skill and the `AGENTS.md` contract block — and **only adds** the keys
a newer release introduced to your `harness.config.yaml`. It never overwrites a
value you set, never removes a key and never rewrites a YAML sequence. The
guarantee in one line: *update replaces what Pi runs and only adds keys to your
configuration*.

```text
  add defaults.preflight_policy in harness.config.yaml
  added 1 key(s) to harness.config.yaml (existing values untouched)
  backup harness.config.yaml.bak
```

Preview it first with `update --dry-run`, which lists every addition and writes
nothing. When at least one key is added, the previous config is kept as
`harness.config.yaml.bak` (excluded from Git together with the config); when
nothing is missing, no backup is written. The new keys arrive with the
template's default values, so run `/reload` in Pi to load the updated extension
and prompts, then `/harness-config` to review and validate the configuration.
`update` needs no flags: it always refreshes upstream-owned files.

**Optional integrations** (both recommended, both independent of the harness):

- **Engram**: install the Engram binary, then let its Pi helper configure the
  integration:

  ```bash
  pi install npm:gentle-engram
  pi install npm:pi-mcp-adapter
  ```

  The helper `pi-engram` is **not on your `PATH`**: `pi install` puts it in
  npm's private `node_modules/.bin`, which npm only adds to `PATH` for scripts
  run inside that package, so the shims of Pi packages never reach the system
  `PATH`. Call it by path:

  ```bash
  # Git Bash, macOS or Linux
  ~/.pi/agent/npm/node_modules/.bin/pi-engram init

  # PowerShell on Windows
  & "$env:USERPROFILE\.pi\agent\npm\node_modules\.bin\pi-engram.cmd" init

  # equivalent, without the shim
  node "$HOME/.pi/agent/npm/node_modules/gentle-engram/cli.js" init
  ```

  Do not reach for `npx pi-engram`: the package is `gentle-engram` and
  `pi-engram` is only its binary name, so `npx` would look for a package of that
  name in the registry. If you prefer the bare command, add
  `~/.pi/agent/npm/node_modules/.bin` to your `PATH`; the paths above keep
  working even if that directory moves.

  Restart Pi (or run `/reload`) afterward. The helper writes the package
  declarations to Pi's `settings.json` and the Engram MCP server to the agent
  directory, including `engram mcp --tools=agent`; it also keeps
  MCP tools from duplicating Pi's native `mem_*` tools. The Engram binary
  itself must be installed separately; when it is not on your `PATH`, set
  `ENGRAM_BIN` to its absolute path instead. Normally you do not need to run
  `engram serve`: Engram starts it on demand. Use `--force` to replace an
  existing Engram MCP entry. See [`pi-minimal-harness.md`](pi-minimal-harness.md)
  for the memory protocol.

  The adapter reads its own `~/.pi/agent/mcp-adapter.json`
  (`%USERPROFILE%\.pi\agent\mcp-adapter.json` on Windows). Helper versions that
  still write the legacy `mcp.json` next to it put the entry in a file whose
  `mcpServers` may be owned by Pi's built-in MCP; if the helper put it there,
  move that entry to `mcp-adapter.json` (same shape as the CodeGraph example
  below).
- **CodeGraph**: install the CLI, then index the repository:

  ```bash
  npm i -g codegraph
  cd /path/to/project && codegraph init
  ```

  `codegraph init` indexes the current repository; `codegraph init --cwd <repo
  root>` does the same for an explicit root. The index lives in `.codegraph/` at
  the repository root and must not be committed.

  Then register the server in the MCP adapter's own config file,
  `~/.pi/agent/mcp-adapter.json` (`%USERPROFILE%\.pi\agent\mcp-adapter.json` on
  Windows) — that is the adapter's file, **not** `mcp.json` — adding the entry
  under `mcpServers`:

  ```json
  {
    "mcpServers": {
      "codegraph": {
        "command": "codegraph",
        "args": ["serve", "--mcp"],
        "directTools": false,
        "lifecycle": "lazy"
      }
    }
  }
  ```

  `directTools: false` keeps the tools behind the adapter's namespace instead of
  exposing them directly, the same as Engram, and `lifecycle: "lazy"` starts the
  server on first use (the other accepted values are `eager`, `keep-alive` and
  `lazy-keep-alive`). Run `/reload` after editing the file to connect. CodeGraph
  is the tool the `explorer` agent uses, so it is only worth configuring when
  structural exploration is part of your workflow.

## Configuration reference

`harness.config.yaml` (line-oriented YAML; the extension preserves your
formatting when it edits):

```yaml
project: my-project
defaults:
  workflow_mode: full             # full | full-dry-run | analysis
  auto_harness: true             # plain requests run through the pipeline
  analysis_routing: true         # the orchestrator's ANSWER_ONLY routes to the architect
  requirements_file: REQUIREMENTS.md  # where the architect keeps the formal scope
  allow_dispatch: true           # enable the harness-dispatch tool
                                   # subagent contract: defaults.subagent_context_file
                                   # if it exists, else pi-minimal-harness.md,
                                   # else an AGENTS.md carrying the harness block
  strict_decision_marker: true   # stop when the orchestrator emits no decision
  preflight_policy: advisory     # advisory | blocking (blocking gates file-mutating steps)
workflows:
  full: { steps: [orchestrator, explorer, critic, implementer, delivery] }
agents:
  orchestrator:
    model: provider/model-id     # exact id from /models
    reasoning: medium            # effort supported by the selected model; off for non-reasoning models
    mutates_files: false         # may this step modify files? (gates preflight_policy)
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

## Control tools

The harness asks its agents two questions — *does this task need file changes?*
and *did this step finish its report?* — through tools instead of conventions
in free text, so the answer is recorded by the call itself rather than parsed
out of a reply:

| Tool | Called by | Arguments |
|---|---|---|
| `harness_decision` | the orchestrator step, once at the end of the turn | `decision` (`ANSWER_ONLY` or `PIPELINE`, case-insensitive), `reason` |
| `harness_report` | every step that owes a report, once at the end of the turn | `changed_files`, `checks` (`{ command, result }` with `passed` / `failed` / `skipped`), `notes` (`""` when there is nothing), `lessons` (findings worth reusing; `[]` when there are none), and `verdict` for the critic (`PROCEED` / `PROCEED WITH CHANGES` / `BLOCKED`) |

All four fields are required: a report that omits one is incomplete and gets
the same single repair turn a missing report gets (`[]` for an empty list, `""`
for empty notes). The `HARNESS-DONE` marker cannot be inspected, so it always
counts as complete. A `BLOCKED` verdict from the critic stops the pipeline
before the file-mutating steps, and the critic report becomes the final answer.

Both are inert outside a running pipeline, and an unusable argument makes the
call fail instead of being silently ignored. When a tool call and a textual
marker disagree, the tool wins. The markers (`HARNESS-DECISION`,
`HARNESS-DONE`) remain supported as a fallback for one release.

Before starting a pipeline, the harness performs a repository preflight. It
warns about uncommitted changes, an upstream branch that is ahead or behind,
and an open pull request when GitHub CLI is available. Set
`defaults.preflight_policy: blocking` to make the risky states *stop* the first
step marked `mutates_files: true` (uncommitted changes and an open pull
request; branch divergence stays a warning, because pulling is your call). In
`blocking` mode the operator is asked once — and without a TUI the step is
blocked and reported as an error rather than continuing silently. Unmarked
agents are assumed to mutate files; `/harness-config` validation lists them.
`/harness-delivery` is intended for delivering the current verified changes
without changing `defaults.workflow_mode`.

## When a pipeline stops with steps left

A step whose turn ends in a model error is retried once, and the retry is
announced. If the run still stops with steps remaining — an error that outlived
its retry, an abort, a missing report — the harness records the mode, the task,
the steps that completed and the step it stopped on, and names two ways forward:

- `/harness-resume` continues from the step after the last completed one. It
  does not re-run them, and specifically does not re-run the orchestrator, which
  would re-derive the task from scratch and lose the issue the original run
  carried. A resumed step is told which steps already completed.
- `/harness-delivery` runs the delivery agent alone on what is already
  verified.

While such a stop is recorded, a plain message is **not** started as a new
pipeline: the harness reports the stopped step and points at both exits. Both
exits clear the record, so this never leaves the session stuck. A forced
`/harness-run` is a third exit — it starts a new task from the first step — so it
abandons the stopped run, says so, and clears the record rather than letting the
new run overwrite it. With `defaults.auto_harness: false` the harness only
*reports* the stop and lets the message through to the model, because that
message is the user's and nothing would have replaced it with a pipeline. A run
that finishes normally, answers directly (`ANSWER_ONLY`) or is blocked by the
critic records nothing, because those are finished runs rather than
interruptions.

The record is written with `pi.appendEntry()` and read back from the active
branch, so it survives `/reload` and never enters the model context. A resume
is exempt from the blocking preflight: the uncommitted state that gate refuses
is, on a resume, the very work the run stopped on. The advisory warning is
unaffected, so a dirty tree is never hidden.

## Commands and markers

| Command / marker | Meaning |
|---|---|
| `/harness-config` | Interactive menu: show, set mode, set model + effort, validate, explain |
| `/harness-mode [mode]` | Show or change `defaults.workflow_mode` |
| `/harness-model [agent [model-id [effort]]]` | Interactively change models/efforts for one or more agents; arguments are one-shot |
| `/harness-run <task>` | Force the pipeline for one task |
| `/harness-delivery [instructions]` | Run only the delivery agent without changing `defaults.workflow_mode` |
| `/harness-resume [note]` | Continue the pipeline that stopped with steps left, from the step after the last completed one. `/harness-resume`, `/harness-delivery` and `/harness-run` all consume the recorded stop |
| `/harness-validate [note]` | Approve the architect's proposal: it writes the agreed content to the requirements file and **keeps the design session open** |
| `/harness-end` | Close the design session; the next plain message is routed by the orchestrator again. An architect step opens it implicitly — the user, never a model, closes it |
| `/harness-auto [on\|off]` | Plain requests → pipeline |
| `HARNESS-DECISION: ANSWER_ONLY\|PIPELINE` | Orchestrator's decision, on the last line of its reply — fallback for when `harness_decision` is unavailable |
| `HARNESS-DONE` | Fallback completion marker for every non-orchestrator agent reply |

## Skills

[Skills](https://github.com/earendil-works/pi) are Markdown procedures Pi loads
when a task matches their description — they keep instructions out of context
until needed.

- **Shipped:** `.agents/skills/github-delivery/SKILL.md` — delivers verified
  work through GitHub: branch → Conventional Commit → push → PR with issue
  linkage and one `type:*` label. Invoke it explicitly with
  `/skill:github-delivery`, or let Pi auto-invoke it when you ask to deliver.
- **Injected when declared:** an agent's `skills:` list is not decorative. The
  harness reads each `.agents/skills/<name>/SKILL.md` and injects its content
  into that step's message, and into the system prompt of any dispatched
  subagent for that agent. `/harness-config` validation fails when a declared
  skill file is missing.
- **Usage:** a skill is a directory with `SKILL.md` (frontmatter `name` +
  `description`). The description decides when the model loads it — state both
  what it does and when it applies.
- **Add your own:** `.agents/skills/<name>/SKILL.md`. Create one only for
  recurring procedures with safety or ordering constraints; the harness
  validates that `github-delivery` exists (the delivery agent depends on it).

## Documentation map

- [`pi-minimal-harness.md`](pi-minimal-harness.md) — the contract installed
  in your project (harness rules, memory, CodeGraph, verification, skills);
  your `AGENTS.md` only points at it and wins any conflict.
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
