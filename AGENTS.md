# AGENTS.md — pi-minimal-harness

Operating contract for agents working **in this repository**, the source of the
`pi-minimal-harness` project: a minimal, configuration-driven agent harness for
the Pi coding agent, published for use in other people's projects.

## What this repository contains

| Path | Purpose |
|---|---|
| `README.md` | Public front door: inspiration, install, configuration, commands, skills. |
| `pi-minimal-harness.md` | The generic harness contract, copied verbatim to the root of every adopting project and pointed at from their `AGENTS.md`. |
| `harness.config.yaml` | Single source of truth: `defaults` (mode, auto-harness, short-circuit, dispatch gate, contract file), `commands`, `workflows` (mode → agent steps), `agents` (model, reasoning, tools, prompt template), `skills`. |
| `.pi/extensions/harness.ts` | The Pi extension: `/harness-*` commands, footer status, auto-harness input hook, pipeline driver, validation, dispatch tool, and the control tools (`harness_decision`, `harness_report`, `harness_session`). |
| `prompts/` | Per-agent prompt templates referenced by `harness.config.yaml`. |
| `.agents/skills/github-delivery/` | The shipped project skill (branch → commit → push → PR). |
| `docs/WORKFLOW.md`, `docs/DISPATCH-PLAN.md` | Design documentation (roles/modes/config shape; background dispatch plan). |
| `tests/harness.test.mjs`, `tests/install.test.mjs` | Node smoke tests. |
| `CHANGELOG.md`, `LICENSE` | Keep a Changelog + MIT. |

There is **no** `package.json` and no `src/`: the adopting application's
lint/test/cargo gates do not apply here. A git repository exists but has no
commits or remote yet (delivery requires deciding `.gitignore` policy first).

## How the harness works

- A workflow mode selects an ordered list of agent steps (`workflows.<mode>`).
  There are three: `full` (the technical flow through GitHub delivery),
  `full-dry-run` (explore, critique and simulate implementation without
  mutating files) and `analysis` (the interactive `orchestrator -> architect`).
- For each step the extension switches to that agent's model and reasoning level,
  renders `prompts/<agent>.md` as a short pointer (template bodies never enter
  the transcript) and sends it as the next turn; the runtime sequences the
  steps, so the model cannot skip them.
- The orchestrator is a **router**, not a worker. It declares its route with the
  `harness_decision` tool, once at the end of its turn: `ANSWER_ONLY` when the
  task is a question, an idea or anything needing conceptual design, which
  **switches the pipeline to the `analysis` workflow** and hands the turn to the
  architect; `PIPELINE` when it is a closed requirements contract, which runs
  the configured mode. `defaults.analysis_routing: false` restores the older
  behaviour in which `ANSWER_ONLY` ended the pipeline after the orchestrator.
  The textual marker `HARNESS-DECISION:` on the last line remains a fallback;
  the tool wins when both are present. The marker counts only on the last
  non-empty line, and both variants on that line are ambiguous.
  `defaults.strict_decision_marker` makes a turn with no usable decision stop
  the pipeline instead of reading its absence as `PIPELINE`.
- `defaults.auto_harness` sends plain (non-slash) requests through the pipeline.
- The **architect** converses with the user and maintains the formal
  requirements in `defaults.requirements_file` (created by `init`/`update` when
  missing, in the shape `defaults.requirements_format` chooses). It writes that
  file **only when the user approves**, with `/harness-validate`. It opens its
  multi-turn session with `harness_session(START)`; only the user closes it,
  with `/harness-end` — no model action closes a session, so an ordinary
  question gets one architect turn instead of trapping the user in one.
  Approving is not finishing: `/harness-validate` leaves the session open,
  because the next requirement may need the context of this conversation.
  While the session is open, the user's next plain messages go straight to the
  architect and skip the orchestrator. Slash commands are never intercepted.
- The driver checks every step's report: a complete `harness_report` call
  (`changed_files`, `checks`, `notes`, `lessons` all present, `[]` for a
  genuinely empty one) satisfies it, and the textual marker `HARNESS-DONE` is
  the fallback — it cannot be inspected, so it always counts. A missing or
  incomplete report gets exactly one repair turn for that step, naming the
  missing field, and stops the pipeline if it is still incomplete. A direct
  answer (`ANSWER_ONLY`) needs no report and is never repaired. A report the
  orchestrator happened to send is cleared before the next step, so it can
  never stand in for that step's own report.
- The orchestrator's `HARNESS-DECISION` marker is stripped from the reply and
  shown in the footer instead (`decision: …`). For questions the footer ends at
  `1/1 <agent>`; during step 1 the total is shown only once the decision is known.
- The `harness-dispatch` tool runs independent tasks in isolated `pi`
  subprocesses with a curated brief; gated by `defaults.allow_dispatch` and by
  the subagent contract, resolved by existence in this order:
  `defaults.subagent_context_file` when it resolves, `pi-minimal-harness.md`,
  an `AGENTS.md` carrying the harness block, then a legacy `AGENTS-addition.md`
  (see `docs/DISPATCH-PLAN.md`).
- The control tools `harness_decision`, `harness_report` and `harness_session`
  record the pipeline's control flow. Their state is captured in their own
  `execute`, which runs after the `message_end` hook — so the tool must assign
  unconditionally and the hook only when empty, or the textual fallback would
  win. They are inert outside a pipeline.
- The `harness_report` tool carries a `lessons` field: the findings the step
  also saves with `mem_save`. The driver validates presence, not content
  (`reportGaps`), so `[]` is the way to say "nothing" and an omitted field is
  what earns a repair turn.
- Exploration and memory are reachable in every mode, not only in `full`:
  `codegraph` is granted to the `architect`, `explorer` and `implementer`, and
  `engram` to the same three, and the prompt templates name
  both. A grant is declarative, so a runtime without the tool degrades to the
  `grep`/`rg` fallback the templates describe instead of failing.
- The repository preflight reads `defaults.preflight_policy`: `advisory` only
  reports, `blocking` stops the first agent marked `mutates_files: true` when
  the tree is dirty or a pull request is open — asked once with a TUI, blocked
  with an error without one. Agents without the field are assumed to mutate
  files, so validation lists them.
- Memory is provided by the user-level `gentle-engram` Pi package together with
  `pi-mcp-adapter` (`~/.pi/agent/mcp-adapter.json`, or
  `%USERPROFILE%\.pi\agent\mcp-adapter.json` on Windows — that is the adapter's
  own config; the legacy `mcp.json` beside it is Pi's —
  `engram mcp --tools=agent`): it owns
  session registration, passive capture, the `mem_*` tools, the injected Memory
  Protocol, compaction recovery and `<private>` redaction. The harness neither
  gates nor duplicates it; project detection comes from the server's
  `/project/current`.

## Core rules

- Change the harness only through `harness.config.yaml` and the extension; keep
  one source of truth and do not duplicate mode/agent definitions across files.
- **Keep the published surface generic**: no target-application specifics (other
  projects' tech stack, product rules, languages) in `README.md`,
  `pi-minimal-harness.md`, `prompts/`, `.agents/skills/` or the config.
- No new npm dependencies in the extension; keep the indentation-aware YAML
  editing so user formatting is preserved.
- The extension must keep working in non-interactive modes: guard terminal-only
  UI behind `ctx.mode === "tui"` / `ctx.hasUI`.
- Any process spawn must work on Windows, macOS and Linux.
- Prefer small, focused edits and preserve existing behavior that has tests.
- Documentation in English; user-facing strings may be Spanish.

## Verification

- The extension is validated by the in-repo smoke test `tests/harness.test.mjs`,
  which imports `.pi/extensions/harness.ts`, drives the registered
  commands/events/tool with fakes and asserts the pipeline, status text,
  short-circuit, per-step report guarantee, decision handling (including the
  strict decision marker and the blocking preflight), validation and the
  dispatch seams. Run it after every extension change (`node tests/harness.test.mjs`)
  and report pass/fail counts; the test re-runs itself with
  `--experimental-strip-types` on Node releases before 22.18.
  `node tests/install.test.mjs` covers the installer. Both must pass on Windows,
  macOS and Linux: never assume a Posix-only path such as `/tmp`.
- Inspect the changed regions (git exists: confirm with `git status`/reads and
  by confirming no unintended file changed).
- TUI end-to-end requires `/reload` in an interactive Pi session; report it as
  not run when you cannot do it.
- Mention every check that could not be run and why.
