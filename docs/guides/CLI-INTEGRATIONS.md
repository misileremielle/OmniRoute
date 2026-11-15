---
title: "CLI Integrations — point any coding CLI at OmniRoute"
version: 3.8.50
lastUpdated: 2026-08-18
---

# CLI Integrations

For the shared executable manifest, restricted child environments and persistent
Gemini setup, see [CLI launch contracts](./CLI-LAUNCH-CONTRACTS.md).

Point a coding CLI (Codex, Claude Code, OpenCode, Cline, …) at OmniRoute as its
backend — so the tool talks to **one** endpoint and OmniRoute routes to the right
provider with auto-fallback. `omniroute configure codex` and
`omniroute config set <tool>` read the **live** model catalog from a running
OmniRoute (local or remote) and write the tool's own config file on **your**
machine. The API key is referenced by an environment variable wherever the tool
supports it.

There is also a generic launcher — `omniroute run <target>` — that spawns
`claude`, `codex`, `aider`, `goose`, `opencode`, `qwen`, `gemini` or `whycodes` with the
right env injected, without writing any config at all. Targets and their
aliases come from the canonical manifest `bin/cli/cli-manifest.mjs`
(`claude-code|cc|anthropic`, `codex-cli|openai-codex|openai`, `goose-cli`,
`open-code`, `qwen-code`, `gemini-cli`, `why-codes|why`), and `omniroute completion` offers the
same manifest-derived target words. The legacy per-tool launchers —
`omniroute launch` (Claude Code) and `omniroute launch-codex` (Codex) — remain
available.

Provider onboarding is available from the same local/remote context. The
API-first commands below keep management authentication separate from provider
credentials and never print a credential in structured output:

```bash
omniroute providers add glm --credential-env GLM_API_KEY --name work
omniroute providers import ./providers.json --dry-run --json
omniroute providers auth openai
omniroute providers edit <connection-id> --default-model glm/glm-5.2
omniroute providers remove <connection-id> --yes
```

For scripts, prefer `--credential-stdin` or `--credential-env`; `--credential`
is retained for controlled local use. `providers remove` requires `--yes` on a
non-interactive terminal, and all five commands honor the active context or the
global `--base-url`/`--api-key` options.

Provider selectors reject ambiguous ID prefixes, names or provider names; use a
full connection ID when several connections match. Create and edit commands read
the saved connection back, and removal verifies that it is no longer readable.
An import skips an existing provider/name pair. Imported entries cannot override
the management endpoint, context or management credentials supplied to the CLI.

For the one-time, hand-written base setup of the two richest integrations, see the
per-tool deep dives:

- [Claude Code configuration](./CLAUDE-CODE-CONFIGURATION.md)
- [Codex CLI configuration](./CODEX-CLI-CONFIGURATION.md)
- [Remote Mode](./REMOTE-MODE.md) — drive a remote OmniRoute (VPS / Tailnet) from your laptop

---

## Master table

`omniroute configure` / `config set` honour the **active context** (set with
`omniroute connect`, see [Remote Mode](./REMOTE-MODE.md)) or explicit
`--remote <url> --api-key <key>` flags.

| Command                  | Tool                     | What it writes                                                                                                                                                    | Key flags                                                                                                                                  | Local vs remote |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `omniroute run <target>` | Runtime launch (generic) | Nothing — spawn `claude`/`codex`/`aider`/`goose`/`opencode`/`qwen`/`gemini`/`whycodes` with the right env and args; Qwen and Gemini use a temporary isolated home | `--remote` `--base-url` `--context` `--provider` `--model` `--api-key` `--api-key-env` `--dry-run` `--json` `--port` `--profile` `--token` | Both            |
| `omniroute launch`       | Claude Code              | Nothing — spawns `claude` with `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` injected                                                                               | `--remote` `--api-key` `--token` `--profile` `--port`                                                                                      | Both            |
| `omniroute launch-codex` | OpenAI Codex CLI         | Nothing — spawns `codex` with the `omniroute` provider injected via `-c` flags                                                                                    | `--remote` `--api-key` `--profile` (`-p`) `--port`                                                                                         | Both            |

Notes on flags (verified in the command source):

- `--remote <url>` — fetch the catalog from a remote OmniRoute (overrides `--port`
  and the active context). `--api-key <key>` supplies the credential for that
  server (defaults to the `OMNIROUTE_API_KEY` env var, or the active context's token).
- `--only <patterns>` — comma-separated substrings; keep only model IDs that match
  (e.g. `--only glm,kimi`).
- `--dry-run` — print exactly what would be written without touching the
  filesystem.
- `--model <id>` — picked interactively by `omniroute configure`, or passed for
  non-interactive runs (which then requires `--model`, plus `--yes`).
- `--model <id>` on `omniroute run` follows the manifest's per-target wiring
  (`bin/cli/cli-manifest.mjs`): **aider** receives `--model openai/<id>` and
  **opencode** `--model omniroute/<id>` (the prefix is added only when the id
  does not already carry it); **qwen** and **gemini** receive the id verbatim;
  **claude** gets it via `ANTHROPIC_MODEL`, **goose** via `GOOSE_MODEL`,
  **whycodes** via `-P omniroute -m <id>`, and
  **codex** via `-c model_providers.omniroute.*` args. **Qwen is the only run
  target that hard-requires `--model`** — `omniroute run qwen` without it exits
  `2` with an explicit error.
- `--port <port>` — local OmniRoute port (default `20128`, ignored when `--remote`
  is set). Present on `configure`, `config set` and both launchers.
- `omniroute run` exit codes: the child CLI's own exit code is propagated
  verbatim; `2` = invalid arguments (unsupported target, missing required
  `--model`, container guard); `127` = the target binary is not in `PATH`;
  `130`/`143`/`129` when the launch is ended by `SIGINT`/`SIGTERM`/`SIGHUP`;
  `1` = other runtime launch failure.
- The two launchers (`launch`, `launch-codex`) accept `--profile <name>` to select
  a profile written by `omniroute configure codex`, plus pass-through args for
  the underlying `claude` / `codex` binary.

The interactive picker configures the target from the live catalog:

```bash
# Pick from the active local or remote model catalog and configure the target.
omniroute configure codex
```

`configure` currently supports the `codex` target; `omniroute config set <tool>`
writes other tools' configs.

> There is also a richer plugin integration — `omniroute setup opencode` — which
> installs `@omniroute/opencode-plugin`.
>
> The plugin comes in two packages, one per OpenCode major, because the two
> loaders expect different entrypoints:
> `@omniroute/opencode-plugin` for OpenCode v1 and
> `@omniroute/opencode-plugin-v2` for OpenCode v2. The v2 package is new
> (`0.1.0`) and follows a host contract that is still moving, so it reads the
> shape OpenCode seeds into the catalog draft rather than assuming one. Install
> it by adding a `plugins` entry to `opencode.json`; `omniroute setup opencode`
> still installs the v1 package. Options and the credential lookup order are in
> the package README.

---

## Local usage

With OmniRoute running on `localhost:20128`, configure the tool from the local
catalog, then use it.

```bash
# Codex: write a profile per matched model into ~/.codex/
omniroute configure codex
codex --profile glm52            # use a generated profile

# Claude Code: hand-write a per-model profile (see the Claude Code guide), then launch one
omniroute launch --profile glm52
```

Launch without writing any config at all (env-injection only):

```bash
omniroute launch                 # Claude Code → local OmniRoute
omniroute launch-codex           # Codex CLI → local OmniRoute
omniroute launch-codex --profile glm52
omniroute run claude --model openai/gpt-5.4
omniroute run codex --model openai/gpt-5.4 --dry-run --json
omniroute run aider --model glm/glm-5.2 -- --message "reply OK"
omniroute run goose --model glm/glm-5.2
omniroute run opencode --model glm/glm-5.2 -- run "reply OK"
omniroute run qwen --model glm/glm-5.2 -- -p "reply OK"
omniroute run gemini --model glm/glm-5.2 -- --skip-trust -p "reply OK"

# Explicit command path: pass through whatever comes after --
omniroute run claude -- --print-system-prompt "review this diff"
```

---

## Remote usage

Point `configure` / `config set` at a remote OmniRoute with `--remote` + `--api-key`.
The catalog is fetched from the remote; the config is written on your local machine.

```bash
# Codex profiles from a remote catalog
omniroute configure codex --remote http://192.168.0.15:20128 --api-key oma_live_xxx

# Launch a CLI straight against the remote
omniroute launch       --remote http://192.168.0.15:20128 --api-key oma_live_xxx
omniroute launch-codex --remote http://192.168.0.15:20128 --api-key oma_live_xxx
```

Instead of passing `--remote`/`--api-key` every time, log in once and let the
**active context** supply them automatically:

```bash
omniroute connect 192.168.0.15        # mints a scoped token, stores the context
omniroute configure codex             # ← now uses the remote catalog
omniroute launch                      # ← Claude Code against the remote
```

See [Remote Mode](./REMOTE-MODE.md) for contexts, scopes, and token management.

---

## Base URL conventions (which tools want `/v1`)

OmniRoute exposes the OpenAI surface at `/v1`, the Anthropic surface at the root,
and a native Gemini surface at `/v1beta`. Each integration is wired to the form its
tool expects (verified in the command source):

| Integration                                                              | Base URL written | `/v1`?                                  |
| ------------------------------------------------------------------------ | ---------------- | --------------------------------------- |
| `configure codex`, `launch-codex` (`model_providers.omniroute.base_url`) | with `/v1`       | Yes                                     |
| `run gemini` (`GOOGLE_GEMINI_BASE_URL`)                                  | root             | No — the SDK appends `/v1beta/models/…` |

---

## Keeping native deps on update: `--include=optional`

When you update with `omniroute update` (after confirming, or with `--apply`),
OmniRoute runs the install with `--include=optional` baked in:

```bash
npm install -g omniroute@latest --include=optional
```

This is **not** a flag you pass to `omniroute update` — it is always applied by the
updater. It guarantees the `optionalDependencies` (`better-sqlite3`, `keytar`,
`tls-client`, the LLMLingua SLM stack) survive the update even if your npm config
has `omit=optional` set, which would otherwise silently drop the native SQLite
driver and OS-keyring binding. To preview the exact command without applying:

```bash
omniroute update --dry-run
# [DRY RUN] Would run: npm install -g omniroute@latest --include=optional
```

Other `omniroute update` flags (verified in source): `--check` (exit 1 if
outdated), `--apply` (install without prompting), `--changelog`, `--no-backup`,
`--yes`.

---

## Google Gemini CLI via `omniroute run gemini`

Contract verified against `@google/gemini-cli` 0.50.0: the CLI honors
`GOOGLE_GEMINI_BASE_URL` and issues `POST /v1beta/models/<model>:generateContent`
(and `:streamGenerateContent?alt=sse`) against it — exactly OmniRoute's native
Gemini surface (`/v1beta`). `omniroute run gemini` wires that automatically:

- `GOOGLE_GEMINI_BASE_URL` → the active OmniRoute base URL (root, no `/v1`);
- `GEMINI_API_KEY` → the resolved OmniRoute credential (option/env/context);
- a **temporary isolated `GEMINI_CLI_HOME`** whose `.gemini/settings.json`
  selects `gemini-api-key` auth, so a stored Google OAuth session (Code Assist)
  never overrides the OmniRoute-directed launch — removed after exit;
- **env hygiene**: the child env is scrubbed of `GOOGLE_API_KEY`,
  `GOOGLE_GENAI_USE_VERTEXAI` and `GOOGLE_GENAI_USE_GCA` (which would redirect
  auth to Vertex/Code Assist), and `GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key` is
  set as a belt-and-suspenders fallback — the other `run` targets get the same
  treatment for their own conflicting variables;
- `--model <id>` injection from `--provider`/`--model`.

```bash
omniroute run gemini --model glm/glm-5.2 -- --skip-trust -p "hello"
```

Gemini's workspace-trust guard still applies in headless mode — pass
`--skip-trust` (or trust the directory interactively) yourself; the launcher
deliberately does not bypass it. This launcher is distinct from the **ACP
agent-protocol integration for `/dashboard/acp-agents`.

---

## Real smoke sweep (opt-in)

Deterministic launch-plan regression runs in CI (`tests/unit/cli/run-command.test.ts`,
`tests/unit/cli/run-execution.test.ts`). To validate the REAL binaries against a REAL
OmniRoute server, an opt-in harness exists at
`tests/integration/upstream-cli-smoke.int.test.ts`. It never runs automatically
(every sub-test skips unless `RUN_CLI_SMOKE=1`), passes the credential by env-var
NAME (never by value), redacts key-shaped strings from any recorded output, skips
targets whose binary is not installed, and classifies failures as
auth / upstream / config instead of a bare boolean:

```bash
RUN_CLI_SMOKE=1 \
OMNIROUTE_SMOKE_BASE_URL="http://localhost:20128" \
OMNIROUTE_SMOKE_MODEL="<provider/model>" \
OMNIROUTE_SMOKE_API_KEY_ENV="OMNIROUTE_API_KEY" \
node --import tsx/esm --test tests/integration/upstream-cli-smoke.int.test.ts
```

Optional: `OMNIROUTE_SMOKE_TARGETS="codex,opencode,qwen"` restricts the sweep;
`OMNIROUTE_SMOKE_TIMEOUT_MS` overrides the 120s per-target timeout.

---

## See also

- [Claude Code configuration](./CLAUDE-CODE-CONFIGURATION.md) — the deeper Claude Code guide
- [Codex CLI configuration](./CODEX-CLI-CONFIGURATION.md) — the one-time `[model_providers.omniroute]` base setup
- [Remote Mode](./REMOTE-MODE.md) — contexts, scoped access tokens, driving a remote server
- [CLI Tools reference](../reference/CLI-TOOLS.md) — manual per-tool setup and the internal `omniroute` CLI
- [Setup Guide](./SETUP_GUIDE.md) — install methods and first-run onboarding
