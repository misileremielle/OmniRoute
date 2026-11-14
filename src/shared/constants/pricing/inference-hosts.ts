/**
 * Pricing data — inference-hosts family (serverless GPU / OSS-model hosts + aggregator gateways).
 * Pure data; merged by default-pricing.ts via spread (god-file decomposition; semantic split).
 */
export const DEFAULT_PRICING_INFERENCE = {
  typesafe: {
    "jev-latest": { input: 0.042, output: 0, cached: 0.042, reasoning: 0 },
    "jev-preview": { input: 0.042, output: 0, cached: 0.042, reasoning: 0 },
    "jev-1.13.0": { input: 0.042, output: 0, cached: 0.042, reasoning: 0 },
  },
  openrouter: {
    auto: {
      input: 2.0,
      output: 8.0,
      cached: 1.0,
      reasoning: 12.0,
      cache_creation: 2.0,
    },
  },
  groq: {
    "openai/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "llama-3.3-70b-versatile": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "meta-llama/llama-4-maverick-17b-128e-instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "qwen/qwen3-32b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
  },
  fireworks: {
    "accounts/fireworks/models/gpt-oss-120b": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/deepseek-v3p1": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "accounts/fireworks/models/llama-v3p3-70b-instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "accounts/fireworks/models/qwen3-235b-a22b": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
  },
  // #11773: Developer-tier $/1M from cerebras.ai/pricing (2026-09-03).
  // Signup is a one-time $5 credit, not a $0 token grant — keep paid rates
  // so classifyTier cannot treat Cerebras as the free routing tier.
  cerebras: {
    "gpt-oss-120b": { input: 0.35, output: 0.75, cached: 0, reasoning: 0, cache_creation: 0 },
    "gemma-4-31b": { input: 0.4, output: 0.8, cached: 0, reasoning: 0, cache_creation: 0 },
    "zai-glm-4.7": { input: 2.25, output: 2.75, cached: 0, reasoning: 0, cache_creation: 0 },
    "llama-3.3-70b": { input: 0.85, output: 1.2, cached: 0, reasoning: 0, cache_creation: 0 },
    "llama-4-scout-17b-16e-instruct": {
      input: 0.2,
      output: 0.2,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "qwen-3-235b-a22b-instruct-2507": {
      input: 0.6,
      output: 1.2,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "qwen-3-32b": { input: 0.4, output: 0.8, cached: 0, reasoning: 0, cache_creation: 0 },
  },
  nvidia: {
    "nvidia/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "openai/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    // #18464: NVIDIA hosted free endpoints. build.nvidia.com rate limits them and lists no
    // per-token price, so they are priced at zero. Without a row, usage is unpriced and
    // USD-limited API keys fail closed (#12341) after one request.
    "meta/muse-glimmer-30b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "poolside/laguna-xs-2.1": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "google/gemma-4-31b-it": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "google/diffusiongemma-26b-a4b-it": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    // #18418: emergency fallback default (free endpoint). Without a row, usage is
    // unpriced and USD-limited API keys fail closed (#12341) after one fallback.
    "nvidia/nemotron-3.5-super-vl-120b-a12b": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    // #18604: GPT OSS 20B on the same free hosted endpoint tier (#18464 rationale).
    "openai/gpt-oss-20b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
  },
  nebius: {
    "openai/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "meta-llama/Llama-3.3-70B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
  },
  siliconflow: {
    "openai/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "deepseek-ai/DeepSeek-V3.2": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "deepseek-ai/DeepSeek-V3.1": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "deepseek-ai/DeepSeek-R1": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "Qwen/Qwen3-32B": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "moonshotai/Kimi-K2.5": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "zai-org/GLM-4.7": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "baidu/ERNIE-4.5-300B-A47B": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
  },
  // OpenCode Go per-1M rates from https://opencode.ai/docs/go/ (2026-10-23). The models.dev
  // sync layer overrides these when it carries the same id.
  "opencode-go": {
    "kimi-k3.1-pro": {
      input: 2.0,
      output: 10.0,
      cached: 0.2,
      reasoning: 10.0,
      cache_creation: 2.0,
    },
  },
  hyperbolic: {
    "openai/gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "gpt-oss-120b": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "Qwen/QwQ-32B": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "deepseek-ai/DeepSeek-R1": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "deepseek-ai/DeepSeek-V3": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
    "meta-llama/Llama-3.3-70B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "meta-llama/Llama-3.2-3B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "Qwen/Qwen2.5-72B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "Qwen/Qwen2.5-Coder-32B-Instruct": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
    "NousResearch/Hermes-3-Llama-3.1-70B": {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cache_creation: 0,
    },
  },
};
