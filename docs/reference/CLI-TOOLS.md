---
title: "CLI Tools — OmniRoute"
version: 3.8.50
lastUpdated: 2026-08-23
---

# CLI Tools — OmniRoute

External coding tools and agents connect to OmniRoute by pointing their OpenAI- or
Anthropic-compatible endpoint at it. Write a tool's config from the terminal with
`omniroute config set <tool>` (claude, cline, codex, continue, hermes, kilo, opencode,
whycodes) or, for Codex profiles, `omniroute configure codex`; launch one with the right
environment injected via `omniroute run <target>`, or write its config by hand
(Quick Start below). The per-command reference lives in
[CLI Integrations](../guides/CLI-INTEGRATIONS.md).

## How It Works

```
Claude / Codex / OpenCode / Cline / KiloCode / Continue / Hermes Agent / Goose / ...
           │
           ▼  (all point to OmniRoute)
    http://YOUR_SERVER:20128/v1
           │
           ▼  (OmniRoute routes to the right provider)
    Anthropic / OpenAI / Gemini / DeepSeek / Groq / Mistral / ...
```

**Benefits:**

- One API key to manage all tools
- Cost tracking across all CLIs in the dashboard
- Model switching without reconfiguring every tool
- Works locally and on remote servers (VPS, Docker, Akamai, Cloudflare Tunnel)

---

## Source of Truth

The unified catalog lives in `src/shared/constants/cliTools.ts` as `CLI_TOOLS: Record<string, CliCatalogEntry>`.

Each entry has these fields (defined in `src/shared/schemas/cliCatalog.ts`):

| Field                                           | Type                                               | Description                                          |
| ----------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `category`                                      | `"code" \| "agent"`                                | Catalog group (coding tool or agent)                 |
| `vendor`                                        | `string`                                           | Tool origin ("Anthropic", "OSS (P. Gauthier)")       |
| `acpSpawnable`                                  | `boolean`                                          | Also usable as an ACP agent                          |
| `baseUrlSupport`                                | `"full" \| "partial" \| "none"`                    | Custom endpoint support level. `"none"` = not listed |
| `configType`                                    | `"env" \| "custom" \| "guide" \| "custom-builder"` | Configuration mechanism                              |
| `id`, `name`, `color`, `description`, `docsUrl` | standard                                           | Core display fields                                  |

### Capability tiers (cataloged × detectable × configurable × launchable)

Not every cataloged tool is detectable, configurable or launchable. Each tier has one
declaring source, and a drift test keeps them aligned:

| Tier             | Meaning                                                            | Declared in                                                       |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Cataloged**    | Listed in the tool catalog (name, vendor, docs, config type)       | `src/shared/constants/cliTools.ts` (`CLI_TOOLS`)                  |
| **Detectable**   | Binary/config detection, health checks, config paths               | `src/shared/services/cliRuntime.ts` (`CLI_TOOLS` runtime catalog) |
| **Configurable** | Supported by `omniroute configure <cli>` (currently Codex only)    | `bin/cli/cli-manifest.mjs` (`configure: true`)                    |
| **Launchable**   | Supported by `omniroute run <target>` (env/args injection defined) | `bin/cli/cli-manifest.mjs` (`run: true`)                          |

`bin/cli/cli-manifest.mjs` is the canonical executable manifest for the CLI command
surfaces: `run`, `configure` and the shell-completion generators all derive their
target lists, alias resolution (for example `kilocode`/`kilo-code`/`kilo_cli` → `kilo`)
and `--model` flag wiring from it. The drift guard
`tests/unit/cli/cli-manifest-drift.test.ts` asserts that the manifest, the runtime
catalog, the UI catalog and every consumer surface stay in sync — a target added to
one surface without the others fails the suite instead of drifting silently.

---

## Unsupported CLIs

The following CLIs do not support custom base URL natively and are **not in the catalog**. They need a native custom-endpoint option before they can be integrated.

| CLI                 | Reason                                                     |
| ------------------- | ---------------------------------------------------------- |
| windsurf            | BYOK limited to select Claude models + corporate URL/token |
| amp                 | Closed ecosystem (Sourcegraph)                             |
| amazon-q / kiro-cli | AWS SSO auth, no custom URL                                |
| cowork              | Anthropic Desktop, no configurable endpoint                |

---

## Quick Start

### Step 1 — Get an OmniRoute API Key

1. Open `/dashboard/api-manager` → **Create API Key**
2. Give it a name (e.g. `cli-tools`) and select all permissions
3. Copy the key — you'll need it for every CLI below

> Your key looks like: `sk-xxxxxxxxxxxxxxxx-xxxxxxxxx`

---

### Step 2 — Install CLI Tools

All npm-based tools require Node.js 22.22.2+ or 24.x:

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# OpenAI Codex
npm install -g @openai/codex

# OpenCode
npm install -g opencode-ai

# Cline
npm install -g cline

# KiloCode
npm install -g kilocode

# Qwen Code
npm install -g @qwen-code/qwen-code

# Google Gemini CLI (launchable via `omniroute run gemini` → /v1beta surface)
npm install -g @google/gemini-cli

# Aider
pip install aider-chat

# Smelt
cargo install smelt  # Rust-based

# Pi coding agent
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# jcode
# see https://github.com/1jehuang/jcode for install
```

---

### Step 3 — Set Global Environment Variables

```bash
# OmniRoute Universal Endpoint
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk-your-omniroute-key"
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_AUTH_TOKEN="sk-your-omniroute-key"
# Gemini CLI reads GOOGLE_GEMINI_BASE_URL at the ROOT (its SDK appends /v1beta/... itself)
export GOOGLE_GEMINI_BASE_URL="http://localhost:20128"
export GEMINI_API_KEY="sk-your-omniroute-key"
```

> For a **remote server** replace `localhost:20128` with the server IP or domain,
> e.g. `http://<your-server-ip>:20128`.

---

### Step 4 — Configure Each Tool

#### Claude Code

```bash
# Create ~/.claude/settings.json:
mkdir -p ~/.claude && cat > ~/.claude/settings.json << EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-omniroute-key"
  }
}
EOF
```

Use the unified Anthropic gateway root for Claude Code. Do not append `/v1` here.

**Test:** `claude "say hello"`

---

#### OpenAI Codex

Modern Codex (v0.137+) reads `~/.codex/config.toml` only — the old
`config.yaml` belongs to the legacy npm CLI and is silently ignored. The API
key stays in the `OMNIROUTE_API_KEY` environment variable (`env_key`), never
inside the file:

```bash
mkdir -p ~/.codex && cat > ~/.codex/config.toml << EOF
model_provider = "omniroute"

[model_providers.omniroute]
name                 = "OmniRoute"
base_url             = "http://localhost:20128/v1"
env_key              = "OMNIROUTE_API_KEY"
requires_openai_auth = false
EOF
export OMNIROUTE_API_KEY="sk-your-omniroute-key"
```

Full reference (profiles, `wire_api`, context windows): [CODEX-CLI-CONFIGURATION.md](../guides/CODEX-CLI-CONFIGURATION.md).

**Test:** `codex "what is 2+2?"`

---

#### OpenCode

```bash
mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json << EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute",
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiKey": "sk-your-omniroute-key"
      },
      "models": {
        "claude-sonnet-4-5": { "name": "claude-sonnet-4-5" },
        "claude-sonnet-4-5-thinking": { "name": "claude-sonnet-4-5-thinking" },
        "gemini-3-flash": { "name": "gemini-3-flash" }
      }
    }
  }
}
EOF
```

**Test:** `opencode`

> Use `opencode run "your prompt" --model omniroute/claude-sonnet-4-5-thinking --variant high`
> to send thinking variants.

---

#### Pi Coding Agent

Install the official Pi Coding Agent package with `npm install -g --ignore-scripts
@earendil-works/pi-coding-agent`. Pi reads custom providers from
`~/.pi/agent/models.json`; set `PI_CODING_AGENT_DIR` to move the whole agent directory.
Pi does not discover models from custom endpoints,
so OmniRoute writes the selected model in `models[]` using Pi's `openai-completions` API
and the OmniRoute OpenAI-compatible `/v1` endpoint.

Merge `providers.omniroute` into your existing `models.json` so other providers and
settings remain intact.

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "omniroute": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "sk-your-omniroute-key",
      "omnirouteManaged": true,
      "models": [{ "id": "auto/best-coding", "name": "auto/best-coding" }]
    }
  }
}
```

Pi reloads `models.json` when you open `/model`. Test the configured route with the
provider id and model id you selected:

```bash
pi --provider omniroute --model auto/best-coding --print "Reply with a short greeting."
```

References: [Pi models and custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
[Pi environment variables](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md),
[Pi install instructions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

---

#### Cline (CLI or VS Code)

**CLI mode:**

```bash
mkdir -p ~/.cline/data && cat > ~/.cline/data/globalState.json << EOF
{
  "apiProvider": "openai",
  "openAiBaseUrl": "http://localhost:20128/v1",
  "openAiApiKey": "sk-your-omniroute-key"
}
EOF
```

**VS Code mode:**
Cline extension settings → API Provider: `OpenAI Compatible` → Base URL: `http://localhost:20128/v1`

---

#### KiloCode (CLI or VS Code)

**CLI mode:**

```bash
kilocode --api-base http://localhost:20128/v1 --api-key sk-your-omniroute-key
```

**VS Code settings:**

```json
{
  "kilo-code.openAiBaseUrl": "http://localhost:20128/v1",
  "kilo-code.apiKey": "sk-your-omniroute-key"
}
```

---

#### Continue (VS Code Extension)

Edit `~/.continue/config.yaml`:

```yaml
models:
  - name: OmniRoute
    provider: openai
    model: auto
    apiBase: http://localhost:20128/v1
    apiKey: sk-your-omniroute-key
    default: true
```

Restart VS Code after editing.

---

#### Kiro CLI (Amazon)

```bash
# Login to your AWS/Kiro account:
kiro-cli login

# The CLI uses its own auth — OmniRoute is not needed as backend for Kiro CLI itself.
# Use kiro-cli alongside OmniRoute for other tools.
kiro-cli status
```

---

## Internal OmniRoute CLI

The `omniroute` binary provides commands for server lifecycle, setup, diagnostics, and provider management. Entry point: `bin/omniroute.mjs`.

```bash
omniroute                              # Start server (default port 20128)
omniroute setup                        # Interactive setup wizard
omniroute doctor                       # Check config, DB, ports, runtime
omniroute providers list               # Configured provider connections
omniroute providers test-all           # Test every active connection
omniroute reset-password               # Reset the admin password
omniroute logs                         # Stream request logs
omniroute health                       # Detailed health (breakers, cache, memory)
omniroute --version                    # Print version
omniroute --help                       # Show all commands
```

### Setup & Initialization

```bash
omniroute setup                        # Interactive setup wizard
omniroute setup --non-interactive      # CI/automation mode (reads env vars + flags)
omniroute setup --password '<value>'   # Set admin password directly
omniroute setup --add-provider \
  --provider openai \
  --api-key '<value>' \
  --test-provider                      # Add and test a provider in one shot
```

Recognized environment variables for non-interactive setup:

| Var                 | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `OMNIROUTE_API_KEY` | Provider API key (bound to `--api-key` via Commander `.env()`) |
| `DATA_DIR`          | Override the OmniRoute data directory                          |

All other non-interactive inputs are passed as flags, not environment variables:
`--password`, `--provider`, `--provider-name`, `--provider-base-url`, `--default-model`
(see the `omniroute setup` options above).

### Diagnostics

```bash
omniroute doctor                       # Check config, DB, ports, runtime, memory, liveness
omniroute doctor --json                # Machine-readable JSON
omniroute doctor --no-liveness         # Skip the HTTP health probe
omniroute doctor --host 0.0.0.0        # Override liveness host
omniroute doctor --liveness-url <url>  # Full health endpoint URL override
```

The doctor runs these checks: `Config`, `Database`, `Storage/encryption`,
`Port availability`, `Node runtime`, `Native binary` (better-sqlite3),
`Memory`, and `Server liveness`. It exits non-zero if any check is `fail`.

### Provider Management

```bash
omniroute providers available                       # OmniRoute provider catalog
omniroute providers available --search openai       # Filter catalog by id/name/alias/category
omniroute providers available --category api-key    # Filter by category (api-key, oauth, free, ...)
omniroute providers available --json                # Machine-readable JSON

omniroute providers list                            # Configured provider connections
omniroute providers list --json

omniroute providers test <id|name>                  # Test one configured connection
omniroute providers test-all                        # Test every active connection
omniroute providers validate                        # Local-only structural validation
omniroute providers add <provider> --credential-env PROVIDER_KEY
omniroute providers import ./providers.json --dry-run --json
omniroute providers auth <provider>                 # Existing OAuth flow
omniroute providers edit <id|name> --default-model <model>
omniroute providers remove <id|name> --yes
```

`providers add/import/auth/edit/remove` are API-first and therefore work against
the active local or remote context. Credential input should use
`--credential-stdin` or `--credential-env`; `--dry-run --json` reports only
redacted presence/shape. `providers available` reads the OmniRoute catalog;
`providers list/test/test-all/validate` retain their local SQLite behavior and
do not require the server to be running.

For a custom OpenAI-compatible or Anthropic-compatible node, attach credentials to
the node ID returned by `omniroute nodes add`, using `omniroute keys add "$NODE_ID" --stdin`.
This requires a running server and management authentication for the active context.
The CLI uses `POST /api/providers`, which validates the node and copies its endpoint
settings into the connection. A missing node, authorization failure, or unavailable
server returns an error without creating a local fallback credential.

`nodes add --base-url` sets the node endpoint; it is distinct from the server address
in `OMNIROUTE_BASE_URL`. For OpenAPI files, use
`omniroute openapi dump --format json --out ./openapi.json`; the global `--output`
selects CLI display formatting, not a destination filename.

### Recovery & Reset

```bash
omniroute reset-password                # Reset the admin password (also: omniroute-reset-password)
omniroute reset-encrypted-columns       # Show warning + dry-run for encrypted credential reset
omniroute reset-encrypted-columns --force  # Actually null out encrypted credentials in SQLite
```

### Credential Export (⚠ handle with care)

```bash
omniroute auth export                                 # Show warning + confirmation gate — no DB access
omniroute auth export --force                          # Export ALL connections' DECRYPTED credentials to stdout as JSON
omniroute auth export --force --id <id>                 # Export only the matching connection
omniroute auth export --force --format env               # Emit OMNIROUTE_<PROVIDER>_<FIELD>=<value> lines
omniroute auth export --force --out creds.json           # Write to a file (created with 0600 permissions)
```

`auth export` is **local-only** (direct SQLite read, no HTTP route) and intentionally prints/writes
**plaintext** `apiKey`/`accessToken`/`refreshToken`/`idToken` values — that is the feature, not a
bug. Nothing is read from the database, and nothing is decrypted, without `--force`. A stderr
warning banner always prints before any plaintext is emitted. Requires `STORAGE_ENCRYPTION_KEY` to
be set. A field that fails to decrypt (stale key, corrupt ciphertext) is reported as
`<field>DecryptFailed: true` instead of aborting the whole export or leaking the underlying error.

### Other subcommands

These assume a running OmniRoute server, unless noted otherwise:

```bash
omniroute status                       # Comprehensive runtime status
omniroute logs                         # Stream request logs (--json, --search, --follow)
omniroute config list                  # Display configured CLI tools

omniroute provider list                # List available providers (alias of providers list)
omniroute provider add                 # Register OmniRoute as a provider on a tool
omniroute keys add | list | remove     # Manage API keys
omniroute models [provider]            # List models (--json, --search)
omniroute combo list | switch | create | delete

omniroute backup                       # Snapshot config + DB
omniroute restore                      # Restore from a previous snapshot

omniroute health                       # Detailed health (breakers, cache, memory)
omniroute quota                        # Provider quota usage
omniroute cache                        # Cache status
omniroute cache clear                  # Clear semantic + signature caches

omniroute a2a status | card            # A2A server status / agent card

omniroute env show | get <k> | set <k> <v>  # Inspect / set env vars (temporary)

omniroute test                         # Provider connectivity smoke test
omniroute update                       # Check for updates
omniroute completion                   # Generate shell completion
```

### Common flags

| Flag                | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `--no-open`         | Don't auto-open the browser on start                   |
| `--port <n>`        | Override the API port (default 20128)                  |
| `--non-interactive` | CI mode (no prompts; reads from env/flags)             |
| `--json`            | Machine-readable JSON output (doctor, providers, etc.) |
| `--help`, `-h`      | Show command-specific help                             |
| `--version`, `-v`   | Print the installed version                            |

---

## Available API Endpoints

| Endpoint                   | Description                   | Use For                  |
| -------------------------- | ----------------------------- | ------------------------ |
| `/v1/chat/completions`     | Standard chat (all providers) | All modern tools         |
| `/v1/responses`            | Responses API (OpenAI format) | Codex, agentic workflows |
| `/v1/embeddings`           | Text embeddings               | RAG, search              |
| `/v1/images/generations`   | Image generation              | GPT-Image, Flux, etc.    |
| `/v1/audio/speech`         | Text-to-speech                | ElevenLabs, OpenAI TTS   |
| `/v1/audio/transcriptions` | Speech-to-text                | Deepgram, AssemblyAI     |

---

## Troubleshooting

| Error                        | Cause                   | Fix                                              |
| ---------------------------- | ----------------------- | ------------------------------------------------ |
| `Connection refused`         | OmniRoute not running   | `omniroute serve`                                |
| `401 Unauthorized`           | Wrong API key           | Check in `/dashboard/api-manager`                |
| `No combo configured`        | No active routing combo | Set up in `/dashboard/combos`                    |
| CLI shows "not installed"    | Binary not in PATH      | Check `which <command>`                          |
| Old link `/dashboard/agents` | Pre-v3.8.6 bookmark     | Auto-redirected to `/dashboard/acp-agents` (308) |

## Manage inference-key policy with the OmniRoute CLI

Use an authenticated management context (see [Remote Mode](../guides/REMOTE-MODE.md))
to inspect or update an existing inference key by its ID:

```bash
omniroute --output json keys policy show KEY_ID
omniroute keys policy set KEY_ID --unrestricted
omniroute --output json keys policy show KEY_ID
```

`--unrestricted` is an alias for `--model-access-mode all`. The update clears the
model allowlist. It preserves scopes, connection rules, blocked models, rate limits
and cost limits, so those other controls can still deny a request. An explicit
`--allowed-models ""` also selects `all`; combine it with
`--model-access-mode restricted` to keep a restricted key with no allowed models.
A nonempty comma-separated list selects `restricted` unless explicitly specified.
Contradictory `all` plus a nonempty allowlist is rejected before sending a request.

`--rate-limit 30` sets requests per minute and preserves rules for other time
windows. `--max-cost 5` enables the daily USD cap without changing the weekly cap;
`--max-cost 0` removes the daily cap and preserves the existing usage-limit toggle
and weekly cap. Omitted policy fields remain unchanged. Rate changes read the
current policy first; avoid concurrent edits to the same key's rate-limit array.

Policy commands use authenticated `GET`/`PATCH /api/keys/{id}` and honor the active
context and global `--api-key` option. JSON output contains policy fields only,
without the stored key or its masked representation. An inference-only credential
cannot authorize management changes. A 401/403 requires checking the management
credential and context; it does not establish a local CLI-token or salt failure.
See [CLI Token](../security/CLI_TOKEN.md) for the separate local authentication contract.
