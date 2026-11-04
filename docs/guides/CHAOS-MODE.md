---
title: "Auto-Combo Chaos Fan-out"
version: 3.8.51
lastUpdated: 2026-09-01
---

# Auto-Combo Chaos Fan-out

> **Source:** `open-sse/services/autoCombo/chaosEngine.ts`

Two routing features share this fan-out engine:

- `auto/chaos` — Auto-Combo model id: parallel fan-out, one model per provider, one upstream call
  each. See also [AUTO-COMBO.md](../routing/AUTO-COMBO.md).
- Chaos combo config — a persisted combo with `config.chaos.enabled` fans out the same way
  (API-only); `judgeModel` only picks the final answer, no synthesis call.

## `auto/chaos`: parallel fan-out

`auto/chaos` is **not** a fault-injection or resilience-testing knob. Requesting
`model: "auto/chaos"` on `/v1/chat/completions`:

1. Builds a panel of **one model per provider**: the first candidate of each
   connected provider, in candidate-pool order, up to 5 members
   (`OMNIROUTE_CHAOS_MAX_PANEL`, capped at 10)
   (`open-sse/services/autoCombo/virtualFactory.ts`). The `chaos-mode` weight
   pack only sets each member's `weight`; the fan-out does not read it.
2. Sends the same request to every panel member **in parallel**, so one request
   costs one upstream call per panel member
   (`open-sse/services/autoCombo/chaosEngine.ts`, dispatched from
   `open-sse/services/combo.ts`).
3. Streams one status line per panel member as it lands: an SSE comment
   (`: chaos <index> ok|fail <model>`) by default, plus an `omni-chaos-part`
   event (`model`, `index`, `ok`, `error`) when the request sets
   `stream_options.include_chaos_parts: true`. These carry no answer text.
4. Sends **one** panel answer as the final OpenAI-style chunk: the first panel
   member's (`auto/chaos` sets it as `judgeModel`) when it succeeds, otherwise
   the last successful member's. The other panel answers are not returned, so
   you pay for N calls and receive one completion.
