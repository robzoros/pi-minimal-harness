# AGENTS.md — pi-minimal-harness

Operating contract for agents working **in this repository**, the source of the
`pi-minimal-harness` project: a minimal, configuration-driven agent harness for
the Pi coding agent, published for use in other people's projects.

## What this repository contains

| Path | Purpose |
|---|---|
| `README.md` | Public front door: inspiration, install, configuration, commands, skills. |
| `AGENTS-addition.md` | The generic, paste-able contract for projects that adopt the harness (this is what adopters add to their own `AGENTS.md`). |
| `harness.config.yaml` | Single source of truth: `defaults` (mode, auto-harness, short-circuit, dispatch gate, contract file), `commands`, `workflows` (mode → agent steps), `agents` (model, reasoning, tools, prompt template), `skills`. |
| `.pi/extensions/harness.ts` | The Pi extension: `/harness-*` commands, footer status, auto-harness input hook, pipeline driver, validation, dispatch tool. |
| `prompts/` | Per-agent prompt templates referenced by `harness.config.yaml`. |
| `.agents/skills/github-delivery/` | The shipped project skill (branch → commit → push → PR). |
| `docs/WORKFLOW.md`, `docs/DISPATCH-PLAN.md` | Design documentation (roles/modes/config shape; background dispatch plan). |
| `tests/harness.test.mjs` | Node smoke test: `node tests/harness.test.mjs`. |
| `CHANGELOG.md`, `LICENSE` | Keep a Changelog + MIT. |

There is **no** `package.json` and no `src/`: the adopting application's
lint/test/cargo gates do not apply here. A git repository exists but has no
commits or remote yet (delivery requires deciding `.gitignore` policy first).

## How the harness works

- A workflow mode selects an ordered list of agent steps (`workflows.<mode>`).
- For each step the extension switches to that agent's model and reasoning level,
  renders `prompts/<agent>.md` as a short pointer (template bodies never enter
  the transcript) and sends it as the next turn; the runtime sequences the
  steps, so the model cannot skip them.
- The orchestrator emits `HARNESS-DECISION: ANSWER_ONLY` for questions and tasks
  that change no files; the pipeline then stops after the first step. It emits
  `HARNESS-DECISION: PIPELINE` when files must change.
- `defaults.auto_harness` sends plain (non-slash) requests through the pipeline;
  `defaults.question_short_circuit` enables the orchestrator's early exit.
- After the last step, the driver checks the reply for `HARNESS-DONE`; if it is
  missing it sends exactly one repair turn and then warns. A direct answer
  (`ANSWER_ONLY`) needs no report.
- The orchestrator's `HARNESS-DECISION` marker is stripped from the reply and
  shown in the footer instead (`decision: …`). For questions the footer ends at
  `1/1 <agent>`; during step 1 the total is shown only once the decision is known.
- The `harness-dispatch` tool runs independent tasks in isolated `pi`
  subprocesses with a curated brief; gated by `defaults.allow_dispatch` and the
  `defaults.subagent_context_file` contract (see `docs/DISPATCH-PLAN.md`).
- Memory is provided by the user-level `gentle-engram` Pi package together with
  `pi-mcp-adapter` (`~/.pi/agent/mcp.json` → `engram mcp --tools=agent`): it owns
  session registration, passive capture, the `mem_*` tools, the injected Memory
  Protocol, compaction recovery and `<private>` redaction. The harness neither
  gates nor duplicates it; project detection comes from the server's
  `/project/current`.

## Core rules

- Change the harness only through `harness.config.yaml` and the extension; keep
  one source of truth and do not duplicate mode/agent definitions across files.
- **Keep the published surface generic**: no target-application specifics (other
  projects' tech stack, product rules, languages) in `README.md`,
  `AGENTS-addition.md`, `prompts/`, `.agents/skills/` or the config.
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
  short-circuit, report guarantee, decision handling, validation and the
  dispatch seams. Run it after every extension change (`node tests/harness.test.mjs`)
  and report pass/fail counts.
- Inspect the changed regions (git exists: confirm with `git status`/reads and
  by confirming no unintended file changed).
- TUI end-to-end requires `/reload` in an interactive Pi session; report it as
  not run when you cannot do it.
- Mention every check that could not be run and why.
