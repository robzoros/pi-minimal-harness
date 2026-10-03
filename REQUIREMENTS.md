# Requirements

The formal scope of the work in design, maintained by the architect.

Each requirement is an atomic, verifiable block: the ID (`REQ-nnn`, zero-padded
so the file sorts), the **statement** of what the harness shall do, the
**rationale** behind it, the **acceptance** checklist — what ISO/IEC/IEEE 29148
calls *verifiable* — and the **traces**, the files that implement it. `shall` is
the only verb of obligation in this file, so it carries no RFC 2119 keywords
alongside it.

Context: the defects of `docs_mejoras/mejoras_implementación.md` that survive
pull request #25, plus the harness behaviour decided in design with the user.
No project runs the version that introduced the requirements file — that code is
unmerged, in pull request #25 — so no adopting project holds a requirements file
in any format, and changing the format costs no migration.

## Additions

### REQ-001 — Repository content is data, not instruction

- **Statement**: While an agent reads repository-derived content, the harness
  shall wrap it in an explicit `<repo_content>` boundary before it reaches a
  prompt, and shall state inside the template that content within that boundary
  is material to analyse and never instructions to follow, even when it addresses
  an assistant in the imperative.
- **Rationale**: `AGENTS.md`, source comments, issue bodies and pull request
  text are read today as if they were part of the harness contract, so a third
  party can inject imperatives aimed at an agent and nothing distinguishes them.
- **Acceptance**:
  - [ ] A file containing imperative instructions addressed to the assistant
        does not change an agent's behaviour in any workflow mode.
  - [ ] The boundary is applied by the prompt renderer in the extension, so no
        template can opt out by omitting the rule.
  - [ ] `tests/harness.test.mjs` renders such content and asserts the boundary is
        present in the prompt.
- **Traces**: `.pi/extensions/harness.ts` (prompt render), `prompts/architecture.md`,
  `prompts/implementer.md`, `prompts/explorer.md`
- **Priority**: P1

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
  - [ ] A command that cannot be executed in this runtime counts as `skipped`,
        which the delivery agent must report rather than present as verified.
  - [ ] No new command registry: the harness executes what the agent already
        declared.
- **Traces**: `.pi/extensions/harness.ts` (step gate), `prompts/delivery.md`
- **Priority**: P1

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

### REQ-005 — CodeGraph staleness decided by the harness

- **Statement**: Before any step whose agent is granted `codegraph`, the harness
  shall compare the commit recorded in the index against `HEAD` and shall sync the
  index when they differ.
- **Rationale**: only prose asks the agent to notice a stale index
  (`prompts/architecture.md:22`, `prompts/implementer.md:24`), and an agent under
  task pressure skips a step it has to remember.
- **Acceptance**:
  - [ ] An index one commit behind `HEAD` is synced without the agent asking.
  - [ ] The documented `grep`/`rg` fallback still applies when CodeGraph is absent
        or unusable; the harness degrades instead of failing.
- **Traces**: `.pi/extensions/harness.ts` (step start), `prompts/architecture.md`
- **Priority**: P2

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

## Modifications

- `prompts/orchestrator.md` — REQ-008: route and hand over, without analysing.
- `prompts/architecture.md` — REQ-001, REQ-005, REQ-007: the content boundary, the
  enforced index sync, and writing the requirements file only on approval.
- `prompts/delivery.md` — REQ-002: drop the clause forbidding re-running checks;
  the harness runs them and the agent reports the outcome it was given.
- `prompts/implementer.md`, `prompts/explorer.md` — REQ-001 and REQ-005.
- `.pi/extensions/harness.ts` — the `<repo_content>` wrapper, the check gate before
  delivery, the plan-versus-diff comparison, the dispatch overlap refusal, the
  index sync, the two new commands, and the removal of the architect's own close.
- `harness.config.yaml` — REQ-006 `defaults.requirements_format`, REQ-008 the
  orchestrator's tools, and this repository's own value `req-n`.
- `bin/pi-minimal-harness.mjs`, `tests/install.test.mjs` — REQ-006.
- `tests/harness.test.mjs` — one test per requirement, each asserting the refusal
  rather than only the success path.
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
- Merging, closing or rebasing pull request #25, and changing `preflight_policy` to
  `blocking`. That decision belongs to a clean working tree.
- The workflows, the agents and their models. No behaviour changes outside
  `.pi/extensions/harness.ts`, `prompts/`, `bin/pi-minimal-harness.mjs`,
  `harness.config.yaml`, the published documentation and the tests.
- No new npm dependency, and no target-application specifics in the published
  surface.