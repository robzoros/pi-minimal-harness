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
Pull request #26 is merged, so the six `IMPLEMENTED` requirements below are on
`main`.

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
- **Status**: `DRAFT`

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
- **Status**: `DRAFT`

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
- **Status**: `DRAFT`

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
- **Status**: `DRAFT`

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
- **Status**: `DRAFT`

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
- **Status**: `DRAFT`

## Modifications

- `prompts/orchestrator.md` — REQ-008 and REQ-011: route and hand over, without
  analysing; issues belong to the architect, and the router has no tool for them.
- `prompts/architecture.md` — REQ-007, REQ-011 and the write rule above: the
  architect may write the scope only on your validation and only while a
  requirement is not terminal, and creates the issue the work closes.
- `prompts/implementer.md` — REQ-007 and the write rule above: the implementer
  may move `Status` to `IMPLEMENTED` when its checks pass and its acceptance
  criteria are certified, and may touch nothing else in the block.
- `prompts/delivery.md` — REQ-002 (the harness runs the checks, not the agent),
  and REQ-012 (this is where the branch rule lives, so the skill points here).
- `prompts/explorer.md` — REQ-001, on the dispatch path only.
- `.pi/extensions/harness.ts` — the `<repo_content>` wrapper, the check gate before
  delivery, the plan-versus-diff comparison, the dispatch overlap refusal, the
  two new commands, the removal of the architect's own close, and the persisted
  design-session state.
- `harness.config.yaml`, `harness.config.example.yaml` — REQ-006
  `defaults.requirements_format`, REQ-008 and REQ-011 the tools each agent is
  granted, and this repository's own `req-n`.
- `bin/pi-minimal-harness.mjs` (`ensureRequirements`) — REQ-006: emit the shape
  the project chose, and honour `defaults.requirements_file`.
- `.agents/skills/github-delivery/SKILL.md` — REQ-012: point at the prompt that
  owns the branch rule instead of restating it.
- `tests/install.test.mjs`, `tests/harness.test.mjs` — one test per requirement,
  each asserting the refusal rather than only the success path; REQ-013 covers
  `/harness-validate`, which has shipped without a single test.
- `AGENTS.md`, `pi-minimal-harness.md`, `README.md`, `docs/WORKFLOW.md`,
  `CHANGELOG.md` — the published surface follows the change.

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