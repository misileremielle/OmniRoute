---
title: "Guardrails"
version: 3.8.52
lastUpdated: 2026-10-17
---

# Guardrails

> **Source of truth:** `src/lib/guardrails/`
> **Last updated:** 2026-10-17 — v3.8.52 (added [Coverage and limits](#coverage-and-limits):
> which routes and response paths the hooks reach, the merged disable headers (#16412), injection
> block mode as a mandatory boundary (#16413), and what sees a response before post-call)

Guardrails enforce safety, policy, and content transformations at the boundary
between OmniRoute and upstream providers. Each guardrail can inspect (and
optionally reject, transform, or annotate) request payloads (`preCall`) and
upstream responses (`postCall`).

The system is **fail-open**: if a guardrail throws while executing, the registry
records the error and continues with the next guardrail rather than failing the
request. Blocking is an explicit decision (`block: true`), never an accident.
The one exception is an aborted request: when the caller's `signal` is aborted,
a throwing guardrail rejects the hook run instead of being skipped.

The hooks do **not** run on every route or every response. Read
[Coverage and limits](#coverage-and-limits) before relying on a guardrail as a
security control.

## Built-in Guardrails

The registry auto-loads four guardrails in priority order on import
(see `registry.ts` → `registerDefaultGuardrails()`):

| Priority | Name                | Stage(s)       | File                  |
| -------- | ------------------- | -------------- | --------------------- |
| `5`      | `vision-bridge`     | `preCall`      | `visionBridge.ts`     |
| `10`     | `pii-masker`        | `pre` + `post` | `piiMasker.ts`        |
| `20`     | `prompt-injection`  | `preCall`      | `promptInjection.ts`  |
| `95`     | `credential-masker` | `pre` + `post` | `credentialMasker.ts` |

Lower priority numbers run **first**.

### Vision Bridge (`visionBridge.ts`) — Modality Bridge PR-1

The GLM 5.3 base model and `glm-5.3-{low,high,max}` have explicit
`supportsVision:false` registry/spec metadata. The GLM 5.3 Flash variants
remain native-vision models. Claude Code's `/v1/messages` route enters the
shared `handleChat` pre-call guardrail chain **before** Claude-to-OpenAI
translation; nested `Read` tool-result images must be described or handled
before that translation lifts them into OpenAI `image_url` content (#17069).

Intercepts image-bearing requests aimed at **non-vision models** and either
reroutes the whole request to a vision-capable model or replaces the image
parts with text descriptions produced by a configurable vision model before
the upstream call. This lets text-only providers transparently handle
multimodal payloads.

Flow:

1. Skip if the target model already supports vision (unless it appears in the
   forced-bridge list `isVisionBridgeForcedModel`).
2. Extract image parts via `extractImageParts(messages)`
   (`visionBridgeHelpers.ts`), which delegates to the **unified media
   detector** `detectMediaParts()` in `open-sse/utils/mediaParts.ts` — the
   single source of truth shared with the combo compatibility filter.
   Extraction is allowlisted to the shapes `replaceImageParts` can splice
   back (the extract↔replace contract): OpenAI `image_url`, Anthropic base64
   `source.type:"base64"`, Anthropic URL `source.type:"url"`, and Responses
   API `input_image`. Matching images nested inside Claude Code
   `tool_result.content` and Responses tool outputs are also extracted and
   replaced at their original paths; indicator-only shapes are combo-filter
   material and are not extracted.
   Skip if none found.
3. Resolve runtime config via `resolveVisionBridgeRuntimeSettings()`
   (`src/shared/constants/modalityBridgeDefaults.ts`): new `modalityBridge*`
   settings keys win; legacy `visionBridge*` keys remain a **one-cycle
   fallback** (rollback window). Skip before any media traversal when the
   bridge is disabled.
4. Mode selector (`modalityBridgeVisionMode`, see table below) decides
   reroute vs describe. Reroute returns `modifiedPayload` with only `model`
   swapped, plus meta `{ rerouted, fromModel, toModel, imagesKept }`.
5. Describe path: cap images at `maxImages`, compose the task-aware prompt,
   consult the describe cache, call the vision model **in parallel**
   (`Promise.allSettled`), and inject `[Image N]: <description>` text parts in
   their place. A failed describe yields `null`: the raw image is preserved for
   unknown/vision-capable targets (#4012), but a **confirmed text-only direct
   target** or zero-vision combo gets an explicit
   `(unavailable — no vision-capable provider connected)` text stub for
   every undescribed image, including partial failures and images beyond the
   describe-call cap (#17069). The existing all-failed combo describe fallback
   remains in place (#8430).
6. Return `modifiedPayload` + meta (`imagesProcessed`, `descriptions`,
   `processingTimeMs`, `visionModel`).

#### Mode selector (`modalityBridgeVisionMode`)

| Mode       | Default | Behavior                                                                                                                                                                                                                                                            |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`     | ✔       | Legacy heuristic, untouched (#6640/#7204): non-combo/`auto/` models reroute to the best vision model unless the original model already has usable credentials (then describe); combo targets always describe.                                                       |
| `describe` |         | Always describe — the reroute block is skipped entirely; the user's chosen model always answers.                                                                                                                                                                    |
| `reroute`  |         | Force reroute: the keep-credentialed-model guard is bypassed. The reroute-**target** credential guard still applies — when no usable vision target exists, the bridge blocks with a clear error rather than describing or sending raw images to a text-only target. |

Forced modes short-circuit **before** the auto heuristic runs; `auto` behavior
is byte-identical to the pre-PR-1 guardrail.

#### API-key scope (`visionBridgeKeyScope.ts`)

When the caller's API key restricts `allowedConnections`, quota pools
(`allowedQuotas`) or models (`allowedModels` / `blockedModels` /
`modelAccessMode: "restricted"` / `disableNonPublicModels`), the bridge only
picks reroute and describe models the key may use, on connections the key may
use. The describe call then always goes through the OmniRoute self-loop with
the `x-omniroute-self-loop-key-id` header, so the receiving chat request
enforces that key's connection and model policy again. `enforceApiKeyPolicy()`
honors that header only together with the self-loop bearer, so it can only
narrow access, and an id that does not resolve is rejected.

If no vision model is permitted for the key, a **confirmed text-only
target** rejects the image request locally with a clear HTTP 400 instead of
forwarding image bytes to an incapable upstream (#17069). For targets with
unknown or native vision capability, the describe path retains its previous
fail-open behavior (meta `{ skipped: true, reason: "no_permitted_vision_model" }`).
Requests without a key, and keys without these restrictions, behave exactly as
before.

#### Task-aware describe prompt (`modalityBridgeVisionTaskAware`)

Default **true**. `composeVisionPrompt()` (`visionBridgeHelpers.ts`) appends
the text of the **last user message** (truncated to 500 chars) to the base
describe prompt, steering the description toward what the user actually asked
(codex-vision-proxy pattern) and asking the vision model to transcribe visible
text. With the flag off — or no user text — the base prompt is used unchanged.

The describe self-loop's own OpenAI-compatible request (`callVisionModelSingle()`
in `visionBridgeHelpers.ts`) always requests `image_url.detail: "high"` —
unconditionally, for every caller/provider, not gated on any client signal.
Low-detail sampling degrades OCR accuracy for exactly the text-transcription
task this prompt asks for, so the describe call itself always asks for high
detail regardless of what detail level the original inbound request used. This
only affects the internal describe request body; it does not change how
OmniRoute forwards the caller's own `image_url.detail` on the primary request —
that default is applied separately, and only for detected OpenCode clients, in
`defaultImageDetail()` (`open-sse/handlers/chatCore/upstreamBody.ts`). The
Anthropic wire-format branch of the describe self-loop has no `detail` field
and is unaffected by either default.

#### Describe output cap (`modalityBridgeVisionMaxChars`)

| Key                            | Default | Range            |
| ------------------------------ | ------- | ---------------- |
| `modalityBridgeVisionMaxChars` | `0`     | `0` or 100–50000 |

`0` (default) means **no cap** — the description returned by
`callVisionModel()` is passed through unmodified, preserving the existing
behavior. Any value in the 100–50000 range truncates the description with a
`…` suffix before it is spliced back as `[Image N]: <description>`
(`VisionBridgeGuardrail.preCall()` in `src/lib/guardrails/visionBridge.ts`).
Raise this for detail-heavy OCR tasks where the downstream model needs the
full transcription; lower it to bound token usage on chatty vision models.
The dashboard field lives on the Vision tab's Advanced panel
(`modality-bridge-max-chars` in `ModalityBridgeVisionTab.tsx`) and clamps any
value between 1 and 99 up to the 100 floor while leaving an explicit `0`
untouched — `0` is a valid Zod value in its own right
(`z.union([z.literal(0), z.number().int().min(100).max(50000)])`), not merely
the "unset" default.

#### Describe cache (`modalityBridge/bridgeCache.ts`)

In-memory LRU + TTL cache for describe outputs, shared process-wide.
Key = `sha256(imageRef + composedPrompt + configuredBridgeModel)` with
length-prefix framing (no field-boundary collisions). The model component is
the **configured** bridge model, not the model that actually answered —
`callVisionModel` may fall back internally, and keying per attempt would
fragment the cache. Failed describes are never cached. Settings:

| Key                             | Default | Range   |
| ------------------------------- | ------- | ------- |
| `modalityBridgeCacheEnabled`    | `true`  | —       |
| `modalityBridgeCacheTtlMinutes` | `60`    | 1–1440  |
| `modalityBridgeCacheMaxEntries` | `200`   | 10–5000 |

#### Remote image normalization (self-loop describe/base64 fetch)

When the bridge fetches a **remote** image itself — the Anthropic describe
self-call and the claude-wire-format base64 conversion
(`ensureBase64ImagesForClaudeWire`), both via
`fetchRemoteImageAsDataUri()` in `visionBridgeHelpers.ts` — the resulting data
URI is passed through `normalizeDataUri()`
(`open-sse/utils/imageNormalize.ts`) before being embedded in the vision-model
request. Oversized images are downscaled to a **2048px long edge** (matching
the resize cap OpenAI/Anthropic already apply server-side), which cuts
upload bytes/latency without changing what the vision model sees. Resizing
uses `sharp`, loaded via dynamic import: on a platform where its native
binary fails to load, `normalizeDataUri()` **never throws** — it falls back
to a passthrough of the original bytes, so the describe/base64-conversion
path always keeps working. Non-image bytes (a fetch that did not return a
decodable image) are also passed through untouched. This normalization is
scoped to images the bridge fetches for its own self-call — it is never
applied to the caller's raw passthrough payload, consistent with the
opt-in-only mutation principle (Hard Rule #20).

#### Settings schema + migration

The new `modalityBridge*` keys are Zod-validated in `updateSettingsSchema`
(`src/shared/validation/settingsSchemas.ts`): `modalityBridgeVisionEnabled`,
`modalityBridgeVisionMode`, `modalityBridgeVisionModel`,
`modalityBridgeVisionTaskAware`, `modalityBridgeVisionPrompt`,
`modalityBridgeVisionTimeout`, `modalityBridgeVisionMaxImages`,
`modalityBridgeVisionMaxChars`, and the `modalityBridgeCache*` trio. Migration
`141_modality_bridge_settings.sql` copies existing legacy
`visionBridge*` values to the matching new keys (idempotent, never overwrites
an operator-set `modalityBridge*` value); the legacy keys stay accepted as a
read fallback for one release cycle.

#### Transparency header + stats

Describe-transformed responses carry
`x-omniroute-modality-bridge: image->text;model=<visionModel>;parts=<n>`
(built by `buildModalityBridgeHeader()` in `modalityBridge/bridgeStats.ts`,
stamped by `withModalityBridgeHeader()` in `src/sse/handlers/chatHelpers.ts`).
Rerouted requests get **no** header — the payload was untouched and the model
swap is already visible in the response body's `model` field.

`GET /api/modality-bridge/stats` (management auth, same tier as
`GET /api/settings`) returns the in-memory per-modality counters
`{ attempts, successes, bridged, cacheHits, failures, totalLatencyMs,
latencySamples, averageLatencyMs, lastUsedAt }` for `vision`.
`averageLatencyMs` uses `latencySamples`, not all attempts, as its
denominator; an operation without timing does not fabricate a zero-millisecond
sample. `bridged` remains the backward-compatible alias for successful
conversions; failed attempts do not increment it.
Counters reset on process restart by design
(telemetry, not accounting).

#### Dashboard configuration

The dedicated dashboard page is
`/dashboard/settings/modality-bridge`.
The Vision tab exposes enablement, mode, model selection (including the automatic
default), task-aware prompting, advanced timeout/image/description-length/cache
limits, runtime
counters, and a guarded sample request.

The former Vision Bridge card under AI settings is a compatibility link to the
new page; it no longer owns a second copy of the form.

**Self-loop admission bypass:** when the describe call routes through OmniRoute's
own `/v1` self-loop (non-standard provider model), the sub-request sends
`x-omniroute-admission-bypass: internal` and is authenticated with the resolved
self-loop credential — the local `sk_omniroute` sentinel in local mode, or the
operator-configured `OMNIROUTE_API_KEY` / `ROUTER_API_KEY` env key (#1350) so
`REQUIRE_API_KEY=true` deployments can still run the describe call. The bypass
is only honored for those exact credentials, so external clients cannot use the
header to skip admission.

Legacy defaults live in `src/shared/constants/visionBridgeDefaults.ts`; the
new mode/task-aware/cache defaults and the settings resolver live in
`src/shared/constants/modalityBridgeDefaults.ts`. The guardrail exposes a
`deps` constructor option so tests can inject fake `getSettings` and
`callVisionModel` implementations.

### PII Masker (`piiMasker.ts`)

Runs on **both** stages.

- **`preCall`** clones the payload, walks `system`, `messages`, `input`, and
  `prompt` (including plain string items), and applies `processPII()` (from
  `@/shared/utils/inputSanitizer`) to string `content`/`text` fields. When
  `PII_REDACTION_ENABLED=true`, detected PII is redacted in the outbound
  payload. This is independent of `INPUT_SANITIZER_MODE` (which only controls
  prompt-injection policy). When redaction is off, the call records detection
  counts without rewriting content.
- **`postCall`** deep-clones the response, runs `sanitizePIIResponse()` plus
  the Responses-API-shape masker (`maskResponsesOutput` — covers
  `output_text` and `output[].content[].text`). If any redaction occurs, the
  modified response replaces the original.

The guardrail never blocks; it only annotates (`meta.detections`,
`meta.redacted`) or rewrites.

#### Per-type selection, custom patterns and detection counters

**Dashboard → Settings → Security → PII masking** chooses _what_ is masked. It
does not switch masking on: that is still `PII_REDACTION_ENABLED` (request) and
`PII_RESPONSE_SANITIZATION` (response + SSE), both off by default.

- **Per-type selection** — the built-in ids are listed in
  `src/shared/constants/piiTypes.ts` (`PII_BUILTIN_TYPES`). Unset means every
  type (the behaviour before this setting existed). The request engine's
  `ssn_us` pattern maps to `ssn`. Templates (Minimal, Standard, Financial,
  Brazilian, USA, GDPR, POPIA, Full) only fill the checkboxes in the UI.
- **GDPR and POPIA identifiers** — twelve built-in ids covering EU and South
  African personal identifiers (table below). Their regexes, validators and
  jurisdiction tags live in one table, `src/shared/utils/piiPatterns.ts`, which
  both the response sanitizer (`src/lib/piiSanitizer.ts`) and the request
  masker (`src/shared/utils/inputSanitizer.ts`) consume. A match is redacted
  only when its validator accepts it; a bare run of digits is never enough. An
  operator who saved a narrowed selection before these ids existed keeps the
  behaviour it had until the new ids are ticked.
- **Custom patterns** — up to 20 regex or wildcard patterns (`*` = up to 64
  non-whitespace characters, `?` = one). Matches become `[CUSTOM_REDACTED]`.
  Every pattern goes through `compilePiiCustomPattern()`
  (`src/shared/utils/piiCustomPatterns.ts`): at most 500 characters, flags limited
  to `g i m s u`, must compile, must pass `safe-regex` (catastrophic
  backtracking), and must not match an empty string or a redaction placeholder.
  A pattern that fails is refused when saved and when tested, and a stored row
  that fails is skipped at runtime instead of being compiled. Custom patterns only
  run while masking is on.
- **Detection counters** — per-type counts (never matched values), held in
  memory and reset on restart (`src/lib/pii/piiDetectionStats.ts`). They only
  increase while masking is on.

The settings live in the `key_value` table (namespace `pii_settings`,
`src/lib/db/piiSettings.ts`) and are read through a 1 s cache. API:

| Method | Path                     | Purpose                                                                 |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/api/settings/pii`      | Flag state, `enabledTypes`, `customPatterns`, detection counters        |
| `PUT`  | `/api/settings/pii`      | Replace `enabledTypes` (`null` = all) and/or `customPatterns`           |
| `POST` | `/api/settings/pii/test` | Dry-run one pattern against a sample of at most 8 KB; nothing is stored |

All three require management auth and validate the body with Zod
(`src/shared/validation/schemas/piiSettings.ts`). With login disabled
(`requireLogin=false`) `GET` and the test endpoint are open, but `PUT` still
needs a dashboard session, a `manage`-scope API key, an `oma_` access token
with write scope or higher, or the CLI token or internal-service token sent
from loopback.

#### GDPR (EU) and POPIA (South Africa) identifiers

| Id                  | Identifier               | Validation                                                                           |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `iban`              | IBAN                     | Known country, exact length for that country, ISO 13616 MOD-97-10                    |
| `eu_vat`            | EU VAT number            | Known member-state prefix and that state's number format (no VIES lookup)            |
| `es_dni_nie`        | Spanish DNI / NIE        | Control letter (value mod 23); NIE is `X/Y/Z` + 7 digits                             |
| `it_codice_fiscale` | Italian Codice Fiscale   | Control letter from the odd/even position tables                                     |
| `pl_pesel`          | Polish PESEL             | Weighted checksum and an encoded birth date that exists                              |
| `nl_bsn`            | Dutch BSN                | 11-proof (weights 9..2, -1)                                                          |
| `de_steuer_id`      | German Steuer-ID         | ISO 7064 Mod 11,10 plus the digit-structure rules (no leading 0)                     |
| `se_personnummer`   | Swedish personnummer     | Luhn over the last ten digits and a plausible birth date (10 or 12 digits)           |
| `za_id`             | South African ID number  | Luhn over all 13 digits, valid birth month/day, citizenship digit 0 or 1             |
| `za_phone`          | South African phone      | `+27` / `27` prefix, or the national `0..` form written with a space or hyphen       |
| `za_vat`            | South African VAT number | 10 digits starting with `4` **and** "VAT" / "BTW" in the 48 characters before        |
| `za_tax_ref`        | South African tax ref.   | 10 digits starting `0`-`3`, Luhn, **and** "tax" / "SARS" in the 48 characters before |

Because the digit-only formats collide with order numbers, build numbers and
timestamps, the weakest ones (`za_vat`, `za_tax_ref`) need the keyword cue, and
a bare ten-digit `0..` number is not treated as a South African phone number.
Spaced IBANs (`GB29 NWBK ...`) are not matched. On the streaming path the cue is
looked up inside the current chunk only. The ids sit ahead of the generic phone
patterns, so a validated identifier keeps its own placeholder
(`[IBAN_REDACTED]`, `[NL_BSN_REDACTED]`, ...). The `gdpr` and `popia` templates
select the EU and South African ids respectively. Masking itself stays opt-in
(Hard Rule #20): nothing here changes a feature-flag default.

### Prompt Injection (`promptInjection.ts`)

Detects adversarial structures in user-supplied content and enforces the
configured policy. Behavior is driven by environment variables and constructor
options:

| Setting         | Env var                                                                                               | Default | Effect                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled         | `INPUT_SANITIZER_ENABLED`                                                                             | `true`  | When `false`, guardrail short-circuits.                                                                                                                                                  |
| Mode            | `INJECTION_GUARD_MODE` / `INPUT_SANITIZER_MODE`                                                       | `warn`  | Injection policy: `block`, `warn`, or `log`. (`redact` is accepted for back-compat but does **not** strip injection text; request PII rewrite is controlled by `PII_REDACTION_ENABLED`.) |
| Block threshold | `blockThreshold` option / `INPUT_SANITIZER_BLOCK_THRESHOLD` (alias `INJECTION_GUARD_BLOCK_THRESHOLD`) | `high`  | Minimum severity required to block. Medium is observe-only at default.                                                                                                                   |

**Mode precedence** (`getMode`): caller `options.mode` →
`INJECTION_GUARD_MODE` **DB feature-flag override** (Dashboard → Settings →
Feature Flags) → `INJECTION_GUARD_MODE` env → `INPUT_SANITIZER_MODE` env →
`warn`. A dashboard override therefore wins over the env vars, so the Feature
Flags UI controls the running guard live (no restart). The DB read is fail-safe:
if it errors, the guard falls back to the env-based behavior, and when no
override is set behavior is identical to env-only resolution.

Detection sources:

1. `sanitizeRequest()` from `@/shared/utils/inputSanitizer` (shared detector
   set used elsewhere in the pipeline).
2. Built-in `DEFAULT_GUARD_PATTERNS` (currently `system_override_inline` and
   `markdown_system_block`, both `high` severity).
3. Optional `customPatterns` passed via constructor options (strings, regex,
   or `{ name, pattern, severity }` records).

When `mode === "block"` **and** at least one detection meets the severity
threshold, `preCall` returns `{ block: true, message: "Request rejected:
suspicious content detected" }`. In `warn`/`log` modes the guardrail logs but
allows the call. The shared helper `evaluatePromptInjection()` is also exported
for callers that need to evaluate prompts without going through the registry.

**Scan bound (v3.8.20):** the detector only inspects the **first 16 KB** of
joined prompt text — `MAX_INJECTION_SCAN_BYTES = 16 * 1024` (16 384 bytes) in
`src/shared/utils/inputSanitizer.ts`. Both `detectInjection()` and
`evaluatePromptInjection()` `slice(0, MAX_INJECTION_SCAN_BYTES)` before running
the pattern loop. Injection directives sit near the top of an input, so this
caps regex CPU/GC on multi-hundred-KB payloads without weakening detection (cf.
#3932, #4041).

### Credential Masker (`credentialMasker.ts`)

Runs on **both** stages, last in the default chain (priority `95`). Redacts
well-known API-key / secret-token patterns from the outbound payload (message
content, tool-call arguments, tool results) **and** the provider response, so a
credential pasted into a prompt (or echoed back by a tool result) is not leaked
to the upstream provider or back to the client.

- **Opt-in only**, same convention as PII redaction (Hard Rule #20-adjacent):
  disabled unless `settings.credentialRedactionEnabled === true` **or**
  `CREDENTIAL_REDACTION_ENABLED=true`. With it off, the guardrail is a no-op —
  it never blocks and never rewrites.
- `redactCredentials()` walks the full payload/response tree (`walkValue()`,
  prototype-pollution-safe, cycle-safe via `WeakSet`) and replaces matches with
  a `[REDACTED:<type>]` placeholder, cloning only the branches that actually
  changed.
- `CREDENTIAL_PATTERNS` covers LLM provider keys (OpenAI, OpenAI-proj,
  Anthropic, Google, Hugging Face, Replicate), VCS/SaaS tokens (GitHub, Slack,
  Linear, Notion, npm, Postman, Discord), payment keys (Stripe, Square), cloud
  keys (AWS access key, Twilio, SendGrid, Mailgun), private keys / JWTs,
  credential-bearing connection strings (`mongodb://user:pass@...`, etc.), and
  a generic `Authorization`/`x-api-key`/`api-key`/`apikey` header-value
  pattern. Header-shaped keys (`authorization`, `x-api-key`, `api-key`,
  `apikey`) are redacted structurally (value only, scheme prefix like
  `Bearer `/`Basic ` preserved) rather than via the generic text regex.
- The guardrail never blocks; it only rewrites (`modifiedPayload` /
  `modifiedResponse`) and annotates (`meta.credentialsRedacted`, `meta.count`).

Regression guard: `tests/unit/credential-masker-guardrail.test.ts`.

## Base Contract (`base.ts`)

```typescript
class BaseGuardrail {
  enabled: boolean;
  name: string;
  priority: number;

  constructor(name: string, options?: { enabled?: boolean; priority?: number });

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult | void>;

  async postCall(response: unknown, context: GuardrailContext): Promise<GuardrailResult | void>;
}

interface GuardrailResult<TValue = unknown> {
  block?: boolean; // true short-circuits the chain
  message?: string; // surfaced when blocking
  meta?: Record<string, unknown> | null;
  modifiedPayload?: TValue; // returned by preCall to rewrite the request
  modifiedResponse?: TValue; // returned by postCall to rewrite the response
}

interface GuardrailContext {
  apiKeyInfo?: Record<string, unknown> | null;
  disabledGuardrails?: string[] | null;
  endpoint?: string | null;
  headers?: Headers | Record<string, unknown> | null;
  log?: GuardrailLog | Console | null;
  method?: string | null;
  model?: string | null;
  provider?: string | null;
  signal?: AbortSignal;
  sourceFormat?: string | null;
  stream?: boolean;
  targetFormat?: string | null;
}
```

A guardrail signals "no change" by returning either `void`, `{}`, or
`{ block: false }`. Returning a `modifiedPayload`/`modifiedResponse` replaces
the value flowing through the chain for downstream guardrails.
`signal?: AbortSignal` carries the caller lifecycle into guardrails. A request abort is the deliberate fail-open exception: media bridges stop work and cleanup without restoring raw media to a target known not to support it.

## Registry (`registry.ts`)

The singleton `guardrailRegistry` exposes:

- `register(guardrail)` — adds (or replaces by normalized name) a guardrail and
  re-sorts by ascending `priority`.
- `clear()` / `list()` — administrative helpers.
- `runPreCallHooks(payload, context)` — iterates active guardrails, threads the
  payload through `modifiedPayload`, and stops on the first `block: true`.
- `runPostCallHooks(response, context)` — same flow on the response side.
- `resetGuardrailsForTests({ registerDefaults })` — clears state and optionally
  re-registers the defaults for clean test isolation.

Both runners return `{ blocked, payload|response, results, guardrail?, message? }`
where `results` is an array of `GuardrailExecutionResult` records that include
per-guardrail `blocked`, `skipped`, `modified`, `error`, and `meta` fields,
useful for tracing.

### Disabling Guardrails Per-Request

`resolveDisabledGuardrails({ apiKeyInfo, body, headers })` aggregates a
de-duplicated list of guardrail names that should be skipped for the current
request. There are five channels, read in this order and merged into one list
(first occurrence wins when de-duplicating):

1. `apiKeyInfo.disabledGuardrails`
2. Request body `disabledGuardrails` (top-level)
3. Request body `metadata.disabledGuardrails` (only when `metadata` is an object)
4. Header `x-omniroute-disabled-guardrails`
5. Legacy header `x-disabled-guardrails`

All five channels are merged, the two headers included: sending both
`x-omniroute-disabled-guardrails` and `x-disabled-guardrails` skips the union of
their lists, and an empty modern header no longer hides the legacy one
([#16412](https://github.com/diegosouzapw/OmniRoute/issues/16412), fixed in
[#16805](https://github.com/diegosouzapw/OmniRoute/pull/16805)).

Values may be arrays of strings or a comma-separated string; names are trimmed
and normalized to lowercase kebab-case (`pii_masker` → `pii-masker`), and empty
entries are dropped. The result is passed through `context.disabledGuardrails`
to the registry, which skips matching guardrails (`skipped: true` in `results`).

The disable list only affects the **registry**. Prompt-injection `block` mode is
a mandatory boundary: the injection-guard middleware
(`src/middleware/promptInjectionGuard.ts`) calls `evaluatePromptInjection()`
without any caller-controlled disable list (the dead
`resolveDisabledGuardrails({ body })` call it used to make was removed in
[#16934](https://github.com/diegosouzapw/OmniRoute/pull/16934)), so a request
that disables `prompt-injection` is still rejected in `block` mode. This is by
design. The disable channels are caller-controlled (request body,
metadata, headers), and a caller must not be able to switch off a security
control the operator set
([#16413](https://github.com/diegosouzapw/OmniRoute/issues/16413)). The header
union from [#16412](https://github.com/diegosouzapw/OmniRoute/issues/16412)
changes only which registry guardrails are skipped; it does not let a client
bypass the middleware. Mandatory per-key and per-group guardrail policies are
tracked in the v4 RFC [#16417](https://github.com/diegosouzapw/OmniRoute/issues/16417).
See [Coverage and limits](#coverage-and-limits).

## Execution Order

For each request flowing through `src/sse/handlers/chat.ts` and
`open-sse/handlers/chatCore.ts` (the chat-family routes listed under
[Coverage and limits](#coverage-and-limits)):

1. `resolveDisabledGuardrails(...)` builds the skip list from API key, body,
   and headers.
2. `guardrailRegistry.runPreCallHooks(body, ctx)` runs guardrails in ascending
   priority order:
   - Disabled guardrails are recorded as `skipped`.
   - Each guardrail's `preCall` may rewrite the payload via `modifiedPayload`.
   - The first `block: true` short-circuits the chain and the handler returns
     a guardrail rejection response.
3. The (potentially rewritten) payload flows into combo routing and upstream
   dispatch.
4. **Non-streaming only:** after the response is assembled,
   `guardrailRegistry.runPostCallHooks(...)` runs the same chain on the
   response. `block: true` here drops the upstream response and returns HTTP 400. Streamed responses skip this step entirely.

Guardrails that throw are recorded with `error: <message>` and logged via
`logger.warn`, but the chain continues — fail-open by design.

## Coverage and limits

The guardrail registry is wired into the chat pipeline only. These limits are
pinned by `tests/unit/guardrail-pipeline-wiring-characterization.test.ts` and
`tests/unit/guardrail-pipeline-characterization.test.ts`; update those tests
deliberately when the behavior changes.

### Where the hooks run

| Hook / control                      | Runs on                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runPreCallHooks`                   | Requests handled by `handleChat` (`src/sse/handlers/chat.ts`): `/v1/chat/completions`, `/v1/messages`, `/v1/responses` (and `/v1/responses/*`), `/v1/relay/chat/completions`, `/v1/providers/{provider}/chat/completions`, `/v1/api/chat`, `/v1/antigravity`, `/v1beta/models/*`, and the Telegram chat proxy. Also the dashboard test endpoint `/api/guardrails/test`. A pre-call block returns HTTP 400. |
| `runPostCallHooks`                  | **Non-streaming** chat responses only (`open-sse/handlers/chatCore/nonStreamingResponse.ts`). Streamed responses never reach it.                                                                                                                                                                                                                                                                           |
| Streaming PII                       | `createPiiSseTransform` (`src/lib/streamingPiiTransform.ts`), piped in `streamingPipeline.ts` when `PII_RESPONSE_SANITIZATION` is on. It is not a guardrail, so the disable channels don't affect it.                                                                                                                                                                                                      |
| Injection-guard middleware (legacy) | Every prompt-bearing `/v1` route, chat-family included (see [route coverage](#injection-guard-route-coverage--red-team-phase-8--block-d)). Prompt injection only.                                                                                                                                                                                                                                          |

### What is not covered

- **Media, embeddings and data routes** (`/v1/images/*`, `/v1/embeddings`,
  `/v1/audio/*`, `/v1/videos/generations`, `/v1/music/generations`,
  `/v1/rerank`, `/v1/search`) never reach the registry. No
  PII masking, credential masking or vision bridge runs there. Their only
  check is the legacy injection-guard middleware.
- **Streamed responses** get no post-call guardrails: no `pii-masker` or
  `credential-masker` post-call, and no post-call block. Only the streaming PII
  transform applies (when `PII_RESPONSE_SANITIZATION` is on). A credential
  echoed back in a streamed response is not redacted.
- **Disable channels vs. the middleware (by design):** the middleware evaluates
  prompt injection with its own call to `evaluatePromptInjection()`, without
  passing any caller-controlled disable list. `block` mode is a mandatory
  boundary that caller-controlled disables cannot bypass, including on chat-family routes
  ([#16413](https://github.com/diegosouzapw/OmniRoute/issues/16413)). Disabling
  `prompt-injection` only skips the registry guardrail.

### What sees a response before post-call

On the non-streaming path the order is: memory extraction → built-in tool
execution → post-call guardrails → post-call block exit → semantic-cache store.

- **Memory extraction** and **tool execution** see the response before post-call
  guardrails can rewrite or block it. Since
  [#16401](https://github.com/diegosouzapw/OmniRoute/pull/16401), memory
  extraction runs the extracted text through `sanitizePII` when
  `PII_RESPONSE_SANITIZATION` is on (both streaming and non-streaming), but a
  response that post-call later blocks has still been offered to memory and
  tools.
- **The semantic cache** stores the response after post-call, so it stores the
  rewritten response, and a blocked response is never cached. Cache entries are
  keyed per API key.

## Configuration

Environment variables read by the built-in guardrails:

| Variable                              | Used by                   | Effect                                                                                              |
| ------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `INPUT_SANITIZER_ENABLED`             | `prompt-injection`        | Set `false` to disable detection entirely.                                                          |
| `INPUT_SANITIZER_MODE`                | `prompt-injection`        | Injection policy: `warn`, `block`, or `log`. Legacy value `redact` does not rewrite injection text. |
| `INJECTION_GUARD_MODE`                | `prompt-injection`        | Mode for the injection guard; also a DB feature flag that **overrides** the env vars (DB > ENV).    |
| `INPUT_SANITIZER_BLOCK_THRESHOLD`     | `prompt-injection`        | Minimum severity that `MODE=block` rejects: `high` (default), `medium`, or `low`.                   |
| `INJECTION_GUARD_BLOCK_THRESHOLD`     | `prompt-injection`        | Legacy alias for `INPUT_SANITIZER_BLOCK_THRESHOLD`.                                                 |
| `PII_REDACTION_ENABLED`               | `pii-masker`              | When `true`, request PII is redacted (independent of injection mode).                               |
| `PII_RESPONSE_SANITIZATION` / `_MODE` | `pii-masker` (downstream) | Controls response-side masker behavior.                                                             |

The Vision Bridge guardrail reads runtime config from the DB-backed settings
store (`getSettings()`), not env vars. Vision's primary keys are
`modalityBridgeVisionEnabled`, `modalityBridgeVisionMode`,
`modalityBridgeVisionModel`, `modalityBridgeVisionTaskAware`,
`modalityBridgeVisionPrompt`, `modalityBridgeVisionTimeout`,
`modalityBridgeVisionMaxImages`, `modalityBridgeVisionMaxChars`,
`modalityBridgeCacheEnabled`, `modalityBridgeCacheTtlMinutes`, and
`modalityBridgeCacheMaxEntries`. The legacy
`visionBridge*` keys are accepted only as the documented one-cycle read
fallback; dashboard writes use the primary keys. Defaults and the fallback
resolver live in `src/shared/constants/modalityBridgeDefaults.ts`, with legacy
constants retained in `src/shared/constants/visionBridgeDefaults.ts`.

## Custom Guardrails

```typescript
import { BaseGuardrail, guardrailRegistry } from "@/lib/guardrails";

class BudgetGuardrail extends BaseGuardrail {
  constructor() {
    super("budget", { priority: 50 });
  }

  async preCall(payload, ctx) {
    if (ctx.apiKeyInfo?.budgetExceeded) {
      return { block: true, message: "Daily budget exceeded" };
    }
    return { block: false };
  }
}

guardrailRegistry.register(new BudgetGuardrail());
```

Steps:

1. Create `src/lib/guardrails/myGuardrail.ts` extending `BaseGuardrail`.
2. Implement `preCall` and/or `postCall`.
3. Either register at import time (push from `registerDefaultGuardrails`) or
   call `guardrailRegistry.register(...)` at runtime — the registry replaces
   any prior guardrail with the same normalized name.
4. Add tests under `tests/unit/` (existing examples:
   `tests/unit/guardrails-registry.test.ts`,
   `tests/unit/prompt-injection-guard.test.ts`,
   `tests/unit/guardrails/visionBridge.test.ts`).

## Testing

Use `resetGuardrailsForTests()` between tests to start from a known state.
Pass `{ registerDefaults: false }` to start with an empty registry and
register only the guardrails under test. Vision Bridge accepts dependency
injection (`deps.getSettings`, `deps.callVisionModel`), so tests can exercise the flow
without DB or network access.

## See Also

- `src/lib/guardrails/` — implementation
- `src/shared/utils/inputSanitizer.ts` — shared detector that powers
  prompt-injection and PII masking
- `src/shared/constants/visionBridgeDefaults.ts` — Vision Bridge defaults and
  forced-bridge model list
- `src/shared/constants/modalityBridgeDefaults.ts` — shared Vision/Audio runtime defaults
- `docs/architecture/RESILIENCE_GUIDE.md` — orthogonal layer (circuit breaker, cooldowns)
- `docs/reference/ENVIRONMENT.md` — full env var reference

## Injection-guard route coverage & red-team (Phase 8 · Block D)

The injection-guard (`createInjectionGuard` / `withInjectionGuard`) covers all routes
that accept user prompts. It respects `INJECTION_GUARD_MODE` (default `warn` = log only;
`block` = returns HTTP 400 `SECURITY_001`).

| Type            | Routes                                                                                                                                               | Default mode |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Text (existing) | `/v1/chat/completions`, `/v1/relay/chat/completions`                                                                                                 | warn         |
| Generative      | `/v1/messages`, `/v1/responses`, `/v1/images/generations`, `/v1/images/edits`, `/v1/videos/generations`, `/v1/music/generations`, `/v1/audio/speech` | warn         |
| Data            | `/v1/embeddings`, `/v1/rerank`, `/v1/search`                                                                                                         | warn         |

Text extraction (`extractMessageContents`) covers `messages`/`input`/`prompt`/`query`+`documents`/`instructions`/`system`.

**Red-team (nightly, `nightly-llm-security.yml`):** promptfoo validates that each route blocks
the OWASP-LLM corpus in `INJECTION_GUARD_MODE=block`; garak runs probes (skips without secret).
Block mode is a mandatory boundary: `evaluatePromptInjection()`
ignores the per-request disable list the middleware passes it, so `disabledGuardrails` does
**not** exempt a route from it ([#16413](https://github.com/diegosouzapw/OmniRoute/issues/16413)).

The nightly workflow (`.github/workflows/nightly-llm-security.yml`, cron + manual
dispatch) has two jobs:

- **`promptfoo-guard` (blocking)** — runs `promptfoo eval -c promptfooconfig.yaml`
  with `INJECTION_GUARD_MODE=block`. Each adversarial case (e.g. "ignore all
  previous instructions…", DAN-style jailbreaks) asserts the response carries
  `error.code === "SECURITY_001"`, i.e. the guard actually rejected the request.
- **`garak` (advisory)** — runs garak `--probes promptinject,dan,leakreplay`
  against a local OmniRoute instance (`http://localhost:20128/v1`). Gated on a
  provider secret (`PROMPTFOO_PROVIDER_KEY`); skips gracefully and is suffixed
  `|| true`, so it reports without failing CI.

Coverage of the guard helper (`createInjectionGuard` / `withInjectionGuard`)
spans every prompt-bearing `/v1` route; prompt text is pulled from
`messages`/`input`/`prompt`/`query`+`documents`/`instructions`/`system` by
`extractMessageContents()` in `src/shared/utils/inputSanitizer.ts`.
