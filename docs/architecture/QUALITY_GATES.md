---
title: Quality Gates Reference
---

# Quality Gates Reference

What the fork's CI blocks on, where each check runs, and which checks run only from the git
hooks. The fork blocks on correctness only; upstream's policy gates and ratchets are removed
([FORK_IDENTITY.md → CI and CD](../ops/FORK_IDENTITY.md#ci-and-cd)).

## Triggers

`.github/workflows/ci.yml` runs on:

- a push to `main`;
- a pull request into any base, so a stacked PR gets CI (opened, synchronize, reopened,
  ready_for_review, converted_to_draft, and an `edited` event that changes the base);
- manual dispatch.

A draft PR runs only the change classification and gets no `Gate / CI` result. A title or
body edit runs nothing. On pull requests, the `changes` job skips the code jobs for a
docs-only change (`scripts/quality/classify-pr-changes.mjs`).

## `Gate / CI`

The `gate` job fails when any job it needs failed or was cancelled, and writes a result table
to the run summary. A skipped job does not fail it.

| Job                | Runs on                        | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`             | ready PRs, main, dispatch      | Oxlint; rule guards (`check:db-rules`, `check:error-helper`, `check:public-creds`, `check:route-guard-membership`, `check:route-validation:t06`, `check:fetch-targets`, `check:tracked-artifacts`, `check:migration-numbering --no-base`); routing (`check:provider-consistency`, `check:known-symbols`, `check:model-lifecycle`); test hygiene (`check:test-discovery`, `check:test-tla-order`, `check:vitest-exclusions`, `check:deps`); `check:ui-icu`, `check:cli-i18n`; hadolint |
| `typecheck`        | ready PRs, main, dispatch      | `typecheck:core`, `check:dashboard-typecheck`, `check:build-typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `security`         | every ready PR, main, dispatch | `audit:deps`, `check:lockfile`, `check:licenses`, `check:secrets --ratchet` (gitleaks), `check:vuln-ratchet --ratchet` (OSV), `check:workflows --ratchet`, `check:codeql-ratchet`                                                                                                                                                                                                                                                                                                     |
| `build`            | ready PRs, main, dispatch      | `pnpm run build` (webpack) and the colocated compression and LLMLingua worker checks                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test-unit`        | ready PRs, main, dispatch      | `test:unit:ci:shard`, 8 shards                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test-vitest`      | ready PRs, main, dispatch      | `test:vitest` and `test:vitest:ui`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test-security`    | ready PRs, main, dispatch      | `test:security`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `package-artifact` | main, dispatch                 | `build:cli`, `check:pack-artifact` (with build provenance against the ref under test), `check:pack-boot`                                                                                                                                                                                                                                                                                                                                                                              |
| `test-e2e`         | main, dispatch                 | Playwright, 9 shards balanced by `scripts/quality/balance-e2e-shards.mjs`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test-integration` | main, dispatch                 | `test:integration:ci`, 2 shards                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test-ecosystem`   | main, dispatch                 | `test:ecosystem` against a live server                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test-bun-sqlite`  | main, dispatch                 | `test:bun:db`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

"Ready PRs" means non-draft PRs whose change classification includes code; `lint` also runs
for an i18n-only change.

### Notes on single checks

- **`check:migration-numbering --no-base`** keeps the static checks (names, gaps, the frozen
  three-digit range) and turns off only the comparison with a base ref.
- **`check:workflows --ratchet`** fails on any actionlint finding. zizmor findings are held to
  `metrics.zizmorFindings` in `config/quality/quality-baseline.json`.
- **`check:codeql-ratchet`** counts the repository's open CodeQL alerts against
  `metrics.codeqlAlerts`. GitHub's default setup (enabled 2026-11-24) analyzes `main` and PRs
  into `main`; the step does not analyze the revision under test, so a stacked PR's own code is
  checked only once it reaches a PR into `main`. CI passes `--require-measurement`: the step
  fails when the API cannot be read, when none of the 20 newest CodeQL analyses succeeded, or
  when the baseline is missing or invalid, so an empty alert list never counts as zero.
- **`check:secrets`** and **`check:vuln-ratchet`** compare with `metrics.secretFindings` and
  `metrics.vulnCount`.

## Coverage (report only)

On a push to `main`, `coverage-shard` (8 shards, `continue-on-error`) runs the unit tests under
c8 and `coverage` merges them into a summary. Neither is part of `Gate / CI`. The report warns
when fewer than 8 shard artifacts arrived. Locally, `pnpm run test:coverage` fails below 60%
for statements, lines, functions and branches.

## Git hooks

The hooks are unchanged from upstream and are the only place these checks run:

- **pre-commit**: `scripts/check/check-git-identity.sh`, lint-staged (Prettier, Oxlint),
  `scripts/quality/gate-manifest.mjs`,
  `check-docs-sync --mode=pr`, `check:any-budget:t11`, `check-type-scale-ratchet --ratchet`,
  `check:tracked-artifacts`, the UI-kit snapshot check.
- **commit-msg**: `check:ai-attribution`.

`config/quality/gate-manifest.json` lists every validation script in `package.json`; the
pre-commit hook fails when a script is added or removed without updating it.

## Docker publishing

`.github/workflows/docker-publish.yml` builds each architecture on a GitHub-hosted runner,
health-checks the base and web images, and runs the Trivy CRITICAL gate on both, by digest,
before any tag points at them. See the
[Docker guide](../guides/DOCKER_GUIDE.md#release-channels) for the channels.

## Allowlist policy

Fix the cause. Use an allowlist only for a pre-existing violation you cannot fix in the same
PR, with a justification comment and an issue number.

## Adding a gate

Add a gate only when it checks correctness. Add the script to `package.json` and
`config/quality/gate-manifest.json`, give it a unit test, and add a step to the matching job
in `ci.yml`.
