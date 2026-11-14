/** APIKEY provider catalog — gateways family. Pure data; merged by apikey/index.ts via spread. */
export const APIKEY_PROVIDERS_GATEWAYS = {
  openrouter: {
    id: "openrouter",
    alias: "openrouter",
    name: "OpenRouter",
    icon: "router",
    color: "#F97316",
    textIcon: "OR",
    passthroughModels: true,
    website: "https://openrouter.ai",
    hasFree: true,
    freeNote: "Free models at $0/token with :free suffix - 20 RPM / 200 RPD",
    serviceKinds: ["llm", "imageToText"],
  },

  "opencode-zen": {
    id: "opencode-zen",
    serviceKinds: ["llm"],
    alias: "opencode-zen",
    name: "OpenCode Zen",
    icon: "opencode",
    color: "#6366f1",
    website: "https://opencode.ai/zen",
    // One credential fronts many upstream models (deepseek, glm, qwen, grok,
    // minimax, ...). A 402 means "this MODEL is not in the plan", not "the
    // account is out of credit", so it must reach the per-model lockout branch
    // instead of parking the whole connection (#12242).
    passthroughModels: true,
  },
  "opencode-go": {
    id: "opencode-go",
    serviceKinds: ["llm"],
    alias: "opencode-go",
    name: "OpenCode Go",
    icon: "opencode",
    color: "#6366f1",
    website: "https://opencode.ai/go",
    // One credential fronts many upstream models (deepseek, glm, qwen, grok,
    // minimax, ...). A 402 means "this MODEL is not in the plan", not "the
    // account is out of credit", so it must reach the per-model lockout branch
    // instead of parking the whole connection (#12242).
    passthroughModels: true,
  },
  "vercel-ai-gateway": {
    id: "vercel-ai-gateway",
    serviceKinds: ["llm"],
    alias: "vag",
    name: "Vercel AI Gateway",
    icon: "route",
    color: "#111827",
    textIcon: "VAI",
    passthroughModels: true,
    website: "https://vercel.com/docs/ai-gateway",
  },
  nanogpt: {
    id: "nanogpt",
    serviceKinds: ["llm"],
    alias: "nanogpt",
    name: "NanoGPT",
    icon: "chat",
    color: "#4F46E5",
    textIcon: "NG",
    website: "https://nano-gpt.com",
  },
  novita: {
    id: "novita",
    serviceKinds: ["llm"],
    alias: "novita",
    name: "Novita AI",
    icon: "auto_awesome",
    color: "#FF4081",
    textIcon: "NV",
    website: "https://novita.ai",
    hasFree: true,
    freeNote: "$0.50 trial credits on signup (valid about 1 year)",
    passthroughModels: true,
  },
  chutes: {
    id: "chutes",
    alias: "chutes",
    name: "Chutes.ai",
    icon: "hub",
    color: "#06B6D4",
    textIcon: "CH",
    website: "https://chutes.ai",
    hasFree: false,
    freeNote:
      "No free tier as of 2026 — Chutes moved to pay-as-you-go (free Early Access ended 2026-03).",
    authHint: "Bearer API key for the Chutes OpenAI-compatible gateway.",
    passthroughModels: true,
    // dots.ocr (rednote-hilab/dots.ocr) is served via Chutes discovery — no static
    // model entry needed (passthroughModels). Declare imageToText alongside llm
    // (declaring serviceKinds means "llm" must be explicit too, see #10275).
    serviceKinds: ["llm", "imageToText"],
  },
};
