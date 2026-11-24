---
title: "Worktree Isolation Protocol"
version: 3.8.52
lastUpdated: 2026-10-18
---

# Worktree Isolation Protocol

> Operational deep-dive for AGENTS.md → Git Workflow → "Worktree isolation" and Hard Rules
> #19/#22. The normative rules live in `AGENTS.md`; this file carries the step-by-step
> procedure, commands, and incident history.

## Why isolation is mandatory

Multiple sessions/agents work this repo in parallel. The main checkout is **shared**, so a
`git checkout`/branch switch in it silently discards another session's uncommitted work and
yanks the branch out from under whatever else is running (incidents: 2026-06-05, 2026-06-13).

**Rule: never develop on the shared main checkout. Every task gets its own git worktree on its
own dedicated branch, and you MUST confirm the base branch with the operator before creating it.**

## Step-by-step

1. **Ask first — which base branch?** Before creating anything, ask the operator (unless they
   already told you) from which branch the new worktree/branch should be cut. Do NOT assume
   `main` or "whatever I'm on" — the answer is usually the active `release/vX.Y.Z`, but it can
   be another feature/release branch. Get the base explicitly.
2. **Create an isolated worktree + branch off that base** (never reuse the main checkout).
   **🔴 MANDATORY PATH: every worktree lives under `.claude/worktrees/` — and nowhere else.**
   This is the single canonical location. It is gitignored AND in the `tsconfig.json` /
   `.dockerignore` excludes, so worktrees never leak into the build scope. **Never** use
   `.worktrees/`, repo-root, or any other path — a worktree outside `.claude/worktrees/`
   (a) escapes the build-scope excludes and poisons `next build` (the `tsconfig`
   `include: **/*` globs ~70× the codebase → OOM; incident 2026-06-25) and (b) scatters
   worktrees across two dirs.

   ```bash
   BASE_BRANCH="release/vX.Y.Z"          # ← the branch the operator confirmed in step 1
   TASK="feat/your-feature"               # feat/ fix/ refactor/ docs/ test/ chore/
   git fetch origin "$BASE_BRANCH"
   git worktree add ".claude/worktrees/${TASK##*/}" -b "$TASK" "origin/$BASE_BRANCH"
   cd ".claude/worktrees/${TASK##*/}"
   # Reuse the main checkout's node_modules to skip a per-worktree pnpm install.
   # HARD LINKS (`cp -al`), never a symlink: ~5s for the whole tree and near-zero extra
   # disk (the inodes are shared), and unlike a symlink it does not break the dev server.
   cp -al "$(git -C <main_checkout> rev-parse --show-toplevel)/node_modules" node_modules
   # `.husky/_` is gitignored, so a fresh worktree does NOT have it and
   # `core.hooksPath=.husky/_` then points at a directory that does not exist —
   # every pre-commit gate goes silently mute. Copy it too.
   cp -a "$(git -C <main_checkout> rev-parse --show-toplevel)/.husky/_" .husky/_
   ```

   `scripts/dev/new-worktree.sh <branch> [base]` does all of the above (canonical path,
   hard-linked `node_modules`, `.husky/_`) and then **verifies** the hook is actually
   executable, so prefer it over running the steps by hand.

   **Never `ln -s` node_modules.** Turbopack rejects a symlink that resolves outside the
   project root, so `npm run dev` dies with a FATAL panic (`Symlink [project]/node_modules
is invalid, it points out of the filesystem root`) while typecheck, lint and the test
   runners all keep passing — the error names "filesystem root", not the worktree, so it
   reads like a Next/build bug and costs real time to trace (incident 2026-07-31, #9043).

   **A worktree without `.husky/_` runs NO pre-commit gate — and says nothing.** `git`
   resolves `core.hooksPath` relative to the worktree top; when the directory is missing it
   simply finds no hook and commits. Nothing is printed, the commit succeeds, and the
   identity/lint/docs gates never ran. This is how 59 commits carrying a stale identity
   override (name of a contributor + the maintainer's e-mail) got past
   `scripts/check/check-git-identity.sh` between 2026-08-29 and 09-02 — they were all made in
   `cp -al` worktrees. Verify with `ls .husky/_/pre-commit` inside a new worktree, or just use
   `scripts/dev/new-worktree.sh`, which fails loudly when the hook is not executable.

3. **Work, commit, push, open the PR — all from inside the worktree.** Never `git checkout` a
   different branch inside a worktree another session might share.
4. **Tear down only your own** worktree + branch when done, from the main checkout:
   `git worktree remove .claude/worktrees/<dir>` then `git branch -D <task>`. Never blanket-delete
   `fix/*`/`feat/*` — other sessions keep their own; delete only the branches you created, by name.
5. **Never touch another session's worktree, branch, or uncommitted changes.** If `git worktree
list` shows worktrees you didn't create, leave them alone. End every session with the main
   checkout back on the branch it started on (the active `release/vX.Y.Z`, never `main`).

## Base-green check (PRs must not be born red)

Before cutting a branch, merging the base into a PR branch, or opening a PR, check that the base
tip is green. The fork has no release-green workflow: look up the CI run for the exact base commit.
CI runs on pushes to `main` and on pull requests, so a stacked base branch is tested through its
own PR. A draft PR runs no tests and gets no `Gate / CI` result, and a docs-only change skips the
test jobs, so a successful run alone proves nothing. The base is green only when, for that
commit, `Gate / CI` succeeded and the Build, Unit and Vitest jobs ran and succeeded (not skipped).

```bash
git fetch origin <base>
run=$(gh run list --repo misileremielle/omniroute --workflow ci.yml \
  --commit "$(git rev-parse origin/<base>)" --json databaseId --jq '.[0].databaseId')
gh run view "$run" --repo misileremielle/omniroute --json jobs \
  --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

If the base is red, never treat the inherited failures as your branch's defect and never fix them
inside your feature branch: a base-red fix is its own PR. A PR opened anyway says
`⚠️ base-red inherited` in its body, with the failing run.
