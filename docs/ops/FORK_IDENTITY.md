---
title: "Fork Identity and Upstream Sync"
version: 3.8.55
lastUpdated: 2026-11-22
---

# Fork identity and upstream sync

This repository is `misileremielle/omniroute`, a slimmed fork of
`cheaper-inference/OmniRoute`. It follows upstream's release branches and deliberately
carries less. This page records what the fork removes, what it adds, and how to merge the
next upstream release without undoing either. Read it in full before any upstream merge.

## Remotes and branches

- `origin` — `git@github.com:misileremielle/omniroute.git`. The only long-lived branch is
  `main`.
- `upstream` — `https://github.com/cheaper-inference/OmniRoute.git`. Merge from its newest
  `release/vX.Y.Z` branch (upstream's default branch), never from upstream `main`.

## What the fork removes

A removed feature stays removed: its code, routes, pages, tests, docs, feature flags, i18n
keys and CI wiring. Upstream keeps developing these, so every merge brings them back unless
they are dropped again.

| Area                      | Removed                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop and local capture | Electron app, MITM proxy / Agent Bridge, Traffic Inspector                                                                                                                                                                                                                                                                                                                                  |
| Agent surfaces            | MCP server, A2A server, ACP agents, cloud agents (`jules`, `devin`, `codex-cloud`), agent skills (`skills/`, `src/lib/agentSkills`), VS Code integration                                                                                                                                                                                                                                    |
| Memory and extensions     | Memory, skills registry and omni-skills pages, plugins (and `PLUGIN_PERMISSION_MODEL_ENABLED`), context sources (Obsidian, Notion, local corpus), webhooks dispatcher                                                                                                                                                                                                                       |
| Guardrails                | PII masker, reversible PII vault (`src/lib/pii`, `PII_REVERSIBLE_VAULT_ENABLED`), prompt-injection guard, input sanitizer, video bridge promotion tooling. The vision bridge stays                                                                                                                                                                                                          |
| Media                     | Image, audio (speech / transcription), video and music handlers and their registries; the media cache page                                                                                                                                                                                                                                                                                  |
| Dashboard                 | Playground, Translator page (the translation engine stays), gamification, radar, in-app docs site, changelog page, Batch API and files pages                                                                                                                                                                                                                                                |
| Engine                    | Batch API and files, CCR compression engine, chaos mode (and its mode pack), reasoning routing rules, legacy completions, system prompt injection, CLI tool configurators and `cli-code` pages                                                                                                                                                                                              |
| Providers                 | Web-cookie providers, cloud-agent providers and about 100 router/gateway providers. The lists and their removal migrations are in `config/fork-removed-providers.json`; the policy is in [`REMOVED_PROVIDERS.md`](../reference/REMOVED_PROVIDERS.md). Kept gateways: OpenRouter, Vercel AI Gateway, Chutes, Novita, NanoGPT, OpenCode Zen, OpenCode Go                                      |
| Languages                 | Every UI, global-error and CLI catalog except `en`, the language switcher and browser-locale detection, the translation scripts (`sync-ui-keys`, `add-locale`, translation backends), the per-locale gates (coverage, ratio, value drift, new keys, key completeness, glossary) and the `i18n` / `i18n-glossary-zhcn` CI jobs. The next-intl runtime and `config lang` stay, with `en` only |
| Docs and release infra    | `docs/i18n` mirrors and their translation scripts, upstream's merge queue (`omni-queue` workflows, `scripts/merge-queue`, `config/merge-queue`), Docker org mirror, nightly derived-refresh workflow, npm publish workflows, M365 / Command Code / Kimi partner bits                                                                                                                        |

## What the fork adds or changes

- **Packaging**: pnpm instead of npm (`pnpm run`, `pnpm exec`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml` overrides mirrored in `package.json`); container image
  `ghcr.io/misileremielle/omniroute` instead of `docker.io/cheaperinference/omniroute`.
- **System One-compatible custom nodes** with whole-body passthrough and multipart assets
  (`open-sse/handlers/systemOne.ts`, `src/app/api/v1/_shared/systemOneRoute.ts`,
  `provider-nodes` routes and modals).
- **OpenAI empty turn before `[DONE]`**: bytes after a withheld `[DONE]` are discarded
  (`OPENAI_DONE_FRAME`, `decodeLatin1()` and `admitClientChunk` in
  `open-sse/utils/streamHandler.ts`; test `tests/unit/openai-empty-turn-error-before-done.test.ts`).
- **Provider removal migrations** and their helper (`providerRemovalMigration`,
  `tests/unit/db/provider-removal-migration.test.ts`).
- **`kagi-search`** search provider.
- **Performance work**: batched log writes, the per-handle capabilities-table guard in
  `src/lib/modelsDevSync.ts`, the per-attempt body copy in `prepareUpstreamBody`.
- **Workflows**: `.github/workflows/ci.yml`, `docker-publish.yml` and `.mergify.yml` are the
  fork's own. Upstream changes to them are not merged wholesale; port a new gate by hand
  when it applies (the type-scale ratchet step was ported this way).

## Linting

The fork lints with [Oxlint](https://oxc.rs) and has no ESLint package, config or script.
Prettier still formats. Upstream keeps ESLint, so every merge brings ESLint files back.

| Upstream (ESLint)                                                       | Fork (Oxlint)                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `eslint.config.mjs`                                                     | `.oxlintrc.json`                                                            |
| `config/quality/eslint-suppressions.json`                               | `oxlint-suppressions.json` at the repo root (Oxlint has no location option) |
| `eslint.complexity.config.mjs`, `eslint.complexity-ratchets.config.mjs` | `oxlint.complexity.json`                                                    |
| `scripts/quality/run-eslint-json.mjs`, `eslint-measurement.mjs`         | `scripts/quality/run-oxlint-json.mjs`, `scripts/quality/oxlint-report.mjs`  |
| `scripts/check/complexityEslintReport.mjs`                              | `scripts/check/complexityLintReport.mjs`                                    |
| `eslint-plugin-sonarjs` (cognitive complexity)                          | `oxlint-plugin-complexity`                                                  |
| `ESLINT_RESULTS_JSON`, `COMPLEXITY_ESLINT_REPORT`                       | `LINT_RESULTS_JSON`, `COMPLEXITY_LINT_REPORT`                               |

What stays the same: the `lint`, `lint:json`, `check:complexity*` and `quality:*` script
names, and the metric keys `eslintWarnings` / `eslintErrors` / `cognitiveComplexity` in
`config/quality/quality-baseline.json` (kept so the baseline files merge).

Things that differ from ESLint and matter in a merge:

- **Frozen debt** is `oxlint-suppressions.json`, written by `pnpm exec oxlint --suppress-all .`
  and trimmed by `pnpm exec oxlint --prune-suppressions .`. Both flags are hidden from
  `oxlint --help` upstream and may change, which is one reason the three Oxlint packages are
  exact pins (`tests/unit/oxlint-version-pinned.test.ts`). An upgrade is its own change that
  regenerates the file and the complexity baselines.
- **Stale entries**: `pnpm run lint` and the commit hook fail when a frozen violation was
  fixed and not pruned. `lint:json`, `quality:collect`, the release-green validator and the
  complexity ratchets tolerate it (`scripts/quality/oxlint-report.mjs`), as upstream's
  `--pass-on-unpruned-suppressions` did. The commit hook runs `oxlint` without `--fix`,
  because `--fix` rewrites the suppressions file silently.
- **`no-restricted-syntax`** has no native Oxlint rule. It runs from `oxlint-plugin-eslint`
  under the alias `eslint-js`, so a disable comment must name both:
  `// eslint-disable-next-line no-restricted-syntax, eslint-js/no-restricted-syntax -- reason`.
  Other `eslint-disable` comments work unchanged.
- **Stricter rules**: Oxlint's `no-restricted-imports` also checks dynamic `import()`, and its
  React Compiler rules and `next/no-html-link-for-pages` report code that ESLint accepts. New
  upstream code can therefore fail the fork's lint while passing upstream's.
- **Complexity baselines** (`config/quality/complexity-baseline.json`, `cognitiveComplexity`
  in `quality-baseline.json`) are Oxlint measurements of the fork's tree, frozen exactly as
  measured. Upstream's numbers are ESLint/sonarjs measurements of a larger tree and are not
  comparable; in a conflict keep the fork's value and re-measure.

## Database migrations

Upstream froze the three-digit migration set at `241` and names new migrations by UTC
timestamp. The fork's own migrations therefore use timestamps too:

- Fork migrations originally shipped as `240`–`248` are now `20261114000240` …
  `20261114000248`. Each has a `RENAMED_MIGRATION_COMPATIBILITY` entry in
  `src/lib/db/migrationRunner/constants.ts`, so a database that applied the old number does
  not run it again and still runs the upstream migration that now owns `240` / `241`.
- New fork migrations: `pnpm run db:new-migration -- <name>`. Never add a three-digit file.
- An upstream migration that only creates a table for a removed feature is deleted from the
  fork before it is ever applied (done for `20261118212845_cloud_agent_tasks.sql`).
  Migrations that touch tables the fork still has (for example `skills`) stay.
- After a merge run `node scripts/check/check-migration-numbering.mjs` and
  `tests/unit/check-migration-numbering.test.ts`,
  `tests/unit/db-migrationrunner-constants-split.test.ts`.

## Merging the next upstream release

1. Work in a dedicated worktree and branch created from `main`. Fetch `upstream`, then
   `git merge --no-commit --no-ff upstream/release/vX.Y.Z`.
2. **Deleted by the fork, modified upstream** (`DU`): `git rm`. Deleted upstream, modified
   by the fork (`UD`): `git rm` unless the fork still needs the file.
3. **Files upstream added inside removed areas** arrive without a conflict. List the added
   files (`git diff --cached HEAD --name-only --diff-filter=A`) and delete the ones that
   belong to the table above.
4. **Locale catalogs**: delete every new or modified non-`en` catalog (`src/i18n/messages`,
   `src/i18n/global-error-messages`, `bin/cli/locales`). Merge `en.json` key by key against the
   merge base; the fork wins a true conflict and a key the fork deleted stays deleted. Then run
   `node scripts/i18n/generate-global-error-messages.mjs`, and trim upstream tests that loop over
   several locales to `en`.
5. **Content conflicts** (`UU`): prefer upstream's structure and re-apply the fork's change.
   When the fork deleted a block that upstream edited, keep the deletion but check whether
   upstream also added unrelated lines next to it (new imports, new constants) and keep
   those. After choosing the fork's side of a hunk, search the file for upstream references
   to what was dropped.
6. **Dangling references**: search for imports and path strings that point at files that no
   longer exist, in `src/`, `open-sse/`, `scripts/` and `tests/`. Delete upstream tests
   written for removed features or for workflows the fork does not carry; fix tests the fork
   already had.
7. **Lists of paths**: prune removed files from `stryker.conf.mjs` and similar inventories.
8. **Counts**: `AGENTS.md` and `llm.txt` carry no derived counts. Refresh the rest with
   `node scripts/release/refresh-derived.mjs --only=provider-reference,facts,numbers,readme-diagrams`,
   then `node scripts/check/check-docs-counts-sync.mjs`. The gate
   (`scripts/check/check-docs-counts-sync.mjs`) is upstream's with the MCP, A2A, cloud-agent,
   skills and `docs/i18n` checks taken out; re-apply that when upstream rewrites it.
   Feature flag totals live in `docs/reference/FEATURE_FLAGS.md` and the two flag-count
   tests.
9. **Dependencies**: keep `package.json` scripts on pnpm, sync the overrides with
   `pnpm-workspace.yaml`, run `pnpm install --no-frozen-lockfile` and commit the lockfile.
10. **Lint tooling**: delete the ESLint files upstream brings back (left column of the table
    in "Linting") and any upstream test written for them; port a rule upstream added to
    `eslint.config.mjs` into `.oxlintrc.json`; keep ESLint packages out of `package.json`,
    the overrides, `knip.json`, `config/quality/dependency-allowlist.json` and
    `.github/dependabot.yml`. Then refreeze and re-measure, and review what changed before
    committing it:
    `pnpm exec oxlint --suppress-all .`, `pnpm exec oxlint --prune-suppressions .`,
    `node scripts/check/check-complexity-ratchets.mjs` (set the two baselines to the measured
    values when upstream code moved them).
11. **Checks**: no conflict markers; run the test files touched by the merge one at a time
    (`node --import tsx/esm --test <file>`); `pnpm run lint` (a full walk takes seconds); then
    the full suites and typecheck on a machine with enough memory
    (`pnpm run typecheck:core`, `pnpm run test:unit`, `pnpm run test:vitest`).
12. Commit the merge in the worktree. Add a row to the history below.

## Sync history

| Date       | Upstream                      | Notes                                                                                                                                                         |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11    | `release/v3.8.54` (two syncs) | Merge commit `4a2c8f44eb`                                                                                                                                     |
| 2026-11-22 | `release/v3.8.55`             | Fork migrations moved to timestamps; docs-counts gate re-ported; `keenable` search/fetch, `custom-json` nodes, `jev` and decision routing taken from upstream |
| 2026-11-23 | (no upstream change)          | Lint switched from ESLint to Oxlint; lint and complexity baselines regenerated                                                                                |
| 2026-11-23 | (no upstream change)          | English only: non-`en` catalogs, the language switcher, translation tooling and per-locale gates removed                                                      |
