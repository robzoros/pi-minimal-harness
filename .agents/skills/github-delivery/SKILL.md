---
name: github-delivery
description: Deliver completed project work through GitHub by creating the branch, commit, push, and pull request with the project conventions.
---

# GitHub Delivery

Use this skill when completed project work must be delivered through GitHub.

The goal is to turn verified local changes into a reviewable pull request
without changing unrelated files or rewriting already reviewed work.

## Preconditions

Before delivery:

- the implementation must be complete and the implementer must have inspected
  its own diff; you only confirm the files it reported are the files staged;
- focused checks or tests must have been run when available;
- any missing checks must be known and reported;
- the work must have exactly one issue when the repository process requires
  issue-linked pull requests. The issue number comes from the orchestrator's
  handoff (or the task). If it is missing, ask the user to authorize creating
  it and stop; if the user denies, report the denial as the reason delivery did
  not happen;
- the work must sit on a branch you may deliver from. Creating a fresh branch
  from the base branch, named after the change, is the default and needs no
  permission. Ask the user which branch to use when the work already sits on a
  branch whose pull request is open or was reviewed, or when the target branch
  is otherwise a choice you cannot make;
- a `CHANGELOG.md` entry must already exist when the change needs one. You have
  no file-editing tools: report a missing entry instead of writing it.

If the work is not implemented, the intended files are unclear, or the required
issue is unknown, stop and ask for clarification instead of creating a branch or
commit.

## Asking the user

A missing branch or issue is a question for the user, not a dead end: ask to
create it and stop. You never invent the missing piece, and you never create one
unasked.

You cannot block on an answer inside your own turn, so the request ends the step:

1. Create nothing yet — no issue, no branch, no commit, no push.
2. Put the request in the `### Delivery` section: what is missing, exactly what
   you would create (the issue title, the branch name), and what in the
   repository makes it necessary.
3. Stop. The user answers in a follow-up run, and that run continues the
   delivery with the answer in hand.

If the user denies, the follow-up run reports the denial as the reason delivery
was skipped and creates nothing. A denial is never a hint to proceed anyway.

## Delivery Procedure

The delivery agent normally runs with `git` and `github` tools and no shell, so
selective staging depends on what those tools expose. If staging single paths is
not available, stage exactly the paths the implementer reported as changed; if
that is not possible either, stop and report instead of staging the whole tree.

Settle the branch and, where the project requires one, the issue before step 1.
If either needs the user's authorization, ask and stop as described above; do
not begin the procedure until both are settled.

1. Inspect repository state with `git status`.
2. Confirm the intended changed files.
3. Check existing branches and choose a short English branch name.
4. Create the branch before committing when the work is still on the base branch.
5. Stage only the intended files.
6. Commit using the repository's Conventional Commits convention.
7. Push the branch to `origin`.
8. Create or update the pull request with `gh pr create` or `gh pr edit`.
9. Include the issue linkage, change summary, and checks actually run.
10. Report the branch, commit, pull request URL, and verification evidence.

## Delivery Rules

- Every pull request links exactly one issue using `Closes #N` or an equivalent
  closing keyword when the project requires it. Use the issue number the
  orchestrator supplied; never invent one. When none was supplied and the
  project requires one, ask the user to authorize creating it and stop.
- Every pull request carries exactly one `type:*` label. Derive it from the
  commit type and the labels `.github/PULL_REQUEST_TEMPLATE.md` offers
  (`feat` → the feature label, `fix` → the bug label, and so on); when the
  mapping is not obvious from the template or the repository's own
  `AGENTS.md`, stop and ask instead of guessing.
- Use `.github/PULL_REQUEST_TEMPLATE.md` as the starting point for the pull
  request body when it exists.
- Do not mutate a branch after review approval unless the review explicitly
  requests a fix.
- Do not include generated local runtime state, index files, logs, or unrelated
  workspace changes.
- Do not commit `.codegraph` index data.
- Verify `CHANGELOG.md` carries the entry when the change affects behavior,
  dependencies, or build configuration. The implementer owns that edit; if the
  entry is missing, report it instead of writing it.

## Output

Return the delivery report in the same two sections the delivery prompt
requires — `### Delivery` and `### Test plan status` — and report through
`harness_report` with `changed_files`, `checks`, `notes` and `lessons`.

Cover:

- branch name, commit hash and pull request URL (or why delivery was skipped,
  including an authorization you asked for and the user's answer to it);
- the linked issue, when the repository requires issue-linked pull requests;
- the files committed;
- the checks reported as run, and the ones that could not run. The
  implementer's report is the source of truth; in `delivery-only`, the
  verification evidence in the orchestrator's handoff. The delivery agent has
  no test runner, so it never claims a check it did not see reported.

