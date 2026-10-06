# Requirements

The formal scope of the work in design, maintained by the architect.

Each requirement is an atomic, verifiable block: the ID (`REQ-nnn`, zero-padded
so the file sorts), the **statement** of what the harness shall do, the
**rationale** behind it, the **acceptance** checklist — what ISO/IEC/IEEE 29148
calls *verifiable* — the **traces**, the files that implement it, and the
**status**. `shall` is the only verb of obligation in this file, so it carries no
RFC 2119 keywords alongside it.

## Who may write what

The file splits into two authorities, and the split is the point:

- **Scope belongs to the architect, and only after you approve it.** Creating a
  requirement, or changing the scope of an existing one — its `Statement`,
  `Rationale`, `Acceptance` or `Traces` — is the architect's alone, it happens
  only on your validation, and never while a requirement is terminal. A terminal
  requirement is closed to redefinition: it gets superseded, not edited.
- **Status belongs to the implementer.** It moves a requirement to `IMPLEMENTED`
  when the checks pass and its acceptance criteria are certified. It may not
  touch anything else in the block.

This is the same rule the harness already applies to a check report: the agent
moves a datum, never a decision.

| Status | Set by | Meaning |
|---|---|---|
| `DRAFT` | architect | Written and agreed. Not built. |
| `IMPLEMENTED` | implementer | Checks pass and the acceptance criteria are certified. Terminal: the scope is now closed. |
| `SUPERSEDED` | architect | Retired. Kept with its reasoning rather than deleted, so a later reader sees the decision and not just its absence. |

Context: the defects of `docs_mejoras/mejoras_implementación.md` that survive
pull request #25, plus the harness behaviour decided in design with the user.
REQ-001 to REQ-013 are implemented (REQ-005 superseded) and are on `main`.
REQ-014 to REQ-016 are new: the tester's own step and the gate it is, a failing
test routed back to the implementer, and a pipeline that can be resumed after a
step error — the last one after a run stalled mid-flight and left
implemented-but-undelivered work with no way to act on it. REQ-017 follows
Engram itself: the pipeline writes to it on every run and instructs nobody to
read it, so the memories accumulate unread. REQ-018 syncs the published surface
with what the implementation and the installer already do, after REQ-014 added
the tester and the package gained its `bin`. REQ-019 stops the requirements file
the architect writes from counting as a dirty tree. REQ-020 states the
architect's issue duty where the architect actually reads it.

## Additions

### REQ-001 — Content the harness injects is data, except the contract, which is instruction

- **Statement**: While composing a dispatched subagent's system prompt, the
  harness shall treat the two natures of what it injects differently. Repository
  content it reads from the project — the declared project skills and the
  project's own `AGENTS.md` — shall be wrapped in an explicit `<repo_content>`
  boundary stating that the content inside is material to analyse and never
  instructions to follow, even where it addresses an assistant in the
  imperative. The harness contract (`pi-minimal-harness.md`) shall be injected
  **without** that boundary, introduced by a note that it is the subagent's
  authoritative instruction set, whose audit belongs to the user and not to the
  subagent.
- **Rationale**: the first draft of this requirement treated everything the
  harness injects as one kind of thing, and that was wrong in a way the tests
  could not see. A `SKILL.md` or a branch `AGENTS.md` is a file a third party can
  write, so it is data and the subagent must not take orders from it. The
  contract is the opposite: it **is** the subagent's rulebook — the file says so
  of itself, and the composer already states that `AGENTS.md` wins over it on
  conflict. Wrapping it in "never obey this" tells the subagent to discard the
  rules it was dispatched to follow, which breaks the feature rather than
  securing it. The scope stays deliberately narrow for the same reason as before:
  everything else an agent reads, it reads with its own tools, so it never passes
  through the harness and there is no interception point. See **Out of scope** for
  what that leaves uncovered.
- **Acceptance**:
  - [ ] The project skills and `AGENTS.md` are wrapped in `<repo_content>` and
        the boundary is visible in the composed system prompt.
  - [ ] **The contract is not wrapped**, and the composed prompt presents it as
        the authoritative instruction set rather than as data.
  - [ ] The precedence the contract declares survives composition: `AGENTS.md`
        is read after the contract and stated to win on conflict.
  - [ ] A skill whose body contains imperative instructions addressed to the
        assistant does not change a subagent's behaviour.
  - [ ] The wrapper lives in the extension's prompt composer, so no template can
        opt out by omitting the rule.
  - [ ] `tests/harness.test.mjs` asserts both directions: the boundary is present
        for skills and `AGENTS.md`, and absent for the contract.
- **Traces**: `.pi/extensions/harness.ts` (`composeDispatchSystemPrompt`),
  `pi-minimal-harness.md`, `tests/harness.test.mjs`
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-002 — Delivery re-runs the declared checks

- **Statement**: When a delivery step begins, the harness shall run the commands
  the implementing step declared in its `checks`, and shall block the step when a
  command's exit status contradicts the result the agent reported.
- **Rationale**: `prompts/delivery.md:24` currently forbids re-running them — the
  delivery agent has no shell and no test runner — so the last step trusts the
  implementer's own account of what passed. The critic distrusts the plan; nobody
  distrusts the execution.
- **Acceptance**:
  - [ ] An implementer report claiming `passed` for a command that fails is
        blocked, and the block message names that command.
  - [ ] A command that cannot be executed **and can be told apart from a
        failure** counts as `skipped`: a timeout, or POSIX exit 127. On Windows a
        missing command exits 1 — the same code a genuine failure uses — so it is
        deliberately reported as `failed` rather than `skipped`, because a real
        failure reported as skipped would let broken work through as verified.
  - [ ] No new command registry: the harness executes what the agent already
        declared.
- **Traces**: `.pi/extensions/harness.ts` (step gate), `prompts/delivery.md`
- **Priority**: P1
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-003 — The critic's plan is checked against the diff

- **Statement**: When the implementing step finishes, the harness shall compare
  the areas the critic reported against the paths in `git diff --name-only`, and
  shall inject any mismatch into the delivery step's context.
- **Rationale**: the critic assesses a plan before implementation and never sees
  the result, so a plan the implementer did not follow is invisible until it is
  already in a pull request body.
- **Acceptance**:
  - [ ] Paths changed outside the reported plan, and reported paths never touched,
        both reach delivery with the mismatch named.
  - [ ] The mismatch is evidence for delivery to weigh, not a second verdict:
        delivery decides whether to proceed and says which.
- **Traces**: `.pi/extensions/harness.ts` (report capture, delivery context)
- **Priority**: P1
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-004 — Objective independence for `harness-dispatch`

- **Statement**: When several briefs are dispatched together, the harness shall
  run them concurrently only if their declared file sets are disjoint, and shall
  otherwise refuse the dispatch naming the shared paths.
- **Rationale**: "only when it is genuinely independent" is a judgement the model
  makes about its own workload, with no criterion and an incentive to rationalise.
  The orchestrator's handoff already enumerates relevant files, so independence is
  computable.
- **Acceptance**:
  - [ ] Two dispatched briefs naming the same path are rejected.
  - [ ] Disjoint briefs still run in parallel, up to the existing concurrency cap.
- **Traces**: `.pi/extensions/harness.ts` (dispatch tool), `prompts/orchestrator.md`
- **Priority**: P2
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-005 — CodeGraph staleness decided by the harness

- **Statement**: Before any step whose agent is granted `codegraph`, the harness
  shall compare the commit recorded in the index against `HEAD` and shall sync the
  index when they differ.
- **Retired**: the premise is false. The index records no commit at all:
  `project_metadata` holds `index_state`, `indexed_with_version` and an
  `updated_at`, and nothing that identifies a tree state. So the comparison this
  requirement asks for cannot be made. And the gap it wanted to close is
  already covered: CodeGraph runs a file watcher that re-indexes on change, so a
  stale index is self-healing while the daemon is up. Closing it anyway would
  mean reading SQLite from the extension through `node:sqlite`, experimental on
  Node 22, for a belt the daemon's braces already provide.
- **Traces**: —
- **Status**: `SUPERSEDED`

### REQ-006 — The requirements format is a choice, not a default the harness imposes

- **Statement**: When the harness creates a missing requirements file, it shall
  emit the shape named by `defaults.requirements_format`, and the user shall be
  able to change that choice from `/harness-config`.
- **Rationale**: `ensureRequirements` writes the architect's three-section shape
  into every adopting project, which imposes a methodology nobody chose. The shape
  is a convention between the architect and the user — nothing in the harness
  parses the file — so the harness shall offer the choice rather than make it.
- **Acceptance**:
  - [ ] `defaults.requirements_format` accepts `sections` — the default, the three
        empty sections emitted today — and `req-n`, whose blocks carry `Acceptance`
        and `Traces`, with `Statement`, `Rationale` and `Priority` optional inside
        a block.
  - [ ] `ensureRequirements` emits the named shape and leaves an existing file
        untouched.
  - [ ] `/harness-config` lists both values, shows the current one and sets it.
  - [ ] Requirement IDs are zero-padded to three digits, so the file sorts in
        reading order.
  - [ ] `tests/install.test.mjs` asserts both shapes and the existing `unchanged`
        behaviour.
  - [ ] `docs/WORKFLOW.md` and `pi-minimal-harness.md` describe the key, not a
        fixed shape.
- **Traces**: `bin/pi-minimal-harness.mjs` (`ensureRequirements`),
  `harness.config.yaml` (`defaults.requirements_format`),
  `.pi/extensions/harness.ts` (`harness-config`),
  `tests/install.test.mjs:439-455`, `docs/WORKFLOW.md:78`, `pi-minimal-harness.md`
- **Priority**: P1
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-007 — Only the user approves a change and only the user ends the session

- **Statement**: When the user approves the proposal, the harness shall run the
  architect to write the agreed content to the requirements file and shall leave
  the session open; the architect shall not modify that file outside an approval;
  and the session shall close only when the user ends it.
- **Rationale**: `prompts/architecture.md:4` says "edit it as the design moves",
  so the file changes without the user having seen it. And approval is not
  termination: the next requirement may need the context of the current
  conversation, which only an open session preserves. Opening a session on the
  architect's initiative costs one turn; closing it early loses the thread, so
  that asymmetry is why the architect may still open but never close.
- **Acceptance**:
  - [ ] `/harness-validate` runs a one-step pipeline whose agent is the architect
        with a message that the user approved; the architect writes the agreed
        content and the session stays open.
  - [ ] `/harness-end` closes the session without approving, and the next plain
        message is routed by the orchestrator.
  - [ ] The architect's own `END` choice and the `HARNESS-SESSION:` marker are
        removed, so no model action closes a session.
  - [ ] A session that was never validated leaves the requirements file untouched:
        there is no change in that file the user did not approve.
  - [ ] Outside a session, `/harness-validate` says so and does nothing.
  - [ ] `prompts/architecture.md` may tell the architect to end its message by
        asking whether to continue with another requirement or finish, as advice
        the user may ignore, never as the closing mechanism.
  - [ ] The `session:` cases in `tests/harness.test.mjs` are inverted: they assert
        that no architect action closes a session.
- **Traces**: `.pi/extensions/harness.ts` (`harness_session`, `lastSessionChoice`,
  command registration), `prompts/architecture.md`, `prompts/orchestrator.md`,
  `pi-minimal-harness.md:52-54`, `README.md:368-373`, `docs/WORKFLOW.md`,
  `tests/harness.test.mjs`
- **Priority**: P1
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-008 — The router only routes

- **Statement**: While routing a turn, the orchestrator shall read the task,
  classify it and hand it over verbatim, and shall not inspect the repository.
- **Rationale**: measured in real turns — the orchestrator greps the repository,
  lists affected areas and reports risks at `reasoning: high`, and the next agent
  does it again from scratch. In `analysis` the architect re-reads the repository;
  in `full` the explorer explores it. The turn is expensive and nothing consumes
  its output. Denying the tools is what makes this structural: without
  `codegraph` and `filesystem` the orchestrator cannot analyse even if prompted
  to, and without `engram` it has nowhere to file findings.
- **Acceptance**:
  - [ ] `prompts/orchestrator.md` drops the CodeGraph sizing step and the
        instruction to enumerate affected areas; the handoff carries the task text,
        the route and the reason.
  - [ ] The orchestrator is granted neither `codegraph` nor `filesystem` nor
        `engram`; it keeps `github`, which it needs to identify or create the
        issue a pull request closes.
  - [ ] The handoff no longer claims verification evidence. A `delivery-only` run
        takes its test plan from the step that ran the checks, or runs its own.
  - [ ] An ordinary single question still runs the first architect turn with no
        session armed.
- **Traces**: `prompts/orchestrator.md`, `harness.config.yaml`
  (`agents.orchestrator.tools`), `AGENTS.md` (the tools granted in every mode),
  `docs/WORKFLOW.md`, `tests/harness.test.mjs`
- **Priority**: P1
- **Status**: `IMPLEMENTED` (pull request #26)

### REQ-009 — A design session survives a reload

- **Statement**: While a design session is open, a reload of the extension shall
  leave it open, and the next plain message shall still go to the architect.
- **Rationale**: the session is module state in memory, and a reload re-imports
  the extension, so an open session is lost silently. This is REQ-007 incomplete
  rather than a new idea: the session was built to be the user's, and losing it
  on `/reload` hands the conversation back to the orchestrator — the one outcome
  the session exists to prevent. `/harness-end` also then reports that no
  session is open when one was.
- **Acceptance**:
  - [ ] The open/closed state is stored with `pi.appendEntry()`, which Pi
        documents as durable and excluded from the model context, so it survives a
        reload without appearing in the transcript.
  - [ ] `session_start` restores the state from the active branch, so an
        abandoned branch does not resurrect it.
  - [ ] After a reload, the next plain message still reaches the architect, and
        `/harness-end` reports a session that is actually open.
  - [ ] A session that was never opened leaves nothing behind to restore.
  - [ ] `tests/harness.test.mjs` covers it: the smoke test reloads the extension
        by re-importing it, so the state has to survive that.
- **Traces**: `.pi/extensions/harness.ts` (`inArchitectSession`, `session_start`),
  `docs/extensions.md` (state table), `tests/harness.test.mjs`
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-010 — The architect's turn opens the design session, and no model opens or closes it

- **Statement**: When an architect step finishes, the harness shall leave the
  design session open; `harness_session` shall be removed, and no model action
  shall open or close a session.
- **Rationale**: REQ-007 closed the session against the model and left it open to
  it — the architect had to call `harness_session(START)` for the session to
  exist. That put a state the design depends on inside the model's memory: a
  session was silently never opened when the model forgot, and the user's next
  message went back to the orchestrator with nothing saying so. It is the same
  weakness the harness already removed twice, for the route (`harness_decision`)
  and for dispatch independence (`dispatchOverlap`). If the agent that just ran
  is the architect, the conversation *is* a design session; nothing has to be
  signalled for that to be true. With the opening implicit, `harness_session` has
  no remaining caller and three control tools become two.
- **Supersedes**: the opening half of REQ-007. REQ-007 keeps its write-on-approval
  rule and its two commands; only the `harness_session(START)` mechanism is
  replaced, and REQ-007's status stays terminal because its scope is closed.
- **Acceptance**:
  - [ ] After any architect step, the next plain message reaches the architect
        without the model having called anything.
  - [ ] `harness_session` is no longer registered; `harness_decision` and
        `harness_report` remain.
  - [ ] `/harness-end` is the only way to close a session.
  - [ ] An ordinary question answered by the architect keeps the conversation
        with the architect until `/harness-end`, instead of routing the user's
        next message away.
  - [ ] After `/harness-end`, a plain message is routed by the orchestrator; if
        that turn reaches the architect again, a new session opens, which is what
        asking another design question means.
  - [ ] `prompts/architecture.md` and `prompts/orchestrator.md`, `pi-minimal-harness.md`,
        `README.md` and `CHANGELOG.md` no longer mention `harness_session`.
  - [ ] `tests/harness.test.mjs` asserts an architect turn alone arms the session,
        with no tool call in the turn.
- **Traces**: `.pi/extensions/harness.ts` (`runPipeline` architect step,
  `harness_session` registration), `prompts/architecture.md`, `README.md:368-375`,
  `pi-minimal-harness.md:52-54`, `CHANGELOG.md`
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-011 — The architect owns the issues, the router owns nothing

- **Statement**: While validating the requirements, the architect shall decide
  whether the approved work needs one issue or several, shall create them with the
  GitHub tool, and shall record the issue each requirement belongs to; the
  orchestrator shall be granted no tool that reaches GitHub.
- **Rationale**: an issue is a statement of scope, and scope is the architect's —
  creating one is writing the contract, which is exactly what REQ-007 took away
  from everyone but the architect and the user. The orchestrator was the last
  actor still reaching for a tool, and reaching for it invited the analysis the
  router is not supposed to do: its two prompt responsibilities contradicted each
  other, one telling it to read the rules files that apply and another forbidding
  it to open the code. Denying the tool removes the temptation and the
  contradiction with it. The handoff then carries an issue that already exists,
  instead of a number the router was asked to invent.
- **Acceptance**:
  - [ ] `agents.orchestrator.tools` is empty; `agents.architect.tools` gains
        `github`.
  - [ ] On `/harness-validate`, when the approved scope needs an issue, the
        architect creates it — one issue when the requirements are one change, or
        one per separable group — and reports which issue each requirement belongs
        to.
  - [ ] The handoff carries the existing issue number, or `none`; the orchestrator
        no longer creates or identifies issues.
  - [ ] When the user then says something like "implementa los requisitos
        relacionados con el issue #N", the harness reads that #N as the work, so
        the issue is the handle a conversation returns to rather than a note in a
        handoff nobody reads again.
  - [ ] A repository that does not require issue-linked pull requests keeps
        working with `none`.
  - [ ] `prompts/orchestrator.md`, `pi-minimal-harness.md`, `README.md` and
        `docs/WORKFLOW.md` say the architect owns issues.
  - [ ] `tests/harness.test.mjs` asserts the orchestrator resolves to no tools.
- **Traces**: `harness.config.yaml` (`agents.architect.tools`,
  `agents.orchestrator.tools`), `harness.config.example.yaml`,
  `prompts/architecture.md`, `prompts/orchestrator.md`, `docs/WORKFLOW.md:56`,
  `pi-minimal-harness.md`, `README.md`
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-012 — Only the delivery step creates a branch

- **Statement**: The delivery step shall be the only place in this repository that
  creates a branch; `prompts/delivery.md` and `.agents/skills/github-delivery/`
  shall not both carry the rule.
- **Rationale**: the rule is currently written twice — `prompts/delivery.md` and
  the delivery skill — so the same instruction can drift in two places, and a
  reader cannot tell which one binds. The prompt and the skill are also different
  audiences: the skill is the procedure, the prompt is the step's contract, and
  only one of them should own the rule. `update` replaces the prompt as
  harness-owned while the skill is a project file, so a rule stated in both
  cannot be kept in step.
- **Acceptance**:
  - [ ] The branch-creation rule appears in exactly one of `prompts/delivery.md`
        and `.agents/skills/github-delivery/SKILL.md`; the other points at it
        instead of restating it.
  - [ ] The rule keeps both of today's guards: never rewrite a branch already
        reviewed or merged, and ask the user when the branch is a choice the step
        cannot make.
  - [ ] No other agent, command or file in the repository creates a branch.
- **Traces**: `prompts/delivery.md:37-38`, `.agents/skills/github-delivery/SKILL.md:26,70`
- **Priority**: P2
- **Status**: `IMPLEMENTED`

### REQ-013 — `/harness-validate` is covered by the smoke test

- **Statement**: `tests/harness.test.mjs` shall exercise `/harness-validate`,
  asserting each path it can take and refusing the ones that must not run.
- **Rationale**: the command has shipped with no test at all, and it is the one
  path that writes the requirements file — the artifact the whole contract rests
  on. Its sibling `/harness-end` is covered three times over, so the gap is not
  that the command is hard to drive: the smoke test registers every command and
  already calls the handler directly, so `/harness-validate` was reachable from
  the start. An earlier report claimed it could not be exercised; that was wrong,
  and the honest reading is that the path was left uncovered.
- **Acceptance**:
  - [ ] With no design session open, `/harness-validate` notifies that there is
        nothing to approve and runs no pipeline: no step message is sent.
  - [ ] With a session open, it runs a one-step pipeline whose only step is the
        architect, in the `analysis` mode, and the step message carries the
        approval.
  - [ ] It leaves the session **open**: the next plain message still reaches the
        architect. Approving is not finishing, and that is the property most
        worth a test.
  - [ ] The optional argument is passed through to the architect as the note.
  - [ ] It does nothing when a pipeline is already running, and it needs no UI to
        fail safely.
  - [ ] The `session:` cases assert no architect action closes a session, and
        these assert that `/harness-validate` does not close one either.
- **Traces**: `tests/harness.test.mjs`, `.pi/extensions/harness.ts`
  (`harness-validate` handler), `prompts/architecture.md`
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-014 — The tests are a step of their own, and they gate delivery

- **Statement**: The harness shall ship a `tester` agent and shall run it
  between the implementer and delivery in the `full` workflow, so that the
  implementer makes the change and the tester writes and runs the tests;
  delivery shall run only when the checks the tester declared pass. `update`
  shall insert the `tester` step into an existing installation whose
  `workflows.full.steps` is still the previously shipped list.
- **Rationale**: the implementer today writes the change, writes the tests and
  runs the whole suite in one turn, so the checks it reports are its own and
  nobody looks at them until delivery. Splitting the duty gives the tests an
  agent of their own whose declared checks are the ones the harness gates on,
  and that is the reason to split: a second agent that only observes the result
  earns its cost only if its result can stop the run. The implementer keeps the
  cheapest check that proves the code builds, so the tester is never handed
  something that does not compile. The `update` migration exists because
  `mergeAdditive` never rewrites a YAML sequence: without it the new agent block
  is added and the tester never runs on any existing installation.
- **Acceptance**:
  - [ ] `workflows.full.steps` is
        `orchestrator -> explorer -> critic -> implementer -> tester -> delivery`;
        `full-dry-run` and `analysis` are unchanged.
  - [ ] `agents.tester` declares `mutates_files: true` and the tools it needs
        (`filesystem`, `shell`, `tests`, `engram`, `codegraph`).
  - [ ] The implementer no longer runs the full suite; it runs the cheapest
        check that proves the change builds, and says which one it ran.
  - [ ] `prompts/tester.md` tells the tester to write the tests the change
        needs, run the project's checks, and never edit production code.
  - [ ] The harness re-runs the **tester's** declared checks before delivery
        (REQ-002 already captures the last `mutates_files` step).
  - [ ] `REQUIRED_AGENTS` and `validate` include `tester`.
  - [ ] The adjusted plan from the critic lists the test files it expects, so
        REQ-003's diff comparison does not read every added test as a
        discrepancy.
  - [ ] `update` inserts the tester step when the local list is exactly the
        previously shipped one, keeps a customised list and reports it, and is
        idempotent; `tests/install.test.mjs` covers both cases.
  - [ ] `tests/harness.test.mjs` asserts the new order and the tester's grant.
- **Traces**: `harness.config.yaml`, `harness.config.example.yaml`,
  `prompts/tester.md`, `prompts/implementer.md`, `prompts/critic.md`,
  `.pi/extensions/harness.ts` (`REQUIRED_AGENTS`, `MODES`),
  `bin/pi-minimal-harness.mjs` (`full` steps migration),
  `tests/harness.test.mjs`, `tests/install.test.mjs`
- **Issue**: #28
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-015 — A failing test sends the work back to the implementer, bounded at three rounds

- **Statement**: When the tester declares a check as `failed`, the harness
  shall start a repair round that returns the failure to the implementer and
  runs the tester again, shall not re-run the explorer or the critic, and shall
  stop the pipeline after the third round without reaching delivery.
- **Rationale**: stopping at the first red test hands the user an unfinished
  branch and no next move, which is the same dead end as stopping on a step
  error. The round is sequenced by the driver rather than invoked by the
  tester, for the reason the harness has already removed the model from three
  things: a model that decides to retry also decides when to stop retrying.
  The explorer and the critic do not re-run because the plan already exists;
  re-deriving it costs two turns to restate what is on disk. Three rounds is a
  bound, not a target: past the third the failure is the final answer, because a
  plan that cannot pass its own tests in three goes is a plan the user should
  see rather than one the harness keeps spending turns on.
- **Acceptance**:
  - [ ] A declared check that is `failed` does not end the pipeline: the
        implementer runs again with the tester's failure — the command and its
        output — as `{{previous}}`.
  - [ ] The counter lives in the driver; the tester never invokes the
        implementer and cannot reset the count.
  - [ ] At most three repair rounds; after the third there is no delivery and
        the last failure is the final answer.
  - [ ] Delivery never runs while a declared check is `failed`; `skipped` is not
        a pass.
  - [ ] A round that passes continues to delivery, and no round re-runs the
        explorer or the critic.
  - [ ] `tests/harness.test.mjs` covers: one failed round then success reaches
        delivery; three failures stop the pipeline; the model cannot reset the
        counter.
- **Traces**: `.pi/extensions/harness.ts` (repair round, check gate),
  `prompts/implementer.md`, `prompts/delivery.md`, `tests/harness.test.mjs`
- **Issue**: #28
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-016 — An errored or interrupted pipeline leaves a way forward

- **Statement**: When a step ends in a model error, the harness shall retry it
  before stopping; and when a pipeline stops with steps left, it shall record
  its state and offer to continue from where it stopped rather than starting
  over.
- **Rationale**: a run that stalls mid-flight leaves implemented-but-undelivered
  work in the tree with no way out of it. `runPipeline` always starts at step 0,
  so the next request re-runs the whole workflow; and since REQ-011 the
  orchestrator has no tools, so on that re-run it can only carry the issue
  number it reads in the task text, reaches delivery with `none`, and delivery
  stops to ask the user to authorise creating an issue — the work is finished
  and the harness reports that nothing can be done with it. Retrying the errored
  step handles the common case, a transient provider failure, at the cost of one
  turn; persisting the stopped run and resuming it preserves the context a
  restart throws away, the issue included. `/harness-delivery` already exists and
  was never advertised, which is the part of this a user notices first.
- **Acceptance**:
  - [ ] A step ending with `stopReason: error` is retried, bounded (one by
        default), and the retry is announced.
  - [ ] On a stop with steps remaining, the state (`mode`, `task`, the completed
        steps, the failed step) is persisted with `pi.appendEntry()` and survives
        a `/reload`.
  - [ ] `/harness-resume` continues from the step after the last completed one,
        without re-running them and without re-running the orchestrator, so the
        issue it carried is not lost.
  - [ ] The stop message names the step it stopped at, says the tree holds
        partial work, and names the two exits: `/harness-resume` and
        `/harness-delivery`.
  - [ ] A plain message after a stopped pipeline does not silently re-run the
        whole workflow while one is stopped: the harness says so and offers the
        resume.
  - [ ] `tests/harness.test.mjs` covers: a step error retried once; a stopped
        pipeline resumed from the right step; the persisted state surviving a
        re-import.
- **Traces**: `.pi/extensions/harness.ts` (step retry, pipeline state,
  `runPipeline` start-at, `harness-resume`, input hook), `pi-minimal-harness.md`,
  `README.md`, `AGENTS.md`, `tests/harness.test.mjs`
- **Issue**: #29
- **Priority**: P1
- **Status**: `IMPLEMENTED`

### REQ-017 — A step reads Engram before it works, not only after

- **Statement**: The harness shall instruct every agent whose output depends on
  prior project knowledge to consult Engram before it proposes anything, and
  shall ensure each of those agents holds the tools that read it. The architect,
  the explorer, the implementer and the critic shall each begin from
  `mem_context` and `mem_search`, named in their prompt templates alongside the
  `mem_save` they already name, and `pi-minimal-harness.md` shall state the
  read-before-work duty rather than only the "search before repeating work"
  advice.
- **Rationale**: the pipeline's eight Engram mentions are all `mem_save` — three
  agents write and no step is told to read. The only read paths are the
  provider's "when the user asks to recall past work" and recovery after a
  compaction, and `session_start` injects nothing, so memories accumulate
  unread: the architect re-derived from scratch a design memory may already have
  held. The write cost is paid on every run and the read benefit almost never
  collected. The critic is the sharpest case: the one step whose job is to catch
  a repeated mistake is the one that cannot consult what the project already
  learned.
- **Acceptance**:
  - [ ] `prompts/architecture.md`, `prompts/explorer.md`, `prompts/implementer.md`
        and `prompts/critic.md` each name the read — `mem_context` for recent
        history, then `mem_search` for keywords — before the step proposes or
        edits.
  - [ ] `agents.critic.tools` gains `engram`; the architect, explorer and
        implementer keep the grant they already have.
  - [ ] `pi-minimal-harness.md` (§Memory) states the read-before-work duty, not
        only the search advice.
  - [ ] The read is a starting point, never a gate: empty or absent memory does
        not stop the step, and the instruction degrades to "continue without it"
        like the CodeGraph grant.
  - [ ] The orchestrator and delivery are neither instructed to read nor granted
        `engram`; the router stays tool-less (REQ-011).
  - [ ] `tests/harness.test.mjs` asserts each template names the read and that
        the critic holds the grant.
- **Traces**: `prompts/architecture.md`, `prompts/explorer.md`,
  `prompts/implementer.md`, `prompts/critic.md`, `pi-minimal-harness.md`,
  `harness.config.yaml`, `harness.config.example.yaml`, `tests/harness.test.mjs`
- **Issue**: #31
- **Priority**: P2
- **Status**: `IMPLEMENTED`

### REQ-018 — The published surface matches what the harness actually does

- **Statement**: The published documentation shall describe the harness as it
  now exists. `README.md` shall list all seven agent prompt templates, shall
  show the `tester` step in the `workflows.full.steps` configuration reference,
  shall describe the contract as the separate `pi-minimal-harness.md` file the
  installer writes and that `AGENTS.md` merely references, shall state the
  current counts of the two test suites, and shall document the
  `workflows.full.steps` migration that `update` performs.
  `harness.config.example.yaml` shall carry a commented example of
  `defaults.subagent_context_file` with its default value explained, leaving the
  key undefined, and the repository's `AGENTS.md` shall stop stating that the
  repository has no `package.json`.
- **Rationale**: the implementation is ahead of its own front door. REQ-014
  added the `tester` agent and its step, `update` grew the migration that
  inserts it, and the package gained a `bin` — and none of that reached the
  published surface. An adopter who reads the configuration reference copies a
  five-step `full` workflow and never learns the tester exists; one who reads
  the install instructions is told the installer writes "the AGENTS.md
  contract" when the contract is a file of its own; and a reader of
  `AGENTS.md` is told there is no `package.json` in a repository that now
  publishes one. The example template is what `init`/`update` merge from, so
  omitting `subagent_context_file` there means the key the README documents can
  never reach a fresh installation. The example is commented rather than active
  because the resolution chain already falls back to `pi-minimal-harness.md`, so
  an active value would duplicate the default; the key only matters when a
  project keeps its contract elsewhere, so the template documents it as an opt-in
  example instead of shipping a redundant value. Documentation that contradicts the code is
  worse than absent documentation: it is trusted.
- **Acceptance**:
  - [ ] The README's prompt-template list names all seven templates —
        `architect`, `orchestrator`, `explorer`, `critic`, `implementer`,
        `tester`, `delivery` — and its project tree lists `tester.md` and
        `architecture.md`.
  - [ ] The README's configuration reference shows
        `full: { steps: [orchestrator, explorer, critic, implementer, tester, delivery] }`,
        matching `harness.config.yaml`.
  - [ ] The README describes the contract as a file of its own that `AGENTS.md`
        references, and no phrase calls `AGENTS.md` itself the contract.
  - [ ] The README's test counts match the current output of
        `node tests/harness.test.mjs` and `node tests/install.test.mjs`.
  - [ ] The README's configuration reference documents `requirements_format`,
        `check_timeout_ms` and `subagent_context_file`, the `defaults` keys the
        example template ships.
  - [ ] The README's upgrade section states that `update` migrates
        `workflows.full.steps` to insert `tester`.
  - [ ] `harness.config.example.yaml` carries a commented
        `defaults.subagent_context_file` example with the default value explained,
        and the key is left undefined.
  - [ ] `AGENTS.md` no longer states there is no `package.json`, and names the
        published `bin` where it describes the repository's files.
  - [ ] Only `README.md`, `AGENTS.md` and `harness.config.example.yaml` change:
        no loader, driver, prompt or installer behaviour is touched, and no new
        test is required because the change is prose and one config key.
- **Traces**: `README.md`, `AGENTS.md`, `harness.config.example.yaml`
- **Issue**: #35
- **Priority**: P2
- **Status**: `IMPLEMENTED`

### REQ-019 — The requirements file does not count as a dirty tree

- **Statement**: The harness shall not treat the configured requirements file as
  a dirty working tree when it computes the repository preflight. When the only
  paths the working tree changed under `HEAD` — tracked modifications and
  untracked files alike — are the file named by `defaults.requirements_file`,
  the advisory preflight shall report nothing and the blocking gate shall have no
  blocker; any other changed path shall restore both behaviours unchanged. The
  rule shall be decided by path, not by step or mode, so it holds for the
  architect step, for the `analysis` mode and for every other workflow alike.
- **Rationale**: a design session's normal output is the requirements file
  itself. The architect writes it only on approval, and while the session stays
  open every plain message is another architect turn — each turn its own
  pipeline — so the preflight runs again and warns about the very change the user
  just approved; under `defaults.preflight_policy: blocking` the same file stops a
  subsequent run. The architect is already exempt from the blocking gate
  (`ARCHITECT_AGENT`), but that exemption is by step: it hides a genuinely dirty
  tree from the architect while still warning about a tree whose only difference
  is harness-owned output. The requirements file is not unknown work someone left
  behind — it is the artifact the harness instructed the architect to write and
  the user approved — so it is the wrong reason to warn or to block. Deciding by
  path is what keeps the rest of the preflight intact: a second changed file,
  even alongside the requirements file, restores the warning.
- **Acceptance**:
  - [ ] When the changed paths (`git diff --name-only HEAD` plus untracked
        files, as `collectChangedPaths` already gathers them) are exactly the
        configured requirements file, the advisory preflight returns null and
        `formatBlockingPreflight` returns no blockers.
  - [ ] Any other changed or untracked path restores the warning and the
        blocker, with the requirements file present or not.
  - [ ] The rule depends on the path, not on the agent or the mode: it applies
        to the architect step without an `ARCHITECT_AGENT`/`ANALYSIS_MODE`
        special case.
  - [ ] The configured name is honoured, including a directory in it
        (`docs/REQ.md`), and a `requirements_file` that is not among the changed
        paths changes nothing.
  - [ ] The extra git work is conditional on the repository already being
        dirty, so a clean tree pays no additional command.
  - [ ] Paths are compared in the same normalized (forward-slash) form
        `collectChangedPaths` emits, so the rule does not depend on the platform
        separator.
  - [ ] The decision lives in a pure, exported helper, and
        `tests/harness.test.mjs` covers: only the requirements file dirty → no
        warning and no blocker; the file plus one code path dirty → both
        return; a clean tree is unaffected.
  - [ ] REQ-016's resume exemption is unchanged, and the blocking gate still
        stops on every other blocker it already reports.
- **Traces**: `.pi/extensions/harness.ts` (`runPipeline`, `collectChangedPaths`,
  the preflight formatters or a new pure helper), `tests/harness.test.mjs`
- **Issue**: #35
- **Priority**: P2
- **Status**: `IMPLEMENTED`

### REQ-020 — The architect's prompt states the issue duty it is expected to perform

- **Statement**: `prompts/architecture.md` shall instruct the architect, on
  `/harness-validate`, to decide whether the approved scope needs one issue or
  several, to create them with the granted GitHub tooling, and to report which
  issue each requirement belongs to. `pi-minimal-harness.md`, `README.md` and
  `docs/WORKFLOW.md` shall state that the architect owns the issues.
- **Rationale**: REQ-011 gave the architect the `github` grant and left the
  orchestrator tool-less, but the architect's own prompt never names the duty —
  it has zero mentions of "issue" — and the published contract and the
  README/workflow docs never state the ownership either, although REQ-011's
  acceptance required it of them. The duty therefore exists only as implemented
  terminal requirement text, which the model never reads at step time; the
  prompt — the only channel the architect reads — is silent, so the grant goes
  unused and the user has to ask for the issue. Instructions live where the step
  reads them: the issue duty is an architect-step instruction, and it belongs in
  the architect's prompt and the contract the step points at.
- **Acceptance**:
  - [ ] `prompts/architecture.md` names the duty: on `/harness-validate`,
        decide one issue or one per separable group, create them with the granted
        GitHub tooling, and record the number in each requirement block.
  - [ ] `pi-minimal-harness.md` states that the architect owns the issues.
  - [ ] `README.md` and `docs/WORKFLOW.md` say the same, closing the unmet
        half of REQ-011's acceptance criterion.
  - [ ] A repository that does not require issue-linked pull requests keeps
        working with `none`: REQ-011's rule is unchanged, only now stated where
        it is read.
  - [ ] No harness code change: the grant and the GitHub tool already exist;
        this is prose that makes them reachable.
  - [ ] `tests/harness.test.mjs` asserts the prompt names the duty, a content
        check in the style REQ-017 uses for the Engram read.
- **Traces**: `prompts/architecture.md`, `pi-minimal-harness.md`, `README.md`,
  `docs/WORKFLOW.md`, `tests/harness.test.mjs`
- **Issue**: #35
- **Priority**: P2
- **Status**: `IMPLEMENTED`

## Modifications

- `prompts/orchestrator.md` — REQ-008 and REQ-011: route and hand over, without
  analysing; issues belong to the architect, and the router has no tool for them.
- `prompts/architecture.md` — REQ-007, REQ-011 and the write rule above: the
  architect may write the scope only on your validation and only while a
  requirement is not terminal, and creates the issue the work closes. REQ-017: it
  reads Engram before it proposes.
- `prompts/implementer.md` — REQ-007 and the write rule above: the implementer
  may move `Status` to `IMPLEMENTED` when its checks pass and its acceptance
  criteria are certified, and may touch nothing else in the block. REQ-014 and
  REQ-015: it implements the change and runs only the cheapest check that
  proves it builds, it hands the tests to the tester, and on a repair round it
  receives the tester's failure as `{{previous}}`. REQ-017: it reads Engram before
  it edits.
- `prompts/delivery.md` — REQ-002 (the harness runs the checks, not the agent),
  and REQ-012 (this is where the branch rule lives, so the skill points here).
  REQ-014 and REQ-015: the checks it is gated on are the tester's, and it never
  runs while a declared check is `failed`.
- `prompts/explorer.md` — REQ-001, on the dispatch path only. REQ-017: it reads
  Engram before it proposes.
- `prompts/tester.md` (new) — REQ-014: write the tests the change needs, run
  the project's checks, and never edit production code.
- `prompts/critic.md` — REQ-014: the adjusted plan lists the test files it
  expects, so REQ-003's diff comparison does not read every test the tester adds
  as a discrepancy. REQ-017: it reads Engram before it challenges the plan.
- `.pi/extensions/harness.ts` — the `<repo_content>` wrapper, the check gate before
  delivery, the plan-versus-diff comparison, the dispatch overlap refusal, the
  two new commands, the removal of the architect's own close, and the persisted
  design-session state. REQ-014 `REQUIRED_AGENTS` and the mode string, REQ-015
  the bounded repair round the driver owns, REQ-016 the step retry, the
  persisted stopped-pipeline state, `runPipeline` start-at and `/harness-resume`.
- `harness.config.yaml`, `harness.config.example.yaml` — REQ-006
  `defaults.requirements_format`, REQ-008 and REQ-011 the tools each agent is
  granted, and this repository's own `req-n`. REQ-017: `engram` reaches the
  critic, and still nobody else.
- `bin/pi-minimal-harness.mjs` (`ensureRequirements`) — REQ-006: emit the shape
  the project chose, and honour `defaults.requirements_file`. REQ-014: migrate
  `workflows.full.steps` to include the tester when the local list is still the
  previously shipped one.
- `.agents/skills/github-delivery/SKILL.md` — REQ-012: point at the prompt that
  owns the branch rule instead of restating it.
- `tests/install.test.mjs`, `tests/harness.test.mjs` — one test per requirement,
  each asserting the refusal rather than only the success path; REQ-013 covers
  `/harness-validate`, which has shipped without a single test. REQ-017 asserts
  each of the four templates names the read and that the critic holds the grant.
- `AGENTS.md`, `pi-minimal-harness.md`, `README.md`, `docs/WORKFLOW.md`,
  `CHANGELOG.md` — the published surface follows the change, including the
  read-before-work duty REQ-017 adds to the contract's memory section.
- `README.md`, `AGENTS.md`, `harness.config.example.yaml` — REQ-018: the
  published surface catches up with what the implementation and the installer
  already do after REQ-014 and the published `bin` — the seven prompts, the
  tester step, the contract as its own file, the current test counts, the
  missing `defaults` keys and the `workflows.full.steps` migration.
- `.pi/extensions/harness.ts` (`runPipeline`, the preflight helpers) and
  `tests/harness.test.mjs` — REQ-019: the requirements file the architect just
  wrote is project-owned output, not unknown work, so it no longer counts as a
  dirty tree for the advisory warning or the blocking gate.
- `prompts/architecture.md`, `pi-minimal-harness.md`, `README.md`,
  `docs/WORKFLOW.md`, `tests/harness.test.mjs` — REQ-020: the architect's
  prompt names the issue duty it is expected to perform, and the contract and
  the docs state that the architect owns the issues.

## Out of scope

- Defects 1-2, 6 and 10, already closed by pull request #25: the structured
  `harness_decision`, `harness_report` and `harness_session` tools,
  `defaults.preflight_policy`, and the typed `BLOCKED` verdict that stops the
  pipeline before the implementer. Listed here so they do not creep back in as new
  work; REQ-007 removes the architect's use of `harness_session`, not the tool's
  `START`.
- Defect 7 — Engram provenance, expiry and correction. It depends on capabilities
  the memory server does not expose to the harness; revisit when it does. It is
  not a prompt change.
- **Trusting repository content that the harness never sees.** REQ-001 covers the
  two sources the harness itself injects into a dispatched subagent's prompt as
  data — the declared project skills and the project's `AGENTS.md`. What an agent
  reads with its own tools — an `AGENTS.md` in a subdirectory, a source comment, a
  pull request body — passes through Pi's tool layer, not this extension, so
  there is no interception point here. Closing that needs a change at the tool
  layer, not in this project. Named so the gap is visible rather than assumed
  covered.
- The remainder of defect 9 — validating markdown headings, `Closes #N` and
  `type:*` prose. The structured fields are already enforced; parsing free-form
  markdown is brittle and has no consumer today. Deferred deliberately, not
  forgotten.
- Tracking which individual `REQ-nnn` has been approved. `/harness-validate`
  approves the agreed content as a whole; a session may approve several blocks in
  sequence without per-requirement state.
- Migrating requirements files written in an older format. No project runs the
  version that introduced the file, so an `update` to this version finds no
  requirements file and creates one in the configured shape. "Never overwrite an
  existing file" stays in `ensureRequirements` as a safety net rather than a
  migration path, and until a project adopts this version only
  `tests/install.test.mjs` exercises it.
- Merging, closing or rebasing pull requests #25 or #26, and changing
  `preflight_policy` to `blocking`. That decision belongs to a clean working
  tree.
- The workflows, the agents and their models. No behaviour changes outside
  `.pi/extensions/harness.ts`, `prompts/`, `bin/pi-minimal-harness.mjs`,
  `harness.config.yaml`, the published documentation and the tests.
- No new npm dependency, and no target-application specifics in the published
  surface.