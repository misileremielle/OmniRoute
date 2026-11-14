export { APP_CONFIG, THEME_CONFIG } from "./appConfig";

// Provider API endpoints (for display only)
export const PROVIDER_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  poolside: "https://inference.poolside.ai/v1/chat/completions",
  glm: "https://api.z.ai/api/anthropic/v1/messages",
  glmt: "https://api.z.ai/api/anthropic/v1/messages",
  "bailian-coding-plan":
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
  "qwen-cloud": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  "qwen-cloud-token-plan":
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  "kimi-coding": "https://api.kimi.com/coding/v1/messages",
  "kimi-coding-apikey": "https://api.kimi.com/coding/v1/messages",
  minimax: "https://api.minimax.io/anthropic/v1/messages",
  "minimax-cn": "https://api.minimaxi.com/anthropic/v1/messages",
  apmix: "https://api.apmix.ai/v1/chat/completions",
  paraloncloud: "https://paraloncloud.com/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
};

// Re-export from providers.js for backward compatibility
export {
  NOAUTH_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  SEARCH_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers";

// Re-export from models.js for backward compatibility
export { PROVIDER_MODELS, AI_MODELS } from "./models";
