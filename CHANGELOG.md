# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An errored or interrupted pipeline leaves a way forward.** A step whose turn
  ends in a model error is retried once, and the retry is announced; an abort is
  not retried, because the user asked for it to stop. When a run still stops
  with steps left — an error that outlived its retry, an abort, a missing
  report — the harness records the mode, the task, the completed steps and the
  step it stopped on, and names two ways out: `/harness-resume` continues from
  the step after the last completed one without re-running them, and
  `/harness-delivery` delivers what is already verified. The resume deliberately
  skips the orchestrator: re-running the workflow from the top would re-derive
  the task from scratch, and since REQ-011 the router holds no tools, so it can
  only carry the issue number it reads in the task text — which is how a stalled
  run used to reach delivery asking to have an issue created for work that
  already had one. While a stop is recorded, a plain message is refused with
  both exits named instead of silently re-running everything; `/harness-run` is
  a third exit, since it starts a new task, and abandons the stopped run
  explicitly rather than letting the new run overwrite the record. All three
  clear it. With `auto_harness` off the harness only reports the stop and lets
  the message through, because that message is the user's and nothing would
  have turned it into a pipeline. The state is written with `pi.appendEntry()`
  and read back from the active branch, so it survives `/reload` without
  entering the model context; a resume is exempt from the blocking preflight,
  whose blocker would otherwise be the very partial work being resumed, and a
  retried step is judged on its own decision rather than inheriting one from the
  attempt that failed.
- **A step reads Engram before it works, not only after.** The write side was
  mandatory and the read side was nowhere: every Engram mention in the prompt
  templates was a `mem_save`, so three agents paid to write memories that no
  step was told to open. The architect, explorer, implementer and critic now
  consult `mem_context` and then `mem_search` before they propose or edit, when
  previous project knowledge is likely to matter, and the critic is recorded as
  holding the grant it was missing — the one step whose job is to catch a plan
  that repeats a known failure could not consult what the project had already
  learned. The router and the delivery agent are deliberately not readers: the
  router is granted no tools at all, and delivery is mechanical. The read is a
  starting point and never a gate — an empty or absent memory does not stop a
  step. This is an instruction and a record, not an enforced tool set: like
  every `tools:` grant it says what the step is expected to use, and the
  `mem_*` tools are the memory provider's, available in the session already.
- **A design session that survives `/reload`.** The open/closed state is written
  with `pi.appendEntry()` — Pi's slot for durable data that must stay out of the
  model context — and restored in `session_start`, from the active branch. A
  reload used to rebuild the extension runtime and silently hand the conversation
  back to the orchestrator, with `/harness-end` then reporting that no session
  was open when one was.
- **The branch-creation rule lives in one place.** `prompts/delivery.md` owns it;
  the delivery skill points at it instead of restating it. `update` replaces the
  prompt as harness-owned but not the skill, so a rule written in both could not
  stay in step.
- **Repository content injected into a dispatched subagent is wrapped in a
  `<repo_content>` boundary — except the harness contract, which is
  instruction.** The two sources a third party can write — the declared project
  skills and the project's own `AGENTS.md` — now carry an explicit instruction to
  read them as data and never obey them, even where they address an assistant in
  the imperative. The contract is the one exception: it is injected
  **unwrapped**, introduced as the rules the subagent is expected to follow,
  because wrapping it too would tell the subagent never to obey the rules it was
  dispatched to follow — breaking the feature rather than securing it. Its audit
  belongs to the user of the repository, not to the subagent reading it. Content
  an agent reads with its own tools does not pass through the harness and is out
  of scope; it is named as such rather than left implied.
- **`/harness-validate` and `/harness-end`.** The architect writes the
  requirements file **only when the user approves**: `/harness-validate` runs a
  one-step architect turn that writes what was agreed and reports what it wrote,
  and `/harness-end` closes the design session. Approving is deliberately not
  finishing — the session stays open after an approval, because the next
  requirement may need the context of the conversation that produced it. No
  model action closes a session any more: `harness_session` lost `END` and the
  `HARNESS-SESSION:` marker is gone, so the user owns both ends. The footer
  shows `design open — /harness-end to finish` while a session is armed.
- **`defaults.requirements_format: sections | req-n`.** `init`/`update` write the
  shape the project chose: `sections` is the three empty headings the installer
  always emitted, `req-n` is one `### REQ-nnn` block per requirement with
  `Acceptance` and `Traces`. Change it from `/harness-config`. The harness never
  parses the file — this is a convention the project picks, not a setting with
  consequences — and an unknown value falls back to `sections` rather than
  breaking an install. `init` also honours `defaults.requirements_file` when the
  name carries a directory, instead of always writing a literal
  `REQUIREMENTS.md`.
- **Delivery is gated on the checks it did not run.** Before a delivery step
  starts, the harness re-runs the commands the implementing step declared in
  `checks` and hands delivery the result. A check claimed `passed` that does not
  pass stops the pipeline, naming the command; the opposite case (claimed
  `failed`, passed anyway) is reported and does not block. `defaults.check_timeout_ms`
  (300000) is the budget, deliberately separate from the preflight's short git
  probes. The runner is injectable, so the smoke test never spawns real suites.
- **`planned_paths` in `harness_report`, and a diff the harness compares.**
  The critic reports the repository-relative paths its adjusted plan expects the
  implementation to touch; after the implementer runs, the harness compares them
  with `git diff --name-only` and hands the difference to delivery as evidence.
  Delivery weighs it and says whether it proceeds — it is not a second verdict.
- **Independence is computed for `harness-dispatch`, not judged.** Each task
  declares the files it touches in `files`; tasks run concurrently only when
  their file sets are disjoint, and an overlap is refused naming the shared path.
  A task that declares no files is never refused, only unchecked.

- **An `architect` agent, and the `analysis` workflow that runs it.** The
  conceptual phase is now an agent of its own: it talks to the user in chat,
  sizes the work against the repository with CodeGraph, records what is worth
  reusing with Engram, and maintains the formal requirements of the work. It
  appears in `workflows.analysis` as `orchestrator -> architect`, granted
  `filesystem`, `engram` and `codegraph`.
- **The architect owns a multi-turn session.** It opens and closes it with the
  new `harness_session` control tool (`START` / `END`, falling back to a
  `HARNESS-SESSION: START` / `HARNESS-SESSION: END` last line), and while the
  session is open the user's next plain messages go straight to it instead of
  through the orchestrator. **The router never arms it**: the first architect
  turn is a single turn, so an ordinary question cannot leave the user trapped
  in a design session.
- **The orchestrator is now a router.** `ANSWER_ONLY` no longer ends the
  pipeline — it routes the turn to the `analysis` workflow, and the user keeps
  talking to the architect. `PIPELINE` is for a closed requirements contract
  and runs the configured mode. `defaults.analysis_routing: false` restores the
  old behaviour, in which an `ANSWER_ONLY` ends the pipeline after the
  orchestrator.
- **`init` and `update` create `REQUIREMENTS.md`** at the project root when it
  is missing, and never touch an existing one — it is project-owned, like the
  changelog, and deliberately outside the harness-owned set that `update`
  replaces. `defaults.requirements_file` chooses the name.
- Exploration and memory are now reachable in every workflow mode instead of
  only in `full`. `codegraph` is granted to the `implementer` and to the
  `orchestrator` (which runs in every mode), not only to the `explorer` that
  `simple`, `implementation-only` and `delivery-only` never reach, and the
  `orchestrator`, `explorer` and `implementer` templates instruct the agent to
  record what is worth reusing with `mem_save` — root causes, gotchas,
  non-obvious discoveries, configuration changes — instead of leaving the
  Engram grant as a permission with nothing pointing at it. The implementer
  also has to identify who depends on a symbol *before* editing it, with the
  CodeGraph caller/impact information as the preferred mechanism and `grep`/`rg`
  as the fallback when CodeGraph is unavailable or its index is stale; a local,
  obviously unreferenced change is exempt. Grants are declarative and the
  wording degrades gracefully, so a project without those servers installed
  still runs. The contract file, `README.md` and `AGENTS.md` state both rules.
- `harness_report` takes a `lessons` field: the findings a step also saved with
  `mem_save`, shown in the `### Lessons` section every report template asks
  for. All four fields are required, and `[]` is how a field with nothing in it
  is passed, so an omitted or blank field is an incomplete report. The driver
  treats it exactly like a missing report: one repair turn for that step,
  naming the field it is missing, and the pipeline stops if the report is
  still incomplete after it. The uninspectable `HARNESS-DONE` marker still
  counts as complete.

### Fixed

- `harness_report.notes` was documented as required but never validated, so a
  report that omitted it still counted as complete. It is now a gap like the
  other fields (`null` when omitted, `""` when the agent has nothing to say),
  and the prompts say `""` is how empty notes are passed.
- The `HARNESS-DONE` fallback counted when the word appeared anywhere in the
  reply, while the prompts ask for it as the last line. It now only counts on
  the last non-empty line, so mentioning the marker in prose no longer satisfies
  the report contract.
- The `harness-dispatch` parameter schema advertised `orchestrator` as a valid
  agent even though the runtime refuses the first step of the active workflow.
  The description now names only the leaf agents that can actually be
  dispatched.
- `pi-minimal-harness.md` described every report as `### Changes` / `###
  Evidence` / `### Notes for delivery` / `### Lessons`, a shape only the
  implementer uses; it now defers to each agent's own prompt template.
- The dispatch tool's schema and `composeDispatchSystemPrompt` claimed a
  system prompt built from the template, the contract and `AGENTS.md`, but the
  configured `skills:` list was never injected. Declared project skills are now
  read and injected into the step message and the subagent's system prompt, and
  validation fails when a declared skill file is missing.
- A `harness_report` call made during the orchestrator's turn satisfied the
  report guarantee of the *next* step, so a step that reported nothing was
  taken as reported. The report is now cleared after step 1, which is exempt
  from the guarantee anyway.
- A dispatched subagent got the harness contract but not the adopting project's
  `AGENTS.md`, while `harness-dispatch` and the orchestrator prompt both claimed
  the project rules were injected as its system prompt. Project rules are now
  resolved and appended after the contract — read last, so they win on conflict —
  and the documentation states exactly what is injected.
- The report repair turn asked every step for the implementer's report shape
  (`### Changes` / `### Evidence` / `### Notes for delivery` / `### Lessons`),
  contradicting the prompt an explorer, a critic or a delivery step had just
  followed. It now quotes the sections of that step's own template, and says
  that the `harness_report` call is what the harness verifies.
- `{{previous}}` was the literal string "from this conversation" in every step
  message, so the handoff a step was told to expect was only reachable from the
  transcript. It now carries the previous step's reply, bounded to 4 KiB with an
  omission marker, or an explicit "none" when there is no prior output.
- The explorer prompt told the agent to review the orchestrator's handoff "in
  this conversation", which is unsatisfiable for a dispatched subagent.
- The delivery prompt and the `github-delivery` skill asked for a test plan the
  delivery agent cannot produce: its tools carry no shell or test runner. Both
  now take the implementer's report as the source of truth and forbid claiming a
  check that was never reported.
- `harness-dispatch` accepted the orchestrator as a task agent, producing a
  subagent whose decision and handoff address a pipeline it does not run. The
  first step of the active workflow is now refused with an explanation.
- `harness.config.yaml` saved as UTF-16 was read as UTF-8, so every line carried
  NUL bytes, the configuration parsed as empty and every run failed with "No
  agents found in the configuration". Text files are now decoded through a BOM
  aware helper.

### Changed

- **The orchestrator is granted no tools at all.** An issue is a statement of
  scope, and scope belongs to the architect, which now creates the issue the work
  closes when you approve the requirements. `harness_decision` and
  `harness_report` are registered by the extension and are not gated by the
  config's tool list, so routing is unaffected by an empty one. Its prompt also
  stops asking for scope and risk, which was an invitation to analyse.
- **Breaking: five workflow modes are now three.** `simple`,
  `implementation-only` and `delivery-only` are gone; what is left is `full`
  (the technical flow through GitHub delivery), `full-dry-run` (explore,
  critique and simulate implementation without mutating files) and `analysis`
  (the interactive `orchestrator -> architect`). `update` **migrates** a
  `defaults.workflow_mode` naming a retired mode to `full` and reports it: the
  config merge is additive and never overwrites a local scalar, so without that
  an existing installation would have kept a mode with no steps and auto-harness
  would have stopped working with nothing the user could act on.
  `/harness-delivery` no longer depends on a retired mode: it runs the delivery
  agent through `full`.
- **Breaking: `architect` is a required agent.** The additive config merge
  inserts the whole missing block, so `update` installs it into existing
  projects; validation names the fix when it is absent.
- `defaults.analysis_routing` replaces `defaults.question_short_circuit`.
  Overloading the old key would have been a silent break: an adopter who set it
  to `false` to let a pipeline run without a decision would have lost routing
  too. The old key is still read when the new one is absent, so that
  configuration survives the upgrade unchanged.
- The architect is exempt from the per-step report guarantee and from the
  blocking repository preflight. A structured report owed on every chat turn is
  the opposite of a chat, and a dirty tree is the normal state while a design
  is still open — with each turn its own pipeline, the gate would have asked on
  every message.
- The driver clears `lastDecision` and `lastReport` before every step instead
  of only after the first. A second step used to read the first step's decision
  as its own, which only went unnoticed because the report guarantee skipped it.
  The footer keeps showing the decision through a separate, run-level variable.
- Validation warns about workflow entries that are not modes this harness
  offers, which is what an upgrade leaves behind: `update` only ever adds.
- The delivery contract asks before creating what it is missing, instead of
  stopping on it. When the repository requires issue-linked pull requests and
  the handoff carries no issue, the delivery step asked the user to authorize
  creating one — naming the title it would use — and stopped; it never invented
  a number and never created one unasked. The same holds for the branch when
  the target is a choice the agent cannot make (work already on a branch with an
  open or reviewed pull request); creating a fresh branch from the base branch
  stays the mechanical default and still needs no permission. A denial is
  reported as the reason delivery did not happen. The request is what the turn
  ends with, because the delivery agent cannot block on an answer inside its
  own turn. Previously the agent stopped and reported the gap, so an ordinary
  delivery failed on a missing issue instead of asking for it.
- The critic's verdict is a real field: `harness_report` takes a `verdict`
  (`PROCEED`, `PROCEED WITH CHANGES` or `BLOCKED`), and a `BLOCKED` verdict
  stops the pipeline before the file-mutating steps, with the critic report as
  the final answer. Previously the verdict was prose the pipeline could not act
  on.
- Responsibility for the issue number is explicit: the orchestrator identifies
  (or creates) the issue and passes it in its handoff, the implementer carries
  it in `### Notes for delivery`, and delivery uses it for `Closes #N` instead
  of inventing one. `delivery-only` uses the verification evidence the
  orchestrator quotes in its handoff, since there is no implementer report.
- `CHANGELOG.md` has one owner again: the implementer edits it, and the
  `github-delivery` skill only verifies the entry (delivery has no
  file-editing tools and previously was told to update it).
- The repository preflight warning is injected into the step message, not only
  shown in a notification the file-mutating agent never sees.
- The critic is told to read `AGENTS.md`; the `type:*` label is derived from
  the commit type and the PR template (stopping when ambiguous); the
  orchestrator/explorer boundary and the `delivery-only` preconditions are
  spelled out in the prompts; and `docs/WORKFLOW.md` no longer assigns OpenSpec
  or prompt authoring to the orchestrator.
- The contract is now a standalone file, `pi-minimal-harness.md`, instead of a
  section pasted into the adopting project's `AGENTS.md`. `init` and `update`
  copy the file to the project root and add a reference to `AGENTS.md` instead
  of a copy of the contract, if it is not there already:

  ```markdown
  ## pi-minimal-harness instructions
  * **Harness Rules:** Read pi-minimal-harness.md and strictly follow its guidelines for this project's harness.
  * **Conflict Resolution:** If any rules in AGENTS.md conflict with pi-minimal-harness.md, the rules in AGENTS.md take precedence.
  ```

  A paste is lost on the next upgrade; a file of its own is replaced by
  `update` and stays diffable, and the reference states the precedence rule
  instead of leaving both texts to be reconciled by the agent. The file's
  preamble — the two adoption options and how to re-sync — is now commented
  out and rewritten for the new arrangement, because there is no longer a
  section to take out of it. An installation that still carries the pasted
  block between the installer markers is migrated in place by `update` (a
  hand-pasted contract has no markers, so it is kept and the reference is added
  next to it); anything else in `AGENTS.md` is never rewritten, so a hand-written
  or hand-edited reference is left exactly as it is. Contract resolution for
  dispatched subagents follows the new order: `defaults.subagent_context_file`
  when it resolves, `pi-minimal-harness.md`, an `AGENTS.md` carrying the
  harness block, and finally a legacy `AGENTS-addition.md`, so projects
  installed before the rename keep dispatching.

### Fixed

- Dispatch was broken for the recommended way to adopt the contract. The
  installer pastes the block into the project's `AGENTS.md`, so a project that
  keeps no standalone `AGENTS-addition.md` had no contract to inject, and every
  `harness-dispatch` call threw `subagent_context_file not found` — with
  `allow_dispatch: true` and the agent's own instructions authorising the call —
  while `/harness-config` showed the same failure in red. Neither adoption
  option in `AGENTS-addition.md` mentioned it, because the two options are not
  equivalent. The contract is now resolved by **existence**, in order:
  `defaults.subagent_context_file` when it resolves, an `AGENTS.md` carrying the
  `<!-- BEGIN pi-minimal-harness -->` block, then a standalone
  `AGENTS-addition.md`. A configured key whose file was deleted falls through
  instead of failing, which is the state every pasted-contract project is left
  in after an update, since the additive config merge never removes the key. A
  key that resolves nowhere is reported on its own `/harness-config` check so
  the fallback is visible rather than silent.
- The installer injected the whole of `AGENTS-addition.md` into the adopting
  project's `AGENTS.md`, including the preamble that documents the two
  adoption options and how to re-sync the file — documentation for whoever
  reads the source file, addressed to the agent. The pasted block now starts at
  `## Harness workflow`; a missing heading is a hard error rather than a
  silent full-file paste.
- The contract told agents to keep a tracked `.gitignore` inside `.codegraph/`,
  which is unexecutable for a project whose ignore rules already cover the
  directory, and promised that "this harness ships `github-delivery`" as a fact
  about any adopting project. The index is now described as local state that
  must not be committed, with the ignore file left to the project's own rules,
  and a declared skill is something to verify rather than assume.

- The Engram setup instructions told the reader to run `pi-engram init` as a
  bare command. It is never on the `PATH`: `pi install` keeps package shims in
  npm's private `node_modules/.bin`, which npm only exposes to scripts run
  inside that package. The README now shows the three invocations that work
  (bash, PowerShell and plain `node cli.js`), explains why the shim is not on
  the `PATH`, warns against `npx pi-engram` (the package is `gentle-engram`;
  the binary is only its name), and points at `ENGRAM_BIN` when the Engram
  binary itself is not on the `PATH`.
- The documentation named `~/.pi/agent/mcp.json` as the file where the
  `pi-mcp-adapter` integration registers its servers. That is the legacy file,
  and its `mcpServers` may be owned by Pi's built-in MCP; the adapter's own
  config is `~/.pi/agent/mcp-adapter.json`
  (`%USERPROFILE%\.pi\agent\mcp-adapter.json` on Windows). `README.md`,
  `AGENTS.md` and `AGENTS-addition.md` now point at the adapter file, and the
  README explains that a `pi-engram init` that landed the Engram entry in the
  legacy file has to be moved across.
- The smoke test only ran on Posix hosts: it built its temporary project under
  the hardcoded `/tmp` (absent on Windows) and imported the extension through a
  hand-built `file://` string. It now uses `os.tmpdir()` and `pathToFileURL`,
  and `node tests/harness.test.mjs` works unchanged on Windows, macOS and
  Linux.
- `node tests/harness.test.mjs` failed with `ERR_UNKNOWN_FILE_EXTENSION ".ts"`
  on Node releases before 22.18, which cannot import the TypeScript extension
  without `--experimental-strip-types`. The test now re-runs itself with the
  flag when the runtime lacks TypeScript support.
- A Windows checkout with `core.autocrlf` enabled could rewrite the repository
  to CRLF. `.gitattributes` pins the working tree to LF.

- `harness-dispatch` reported its failures by returning `{ isError: true }`, but
  `AgentToolResult` has no such field and the Pi runtime only marks a tool call
  as an error when `execute` throws. Every dispatch gate failure (disabled
  dispatch, unknown agent, empty brief, missing contract file, unsupported
  model effort) was therefore recorded as a **success**. The failure paths now
  throw, and a batch in which every agent failed throws with the per-agent
  summary in the message so the model still sees why. A partial batch still
  resolves normally and reports the failures in its text.

- `init --force` failed on any project that pasted the contract into its
  `AGENTS.md` by hand, which is what the README documented until now and what
  the installer itself recommends. The contract was only recognised through the
  installer markers, so a pasted section read as a conflict and `--force`
  turned that into a hard error — `update` hit the same wall, which left the
  first generation of adopters unable to upgrade without editing `AGENTS.md`
  themselves. The section is now compared by content: present and unmodified
  means `unchanged`, and the file is never rewritten. A section that *was*
  edited is still refused, and `--force` still does not overwrite it.
- The "refusing to overwrite" error sent you to `--force`, which is what the
  `AGENTS.md` conflict then refused. The message now names `update`, the
  command that actually upgrades an installation.
- `init` on a project that already has the harness did half the work and
  exited successfully, so an upgrade could look like it had happened. The
  report now states, before anything is written, that this is an install and
  that `update` is the upgrade command.

### Changed

- A fresh install now reports the placeholders it shipped — the five
  `model: provider/model-id` agents and `project: my-project` — in the report
  and not only in a "Next steps" line. They are warnings, not errors: the
  installer has no model catalog, but `/harness-config` fails until they are
  set, and the user should hear it from the tool that wrote the file.
- The installer warns when it runs on Node < 22, the documented prerequisite
  for loading the extension. Not blocking: the installer can run on one Node
  while Pi loads the extension with another.
- `defaults.subagent_context_file` is no longer part of the shipped
  configuration: it is optional, because the contract is resolved by
  existence. Existing projects keep the key and keep working, including the
  projects whose key names a file they no longer have.
- `init` and `update` create an empty `CHANGELOG.md` in the adopting project
  when it has none — the contract asks every agent to record its work in a
  changelog, and most projects have no file to write to. The new one holds the
  Keep a Changelog heading and nothing else: no invented history, and an
  existing changelog is never touched.

### Added

- `npx pi-minimal-harness update`: one command that upgrades an existing
  installation. It replaces the upstream-owned files (extension, prompts,
  delivery skill, `AGENTS.md` contract block) and merges the local
  `harness.config.yaml` **additively** — keys the newer template introduced are
  added with their default value and the comment that documents them, while
  every existing value, extra key and YAML sequence is left untouched and no
  key is ever removed. The previous config is kept as `harness.config.yaml.bak`
  (Git-excluded) whenever something is added, `--dry-run` lists every addition
  without writing, and the local file's indentation width and line endings are
  preserved. `init` uses the same merge, so it can no longer be blocked by an
  edited config.
- Control tools `harness_decision` and `harness_report`: the pipeline's
  decision and per-step report are now recorded by a tool call instead of being
  parsed out of the reply. The `HARNESS-DECISION` and `HARNESS-DONE` markers stay
  supported as a fallback for one release, and the tool wins when both are
  present. `harness_report` also captures the changed files and the checks that
  were run, which later steps can verify instead of trusting.
- `defaults.strict_decision_marker` (default `false`; enabled in this
  repository's own config): a multi-step pipeline stops with an error when the
  orchestrator's reply carries no usable decision marker, instead of reading
  its absence as "not `ANSWER_ONLY`" and running the file-mutating steps.
- `defaults.preflight_policy` (`advisory` | `blocking`): under `blocking`, a
  dirty working tree or an open pull request stops the first step that mutates
  files. With a TUI the operator is asked once; without one the step is blocked
  and reported as an error — never silently continued.
- `agents.<name>.mutates_files` marks which steps may modify files, so the
  preflight gate can protect them without naming agents in the extension.
  Agents without the field are assumed to mutate files, and `/harness-config`
  validation lists them.
- A dependency-free `pi-minimal-harness init` installer with dry-run, force,
  idempotent contract merging, and local Git exclusion for the generated config
  and its `update` backup.
- Model-aware reasoning-effort selection in `/harness-model`: after choosing a
  model from Pi's catalog, the operator chooses from the effort levels exposed
  by that model. Model and effort are persisted atomically in the agent block.

### Changed

- `README.md` now documents the full CodeGraph setup — `npm i -g codegraph`,
  `codegraph init` in the project, and the `codegraph` entry to add under
  `mcpServers` in `~/.pi/agent/mcp-adapter.json` (`serve --mcp`, `directTools:
  false`, `lifecycle: "lazy"`) — and the upgrade command shows the common case
  (`cd` into the project, then `npx --yes pi-minimal-harness@latest update`)
  alongside `--project`, with `/reload` and `/harness-config` as the follow-up.
- A turn whose assistant message still carries a pending tool call no longer
  satisfies the auto-harness turn wait, so a step that uses a tool is no longer
  read as finished between the tool call and its follow-up.
- The `HARNESS-DECISION` marker is only read on the **last non-empty line** of
  the orchestrator's reply. A marker quoted earlier (in prose, a code fence or
  a list of examples) no longer decides the pipeline and is no longer stripped
  from the visible reply; a final line naming both variants is ambiguous and
  yields no decision.
- `HARNESS-DONE` is now verified after **every** step instead of only the last
  one, with one repair turn per step naming the step, and the pipeline stops
  when a step still omits its report. A direct `ANSWER_ONLY` answer owes no
  report and is never repaired.
- Configuration validation now checks configured model IDs and model-supported
  reasoning efforts when Pi's catalog is available.
- Pipeline and background dispatch reject or warn about unsupported
  model/effort combinations instead of silently applying them.
- The interactive model/effort picker now returns to the agent menu after each
  saved change, with an explicit `Cancel` action; argument-based selection stays
  one-shot.
- README Engram setup now recommends `pi-engram init` instead of requiring
  manual Pi and MCP configuration.
- Add `/harness-delivery` to run the delivery agent without changing the
  configured workflow mode.
- Add an advisory repository preflight before pipelines to warn about
  uncommitted changes, branch divergence, and open pull requests.

### Changed

- **The orchestrator is a router and nothing else.** It is granted no
  exploration tools (`codegraph`, `filesystem`, `engram` are removed; `github`
  stays, because naming the issue a pull request closes is routing work). It
  classifies the task and hands it over verbatim: no sizing, no file list, no
  pre-analysis. The explorer — or the architect, in `analysis` — does that work
  from the task with the repository in front of it, so a summary the router
  produced is a turn they repeat and discard.
- **The architect opens its design session; the user closes it.** See
  `/harness-end` above: `harness_session` accepts `START` only.

### Removed

- **`harness_session`.** An architect step opens the design session implicitly and
  only `/harness-end` closes it. Opening it was a model action, and that is
  exactly what made it unreliable: a model that simply forgot left the user
  talking to the orchestrator with nothing saying why. Three control tools become
  two.
- **`HARNESS-SESSION:` as a fallback.** The session is opened with a tool call
  and closed only by the user, so there is no textual fallback for either end.
  A stale `HARNESS-SESSION:` line in a reply is now inert and stays visible in
  the text rather than being silently stripped.

## [0.1.0] - 2026-09-24

First public release as **pi-minimal-harness**.

### Added

- Pipeline driver (`.pi/extensions/harness.ts`): workflow modes
  (`simple`, `full-dry-run`, `full`, `implementation-only`, `delivery-only`)
  executed step by step with per-agent model, reasoning level and prompt
  template.
- Interactive commands: `/harness-config`, `/harness-mode`, `/harness-model`,
  `/harness-run`, `/harness-auto`.
- Question short-circuit: the orchestrator's `HARNESS-DECISION: ANSWER_ONLY`
  stops the pipeline after step 1; the decision is shown in the footer instead
  of the answer.
- Report guarantee: every non-orchestrator agent must end with `HARNESS-DONE`;
  one repair turn is sent when it is missing.
- Auto-harness: plain (non-slash) requests run through the pipeline.
- Footer status: `harness: <mode> [· step] [· decision] · auto: on|off`.
- Background dispatch tool (`harness-dispatch`): independent tasks in isolated
  `pi` subprocesses with curated briefs, gated by `allow_dispatch`.
- Configuration validation (modes, agents, models, templates, workflow steps,
  contract file, delivery skill).
- Prompt templates for the five agent roles (`prompts/`).
- Project skill `github-delivery` (branch → commit → push → PR conventions).
- `AGENTS-addition.md`: generic, paste-able contract for adopting projects.
- Smoke test `tests/harness.test.mjs` (73 checks; no network, no real config
  writes).

### Notes

- Memory (Engram) and CodeGraph are optional, user-level integrations —
  `gentle-engram` + `pi-mcp-adapter` packages, and the `codegraph` CLI. The
  harness does not bundle them.
