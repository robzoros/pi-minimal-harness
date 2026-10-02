---
name: github-delivery
description: Deliver completed project work through GitHub by creating the branch, commit, push, and pull request with the project conventions.
---

# GitHub Delivery

Use this skill when completed project work must be delivered through GitHub.

The goal is to turn verified local changes into a reviewable pull request
without changing unrelated files or rewriting already reviewed work.

## Preconditions

Delivery is a verification step, not a formality. Check all of it yourself; do
not take another agent's word for any of it.

- Every delivered requirement is traced to a change, a review and a check.
- The work has been reviewed, and the review's findings were resolved rather
  than explained away.
- The project's required checks passed. A skipped check is a delivery blocker
  unless it is reported prominently as a known gap, with the reason it could
  not run.
- The changelog is current and its entries correspond to the changes actually
  made.
- The issue and the branch are linked to each other and to the work.
- No known inconsistency blocks delivery: no failing check, no unreviewed
  change, no requirement quietly dropped.
- The intended files are identified and understood.

If any precondition fails, **stop and report what is missing**. Do not deliver around a blocker.
If the work is not implemented, or the intended files are unclear, stop and ask for
clarification instead of creating a branch or commit.

## Delivery Procedure

1. Inspect repository state with `git status`.
2. Confirm the intended changed files, and that nothing else rode along.
3. Check existing branches and choose a short English branch name. Work on a
   fresh branch; never rewrite a branch whose pull request was already reviewed
   or merged.
4. Create the branch before committing when the work is still on the base
   branch.
5. Stage only the intended files.
6. Commit using the repository's Conventional Commits convention.
7. Push the branch to `origin`.
8. Create or update the pull request with `gh pr create` or `gh pr edit`.
9. Include the issue linkage, change summary, and checks actually run.
10. Report the branch, commit, pull request URL, and verification evidence.

## Delivery Rules

- Every pull request links exactly one issue using `Closes #N` or an equivalent
  closing keyword when the project requires it.
- Every pull request carries exactly one `type:*` label.
- Use `.github/PULL_REQUEST_TEMPLATE.md` as the starting point for the pull
  request body when it exists.
- Do not mutate a branch after review approval unless the review explicitly
  requests a fix.
- Do not modify source to make a delivery succeed.
- Do not include generated local runtime state, index files, logs, or unrelated
  workspace changes.
- Do not commit `.codegraph` index data.
- Update `CHANGELOG.md` in the same work unit when the change affects behavior,
  dependencies, or build configuration.
- Do not merge. Merge, release and the final acceptance call belong to the
  maintainer.

## Output

Return:

- branch name;
- commit hash;
- pull request URL;
- linked issue;
- files committed;
- checks/tests run;
- checks/tests not run and why.

