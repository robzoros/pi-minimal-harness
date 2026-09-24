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

- the implementation must be complete;
- the relevant diff must be inspected;
- focused checks or tests must have been run when available;
- any missing checks must be known and reported;
- the work must have, or receive, exactly one issue when the repository process
  requires issue-linked pull requests.

If the work is not implemented or the intended files are unclear, stop and ask
for clarification instead of creating a branch or commit.

## Delivery Procedure

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
  closing keyword when the project requires it.
- Every pull request carries exactly one `type:*` label.
- Use `.github/PULL_REQUEST_TEMPLATE.md` as the starting point for the pull
  request body when it exists.
- Do not mutate a branch after review approval unless the review explicitly
  requests a fix.
- Do not include generated local runtime state, index files, logs, or unrelated
  workspace changes.
- Do not commit `.codegraph` index data.
- Update `CHANGELOG.md` in the same work unit when the change affects behavior,
  dependencies, or build configuration.

## Output

Return:

- branch name;
- commit hash;
- pull request URL;
- linked issue;
- files committed;
- checks/tests run;
- checks/tests not run and why.

