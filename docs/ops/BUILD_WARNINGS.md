---
title: "Build Warnings Reference"
version: 3.8.52
lastUpdated: 2026-10-18
---

# Build Warnings Reference

`npm run build` and `npm run build:release` print a handful of warnings that are
**expected** and do not mean the artifact is broken. This page catalogs them, says
whether each one is actionable, and points at the code that owns it — so an operator can
tell known build-time noise from a real regression.

If a message you see is not listed here, treat it as new and investigate it.

## Webpack "Critical dependency" for `open-sse/executors/codex.ts`

```
./open-sse/executors/codex.ts
Critical dependency: require function is used in a way in which dependencies cannot be statically extracted
```

**Expected — intentional.** `open-sse/executors/codex/wreqLoader.ts` loads the optional
`wreq-js` native helper through a `createRequire()`-returned function whose specifier is
kept as a **variable** on purpose (`Reflect.apply(requireFn, undefined, [moduleName])`). A
literal specifier is statically rewritten by Turbopack into a hashed `.next`-relative
require that does not exist in the standalone Docker runtime, so the dynamic form is
required (#12491). The warning is the price of that pattern; the module still resolves at
runtime and is not a missing dependency.

Because the loader is imported by the Codex quota service, instrumentation, and the
internal Codex WebSocket route, webpack reports the same warning once per import path.

## Runtime configuration messages during static generation

`next build` imports application modules while collecting page data, so a few
runtime-oriented log lines appear during the build as well. They are **not** build errors.

| Message                                                                                       | Owner                                 | Meaning                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[DB] Build phase detected — using no-op SQLite stub (never queried)`                         | `src/lib/db/core.ts`                  | The build never opens the real database. Expected.                                                                                               |
| `[REDIS] REDIS_URL is not set in production. Using in-memory rate limiting.`                  | `src/shared/utils/rateLimiter.ts`     | Redis is optional; without it rate limiting falls back to memory. Set it only if you run Redis in production — see `REDIS_PRODUCTION_CONFIG.md`. |
| `[CREDENTIALS] No external credentials file found, using defaults.`                           | `open-sse/config/credentialLoader.ts` | Expected unless you ship an external credentials file.                                                                                           |
| `[INFO] [PLUGIN_SCANNER] scanner.dir_resolved` / `[INFO] [MEMORY_MANAGER] Registered backend` | plugin + memory registries            | Informational.                                                                                                                                   |

### `[SECURITY] FATAL: JWT_SECRET is not set`

`JWT_SECRET` is **required at runtime** — without it, login fails closed and the dashboard
is unreachable. Set it in your environment before starting the server (see
`../reference/ENVIRONMENT.md`).

During `next build` the login route module used to be imported while collecting page data
with no `JWT_SECRET`, and printed the same `FATAL` line, which reads like a live security
failure. That message is now skipped during the build phase: the module-level warning in
`src/app/api/auth/login/route.ts` is gated on `isNextBuildPhase()`
(`src/lib/buildPhase.ts`), which matches `NEXT_PHASE=phase-production-build`,
`OMNIROUTE_BUILDING=1`, and `npm_lifecycle_event=build`. The request handler still returns
`500` when the secret is missing at runtime, so runtime behavior is unchanged.

## Bun and dependency installation

OmniRoute is built and run with **Node.js** (`engines.node` in `package.json`). Install
dependencies with pnpm:

```bash
pnpm install --frozen-lockfile
pnpm run build:release
```

`pnpm-workspace.yaml` sets `nodeLinker: hoisted`. The standalone assembler
(`scripts/build/assembleStandalone.mjs`) needs a flat `node_modules`; with pnpm's default
isolated layout the bundle builds but loses `better-sqlite3` when copied elsewhere.

**`bun install` is not a supported way to install OmniRoute's dependencies** for this
branch. Bun `1.4.2` is pinned as a devDependency and is used only to run a small,
allow-listed set of gate/generator scripts. If you install with Bun you may see:

- `warn: Bun currently only supports one level of nested "overrides"` — Bun reads the
  `package.json` copy of the overrides and applies them less deeply; pnpm applies the copy in
  `pnpm-workspace.yaml` (`tests/unit/build/pnpm-overrides-sync.test.ts` keeps both in step).
- **Blocked lifecycle scripts** for native packages (ONNX Runtime, Playwright Chromium,
  SWC, protobufjs, Parcel Watcher, unrs-resolver). Bun blocks install scripts by default;
  the supported pnpm install runs those listed in `allowBuilds`, and `pnpm run check:native-deps` verifies that
  every externalized package resolves afterward.

### Bun script-runner failures

Bun runs only the allow-listed gate/generator scripts (`check:provider-consistency`,
`check:compression-budget`, `check:known-symbols`, `gen:provider-reference`,
`bench:compression`) plus the `test:bun:db` smoke suite — see `AGENTS.md` → Environment.
After pulling the lockfile change, run `pnpm install` so `bun` resolves locally (a stale
`node_modules` will fail those scripts with `bun: not found`).

**Two distinct Bun failures, two different fixes — do not confuse them.**

- **(a) `bun: not found`** → the tree is stale; `pnpm install`.
- **(b) Bun exists but refuses to run** → `node_modules/bun/bin/bun.exe` is still the
  ~450-byte **bash placeholder** the package ships, because its `postinstall` was skipped
  (`pnpm install --ignore-scripts`, or a package manager that skips lifecycle scripts). The real
  binary is already on disk in the platform package (e.g.
  `node_modules/@oven/bun-windows-x64/bin/bun.exe`, ~86 MB), so nothing is missing and
  re-running `pnpm install` on an already-satisfied tree may not fix it. Fix:
  `cd node_modules/bun && node install.js`.

**On Windows the error is actively misleading** — `cmd.exe` asks the loader to run a bash
script, which reports `This version of … is not compatible with the version of Windows you're running`,
which reads like an OS/architecture problem but means "this is not a Windows executable".
Confirm the real cause with `ls -l node_modules/bun/bin/bun.exe` (a few hundred bytes =
placeholder). Either way `node --import tsx <script>` is the validated byte-identical fallback
for all four scripts.
