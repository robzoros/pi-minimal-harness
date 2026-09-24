# AGENTS-addition.md — harness contract for adopting projects

This file contains **only the section you should add to the `AGENTS.md` of a
project that adopts `pi-minimal-harness`**. It is written to be copied and
pasted as-is: it is generic (no project-specific rules) and versioned in this
repository, so you can re-sync later by diffing against this file.

Two ways to adopt it:

1. **Paste (recommended, portable):** copy the section below into your
   project's `AGENTS.md`. Pi loads `AGENTS.md` automatically, and other agent
   tools (Claude Code, Gemini CLI, …) read the same file.
2. **Reference (zero-touch, Pi-only):** keep this file in your repository
   (e.g. `HARNESS.md`) and put a standing instruction at the top of your
   `AGENTS.md`: *"Read `HARNESS.md` in the repository root and follow it for
   every session."* Simpler to re-sync, but the model must actually read the
   file. For guaranteed injection you can instead put the standing rules in
   `.pi/APPEND_SYSTEM.md` (project-level, added to Pi's system prompt; requires
   project trust).

---

## Harness workflow

- Work is executed through the `pi-minimal-harness` pipeline. A workflow mode
  selects an ordered list of agent steps; the runtime sequences them, so steps
  cannot be skipped. Modes: `simple`, `full-dry-run`, `full`,
  `implementation-only`, `delivery-only` (see `defaults.workflow_mode`).
- Commands: `/harness-config`, `/harness-mode`, `/harness-model`,
  `/harness-run <task>`, `/harness-auto [on|off]`.
- The orchestrator ends every turn with exactly one marker:
  `HARNESS-DECISION: ANSWER_ONLY` (questions and tasks that change no files —
  the pipeline stops) or `HARNESS-DECISION: PIPELINE` (files must change).
  The harness moves the marker to the footer; it is not part of the visible
  answer.
- Every non-orchestrator agent ends its reply with `HARNESS-DONE`, after a
  report in the form `### Changes` / `### Evidence` / `### Notes for delivery`.
  If the marker is missing, the harness sends one repair turn.
- Reports are evidence-based: name the files changed, the checks actually run,
  and every check that could not be run.

## Memory — Engram

Recommended packages (user-level): `gentle-engram` plus `pi-mcp-adapter`, with
`engram mcp --tools=agent` registered in `~/.pi/agent/mcp.json`. Memory is
local-first (SQLite + FTS5) and shared across sessions and agents.

- **Save** durable learnings right after: bugfix, architecture/design
  decision, non-obvious discovery, configuration/setup, established pattern, or
  user preference. Format content as **What** / **Why** / **Where** /
  **Learned**; keep titles short; reuse a `topic_key` to evolve a topic instead
  of duplicating it.
- **Search** before repeating work: `mem_context` for recent history, then
  `mem_search` for keywords, then fetch the full observation only if needed.
- **Before ending a session**, save a session summary (Goal, Instructions,
  Discoveries, Accomplished, Next Steps, Relevant Files).
- Do **not** store raw command transcripts, tool output dumps, or facts already
  documented in the repository.

## Structural exploration — CodeGraph

- Use CodeGraph **selectively**, only when relationships matter (callers,
  callees, impact, affected tests). For simple changes, read the source
  directly.
- The index lives at the repository root: `.codegraph/` (its `.gitignore`
  should be tracked; index data should not be committed).
- Useful commands: `codegraph init --cwd <root>`, `codegraph status`,
  `codegraph sync --cwd <root>`, `codegraph explore`, `codegraph callers`,
  `codegraph callees`, `codegraph impact`, `codegraph affected`.
- If the index does not exist or is stale, initialize or sync it before
  relying on results.

## Verification

Before considering a task complete:

- inspect the relevant diff;
- run the project's own checks (focused checks for the touched area, broader
  ones when shared behavior changes);
- mention every check that could not be run and why;
- summarize completion in terms of changed files and evidence.

## Project skills

- Reusable procedures live in `.agents/skills/<name>/SKILL.md` with `name` and
  `description` frontmatter.
- Skills are invoked automatically when the task matches their description, or
  explicitly with `/skill:<name>`.
- This harness ships `github-delivery` (branch → commit → push → pull request
  with the repository's conventions).
- Create a new skill only for a recurring procedure that has safety or
  ordering constraints, or that encodes project-specific conventions.
