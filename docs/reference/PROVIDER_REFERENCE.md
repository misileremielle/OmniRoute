---
title: "Provider Reference"
version: 3.8.54
lastUpdated: 2026-11-14
---

# Provider Reference

> **Auto-generated** from `src/shared/constants/providers.ts` — do not edit by hand.
> Regenerate with: `npm run gen:provider-reference`
> **Last generated:** 2026-11-14

Total providers: **223**. See category breakdown below.

## Categories

- **Free** — free tier with API key (configured via dashboard)
- **No-auth** — public endpoints that require no key or sign-in at all
- **OAuth** — sign-in flow handled by OmniRoute, no API key needed
- **Web cookie** — wraps the provider's web app via cookie auth
- **API key** — paid provider configured via API key (free credits may apply)
- **Local** — runs on the user's machine (Ollama, LM Studio, vLLM, etc.)
- **Search** — web search providers
- **Upstream proxy** — providers that proxy to other providers
- **Cloud agent** — long-running coding agents (Codex Cloud, Devin, Jules)
- **System** — OmniRoute-internal providers (loopback, etc.)

Additional tags: `image`, `video`, `aggregator`, `enterprise`, `embed/rerank`, `self-hosted`.

`Tool calling` (where shown): `native` — real function-calling API; `emulated` — the `tools` array is prompt-emulated via `webTools.ts` (regex-parsed `<tool>{...}</tool>` blocks); `none` — `tools` is currently silently dropped. See #7286.

Use the dashboard at `/dashboard/providers` to enable, configure, and test each provider.

---

## No-auth Providers (no key required) (9)

| ID | Alias | Name | Tags | Website | Notes | Tool calling |
|----|-------|------|------|---------|-------|--------------|
| `aihorde` | `horde` | AI Horde | No-auth | [link](https://aihorde.net) | No API key required — uses AI Horde's documented anonymous key. Adding a free aihorde.net key is optional and only buys higher queue priority (kudos). | — |
| `auggie` | `aug` | Augment (Auggie CLI) | No-auth | [link](https://augmentcode.com) | No API key stored by OmniRoute. Install the Auggie CLI and run `auggie login` on this machine, then OmniRoute spawns it locally for each request. | — |
| `cloudflare-playground` | `cfp` | Cloudflare AI Playground | No-auth | [link](https://playground.ai.cloudflare.com) | No credentials required — anonymous browser sessions over a reverse-engineered cf_agent WebSocket protocol (Playwright transport). | emulated |
| `codex-app-server` | `cxa` | OpenAI Codex (App-Server) | No-auth | [link](https://developers.openai.com/codex/cli) | No token stored by OmniRoute. The Codex CLI app-server manages its own ChatGPT sign-in (~/.codex/auth.json, auto-refreshed). Use “Sign in with ChatGPT” if the CLI is not yet authenticated. | — |
| `devin-cli-agentic` | `dva` | Devin CLI Agentic Bridge | No-auth | [link](https://docs.devin.ai/work-with-devin/devin-cli) | Authentication is owned by the official Devin CLI in its isolated bridge volume. | emulated |
| `duckduckgo-web` | `ddgw` | DuckDuckGo AI Chat | No-auth | [link](https://duckduckgo.com/duckchat) | No credentials required — DuckDuckGo AI Chat is anonymous and free. | emulated |
| `minimax-code` | `mmcode` | MiniMax Code | No-auth | [link](https://www.minimax.io) | No API key stored by OmniRoute. The provider reads the local MiniMax Code profile to authenticate a run. You can also sign in to your MiniMax account from this page (device code) — the credential is written into that same local profile. | native |
| `uncloseai` | `unc` | UncloseAI | No-auth | [link](https://uncloseai.com) | No auth required. API accepts any non-empty string as key for identification. If older built-in models return 404, use Available Models → Import from /models or Auto-Sync; verified live model: turboderp/Qwen3.8-27B-exl3. | emulated |
| `zcode` | `zc` | ZCode (GLM Coding Plan) | No-auth | [link](https://zcode.z.ai) | No API key stored by OmniRoute. The local ZCode app-server uses the existing builtin:zai-coding-plan login. | — |

## OAuth Providers (30)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `agy` | `agy` | Antigravity CLI | OAuth | [link](https://antigravity.google) | Import your Antigravity CLI (`agy`) login (paste/upload its token file), auto-detect a local CLI login, or sign in with Google. Shares the Antigravity backend (incl. Claude models). |
| `amazon-q` | `aq` | Amazon Q | OAuth | [link](https://aws.amazon.com/q/developer/) | Uses the same AWS Builder ID or imported refresh-token flow as Kiro, but keeps Amazon Q connections separate. |
| `antigravity` | — | Antigravity | OAuth | — | — |
| `chatgpt` | `chatgpt` | ChatGPT | OAuth | — | Sign in with ChatGPT to authorize eligible requests using your ChatGPT plan. Separate from Codex and ChatGPT Web. Preview limitations apply. |
| `claude` | `cc` | Claude Code | OAuth | — | — |
| `cline` | `cl` | Cline | OAuth | — | Sign in with your Cline account (OAuth), or paste a direct API key from app.cline.bot → Settings → API Keys. Multiple API keys are supported and rotated automatically — add each as a separate connection. |
| `clinepass` | `cp` | ClinePass | OAuth | [link](https://cline.bot/cline-pass) | ClinePass is Cline's $9.99/mo subscription bundling 10 open coding models. Sign in with your Cline account (same login as the Cline CLI/IDE), or paste a direct ClinePass API key (app.cline.bot → Settings → API Keys). A ClinePass subscription unlocks the cline-pass/* models. Reuses the Cline WorkOS OAuth flow. |
| `codebuddy-cn` | `cbcn` | CodeBuddy CN | OAuth | [link](https://copilot.tencent.com) | Tencent CodeBuddy CN (copilot.tencent.com). Sign in via the official CLI device-code flow, or paste a direct API key (sent as Authorization: Bearer). Catalog: GLM / Kimi / MiniMax / DeepSeek / Hunyuan. |
| `codebuddy-intl` | `cbai` | CodeBuddy Intl | OAuth | [link](https://www.codebuddy.ai) | CodeBuddy International (codebuddy.ai). Sign in via the device-code flow, or paste a direct API key (sent as Authorization: Bearer). Catalog: GLM / Kimi / MiniMax / DeepSeek / Hunyuan. |
| `codex` | `cx` | OpenAI Codex | OAuth | — | — |
| `cursor` | `cu` | Cursor IDE | OAuth | — | — |
| `devin-cli` | `dv` | Devin CLI | OAuth | [link](https://cli.devin.ai) | Requires the Devin CLI binary. Run `devin auth login` to authenticate, or provide your WINDSURF_API_KEY. Install: https://cli.devin.ai |
| `devin-desktop` | — | Devin Desktop | OAuth | [link](https://devin.ai) | Paste an existing Devin API key from an authenticated Devin session. Key export availability and steps vary by Devin version and account. |
| `freebuff` | `freebuff` | Freebuff | OAuth | [link](https://freebuff.com) | Sign in with the Freebuff browser login (same as `freebuff login`), or paste an existing Freebuff / Codebuff auth token. The token has no refresh grant — when it expires, sign in again. |
| `ghe-copilot` | `ghe-copilot` | GitHub Enterprise Copilot | OAuth | — | Enter your GHE instance URL (e.g., https://ghe.company.com) in provider settings, then authenticate via device flow. |
| `github` | `gh` | GitHub Copilot | OAuth | — | — |
| `gitlab-duo` | `gitlab-duo` | GitLab Duo | OAuth | [link](https://docs.gitlab.com/user/duo_agent_platform/code_suggestions/) | GitLab Duo OAuth is not configured. Register an OAuth application at https://gitlab.com/-/profile/applications with redirect URI http://localhost:20128/callback and scopes "ai_features read_user", then set GITLAB_DUO_OAUTH_CLIENT_ID (and optionally GITLAB_DUO_OAUTH_CLIENT_SECRET) and restart. |
| `grok-cli` | `gc` | Grok Build | OAuth | — | Sign in with your browser, or paste your ~/.grok/auth.json (or the JWT access token) from the Grok Build CLI; refresh_token is rotated automatically either way. Imagine image/video and TTS/STT reuse this login where your account is entitled. |
| `kilocode` | `kc` | Kilo Code | OAuth | — | Sign in with your Kilo Code account (device-code OAuth), or paste a direct API key from app.kilo.ai → Settings → API Keys. Multiple API keys are supported and rotated automatically — add each as a separate connection. Without any connection, free anonymous models are available via the anonymousFallback. |
| `kimi-coding` | `kmc` | Kimi Code CLI | OAuth | [link](https://www.kimi.ai/code) | Sign in with the same Kimi account used by Kimi Code CLI. OmniRoute uses the CLI OAuth flow and Kimi Coding Plan endpoints. |
| `kiro` | `kr` | Kiro AI | OAuth | — | Free tier: 50 credits/month (~25K–100K tokens). ⚠️ Kiro ToS prohibits third-party proxy/harness use. |
| `megabrain` | `mb` | MegaBrain | OAuth | [link](https://getmegabrain.com) | Sign in with your MegaBrain account (device code), or paste an mb-v1-… MegaBrain API key (add each key as a separate connection to rotate them). A paid plan covers the included models (Auto, GLM, Kimi, MiniMax, Grok, DeepSeek, Qwen) within its session and weekly limits; Claude, GPT and Gemini are paid from the account's credits, from Pro up or with Extra Usage turned on. Address models as mb/<model> or megabrain/<model>. |
| `muse-code` | `mc` | Muse Code (Meta) | OAuth | [link](https://ai.developer.meta.com/docs/muse-code/auth) | Sign in with the Muse Code device flow (same as `muse login` / CLIProxyAPI `-meta-login`) to use a Muse subscription, or paste a META_API_KEY. Device login keeps the durable dca token and mints the inference key; a 401 remints that key. Wire format is OpenAI Responses (POST /responses). |
| `openference` | `of` | Openference | OAuth | [link](https://openference.com) | Sign in with your Openference account to route requests through api.openference.com. Includes free-tier access to Qwen3.8 27b and Llama 3.2 3B — see openference.com/pricing for current plan terms. |
| `qoder` | `if` | Qoder | OAuth | — | PAT (pt-): requires local qodercli; plain chat only, no caller tools, buffered streaming and a 45-second chat limit. HTTP keys use DashScope; browser OAuth requires administrator configuration. |
| `trae` | `tr` | Trae | OAuth | [link](https://trae.ai) | Trae is an AI-native IDE by ByteDance (SOLO remote agent). Authorize via trae.ai in the popup, or sign in at solo.trae.ai and paste the Cloud-IDE-JWT (sent as 'Authorization: Cloud-IDE-JWT <token>', ~14-day lifetime) as the access token; web_id/biz_user_id/user_unique_id/scope/tenant/region propagate via providerSpecificData. No headless refresh for pasted tokens — re-paste on expiry. |
| `workbuddy` | `wb` | WorkBuddy | OAuth | [link](https://www.workbuddy.ai) | Tencent WorkBuddy (www.workbuddy.ai). Authorize the CLI device flow in the popup; OmniRoute then polls for the token and attaches the required X-Product: SaaS header. The model roster is served by the authenticated catalogue, so it is discovered live rather than listed here. WorkBuddy only accepts streaming requests, which OmniRoute accumulates back into a JSON response for non-streaming callers. |
| `xai-oauth` | `xao` | xAI OAuth (Grok) | OAuth | [link](https://x.ai) | Sign in with xAI to use api.x.ai models such as Grok 4.5. This is separate from Grok Build JWT sessions, which use cli-chat-proxy.grok.com and grok-build model aliases. |
| `zed` | `zd` | Zed IDE | OAuth | [link](https://zed.dev) | Zed stores LLM provider credentials (OpenAI, Anthropic, Google, Mistral, xAI) in the OS keychain. Use the Import button below to discover and import them automatically. |
| `zed-hosted` | — | Zed Hosted Models | OAuth | [link](https://zed.dev) | Sign in with your Zed account (native-app sign-in). OmniRoute generates a one-time RSA keypair and opens zed.dev to authorize it — on a remote/headless install, copy the resulting 127.0.0.1 callback URL from your browser's address bar and paste it back here. Distinct from the 'Zed IDE' credential-import entry above: this proxies chat completions through Zed's own hosted model aggregator (cloud.zed.dev), fronting Anthropic/OpenAI/Google/xAI models under your Zed plan. |

## API Key Providers (paid / paid-with-free-credits) (147)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `360ai` | `360ai` | 360 AI | API key | [link](https://ai.360.cn) | Get API key at ai.360.cn |
| `agnes` | `agnes` | Agnes AI | API key | [link](https://agnes-ai.com) | Get API key at agnes-ai.com |
| `agnes-cn` | `agnescn` | Agnes AI (China) | API key | [link](https://api.agnes-ai.cn) | Get API key from the Agnes CN site. |
| `ai21` | `ai21` | AI21 Labs | API key | [link](https://www.ai21.com) | $10 trial credits on signup (valid 3 months), no credit card required |
| `alibaba` | `ali` | Alibaba Cloud Model Studio | API key | [link](https://bailian.console.alibabacloud.com/) | — |
| `alibaba-cn` | `ali-cn` | Alibaba (China) | API key | [link](https://dashscope.console.aliyun.com/) | — |
| `ant-ling` | `ling` | Ant Ling / Ring (inclusionAI) | API key | [link](https://developer.ant-ling.com/en/docs/) | Register and create an API key at the Ant Ling API console (https://chat.ant-ling.com/open), then paste it here. OmniRoute routes chat traffic to https://api.ant-ling.com/v1/chat/completions; the provider is OpenAI-compatible and also exposes an Anthropic-compatible surface. |
| `anthropic` | `anthropic` | Anthropic | API key | [link](https://platform.claude.com) | — |
| `apmix` | `apmix` | Apmix | API key | [link](https://apmix.ai) | — |
| `arcee-ai` | `arcee` | Arcee AI | API key | [link](https://arcee.ai) | Get API key at arcee.ai |
| `azure-ai` | `azure-ai` | Azure AI Foundry | API key, enterprise | [link](https://learn.microsoft.com/azure/ai-foundry) | Use your Azure AI Foundry key. Base URL can be https://<resource>.services.ai.azure.com/openai/v1/ or https://<resource>.openai.azure.com/openai/v1/. |
| `azure-openai` | `azure` | Azure OpenAI | API key, enterprise | [link](https://azure.microsoft.com/products/ai-services/openai-service) | Use your Azure OpenAI API key. Base URL should be your resource endpoint, for example https://my-resource.openai.azure.com. |
| `baichuan` | `baichuan` | Baichuan | API key | [link](https://www.baichuan-ai.com/) | Get API key at platform.baichuan-ai.com |
| `baidu` | `baidu` | Baidu (ERNIE) | API key | [link](https://ernie.baidu.com/) | Get API key at console.bce.baidu.com |
| `bailian-coding-plan` | `bcp` | Alibaba Token Plan | API key | [link](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) | — |
| `baseten` | `baseten` | Baseten | API key | [link](https://baseten.co) | $30 free trial credits for GPU inference |
| `bedrock` | `bedrock` | Amazon Bedrock | API key, enterprise | [link](https://aws.amazon.com/bedrock) | Use your Amazon Bedrock API key and configure the AWS region where your models are enabled (for example eu-west-2). OmniRoute calls Bedrock's native Converse API directly. |
| `bigmodel` | `bigmodel` | BigModel.cn (Zhipu) | API key | [link](https://open.bigmodel.cn) | — |
| `blackbox` | `bb` | Blackbox AI | API key | [link](https://blackbox.ai) | ⚠️ **DEPRECATED.** api.blackbox.ai returns HTTP 404 on every path variant (sweep 2026-08-21); the public inference surface has moved to the gated enterprise.blackbox.ai/v1 endpoint. |
| `byteplus` | `bpm` | BytePlus ModelArk | API key | [link](https://console.byteplus.com/ark) | — |
| `bytez` | `bytez` | Bytez | API key | [link](https://bytez.com) | $1 free credits, refreshes every 4 weeks |
| `cerebras` | `cerebras` | Cerebras | API key | [link](https://inference.cerebras.ai) | One-time $5 signup credit (30-day validity); a payment method is required. Not a recurring free tier. |
| `cerebrium` | `cerebrium` | Cerebrium | API key | [link](https://www.cerebrium.ai) | $30 one-time credit; set Base URL to your deployment's /run endpoint |
| `chutes` | `chutes` | Chutes.ai | API key, aggregator | [link](https://chutes.ai) | Bearer API key for the Chutes OpenAI-compatible gateway. |
| `clarifai` | `clarifai` | Clarifai | API key, enterprise | [link](https://docs.clarifai.com) | Use your Clarifai PAT or app-specific API key. OmniRoute targets the OpenAI-compatible endpoint at https://api.clarifai.com/v2/ext/openai/v1 and authenticates with Authorization: Key <token>. |
| `cloudflare-ai` | `cf` | Cloudflare Workers AI | API key | [link](https://developers.cloudflare.com/workers-ai) | Requires API Token AND Account ID (found at dash.cloudflare.com) |
| `clova-studio` | `clova` | Naver CLOVA Studio | API key | [link](https://api.ncloud-docs.com/docs/en/ai-naver-clovastudio-summary) | — |
| `codestral` | `codestral` | Codestral | API key | [link](https://mistral.ai) | — |
| `cohere` | `cohere` | Cohere | API key | [link](https://cohere.com) | Free Trial: 1,000 API calls/month for testing, no credit card required |
| `coze` | `coze` | Coze | API key | [link](https://coze.com) | Get API key at coze.com/open/api |
| `cursor-api` | `cua` | Cursor API | API key | [link](https://cursor.com/dashboard/api) | Paste a Cursor user API key (crsr_... or grok_...) from cursor.com/dashboard/api. OmniRoute exchanges it for a session token on demand; no IDE or cursor-agent install is needed. Usage bills to the Cursor plan that owns the key. |
| `databricks` | `databricks` | Databricks | API key, enterprise | [link](https://www.databricks.com) | — |
| `datarobot` | `datarobot` | DataRobot | API key, enterprise | [link](https://docs.datarobot.com) | Use your DataRobot API token. Optional Base URL can be the account root (for LLM Gateway) or a deployment URL under /api/v2/deployments/<id>. |
| `deapi` | `deapi` | deAPI | API key | [link](https://deapi.ai) | Use your deAPI API key (sk-dp-<id>-<secret>) from deapi.ai. OmniRoute sends it as Authorization: Bearer <key>. |
| `deepai` | `deepai` | DeepAI | API key, image | [link](https://deepai.org) | Use your DeepAI API key. Get one at deepai.org — requires a Pro subscription ($9.99/mo). |
| `deepinfra` | `deepinfra` | DeepInfra | API key | [link](https://deepinfra.com) | Free signup credits for API testing and model exploration |
| `deepseek` | `ds` | DeepSeek | API key | [link](https://platform.deepseek.com) | 5M free tokens on signup - no credit card required |
| `dify` | `dify` | Dify | API key | [link](https://dify.ai) | Get API key from your Dify instance. |
| `digitalocean` | `digitalocean` | DigitalOcean | API key | [link](https://docs.digitalocean.com/products/ai-platform/) | — |
| `doubao` | `doubao` | Doubao | API key | [link](https://doubao.com) | Get API key at console.volcengine.com |
| `featherless-ai` | `featherless` | Featherless AI | API key | [link](https://featherless.ai) | Free tier available — no credit card required |
| `fireworks` | `fireworks` | Fireworks AI | API key | [link](https://fireworks.ai) | $1 free starter credits on signup for API testing |
| `friendliai` | `friendli` | FriendliAI | API key | [link](https://friendli.ai) | Free tier for serverless inference — no credit card required |
| `galadriel` | `galadriel` | Galadriel | API key | [link](https://galadriel.com) | ⚠️ **DEPRECATED.** api.galadriel.ai no longer resolves (sweep 2026-06-19); the inference API appears discontinued. |
| `gemini` | `gemini` | Gemini (Google AI Studio) | API key | [link](https://aistudio.google.com) | Free tier available through Google AI Studio; current per-model quotas and regional limits apply |
| `gigachat` | `gigachat` | GigaChat (Sber) | API key | [link](https://developers.sber.ru) | — |
| `gitlab` | `gitlab` | GitLab Duo PAT | API key | [link](https://docs.gitlab.com/user/duo_agent_platform/code_suggestions/) | GitLab personal access token for the public Code Suggestions API. Configure a self-hosted base URL when not using gitlab.com. |
| `glm` | `glm` | GLM Coding | API key | [link](https://z.ai/subscribe) | — |
| `glm-cn` | `glmcn` | GLM Coding (China) | API key | [link](https://open.bigmodel.cn) | — |
| `glmt` | `glmt` | GLM Thinking | API key | [link](https://open.bigmodel.cn) | — |
| `grokified` | `grokified` | Grokified | API key | [link](https://grokified.com) | $5 one-time credit on signup |
| `groq` | `groq` | Groq | API key | [link](https://groq.com) | Free plan: per-model caps (200K tokens/day per chat model; see console.groq.com/docs/rate-limits for RPM/RPD) — no payment method on file. |
| `hcnsec` | `hcnsec` | Huancheng Public API | API key | [link](https://api.hcnsec.cn) | Get API key at api.hcnsec.cn |
| `heroku` | `heroku` | Heroku AI | API key, enterprise | [link](https://www.heroku.com) | — |
| `hetzner` | `hetzner` | Hetzner Inference API | API key | [link](https://experiments.hetzner.com/inference) | Free during Hetzner's experimental phase, no billing yet; no SLA |
| `huggingface` | `hf` | HuggingFace | API key | [link](https://huggingface.co) | Free Inference API for thousands of models (Whisper, VITS, SDXL…) |
| `hyperbolic` | `hyp` | Hyperbolic | API key | [link](https://hyperbolic.xyz) | $1-5 trial credits on signup for serverless inference |
| `iflytek` | `iflytek` | iFlytek Spark | API key | [link](https://xinghuo.xfyun.cn) | Get API key at console.xfyun.cn |
| `inception` | `inception` | Inception | API key | [link](https://docs.inceptionlabs.ai) | 10M free tokens on signup, no credit card required. |
| `inference-net` | `inet` | Inference.net | API key | [link](https://inference.net) | $25 free credits on signup plus research grants available |
| `internlm` | `internlm` | InternLM (Intern-S1) | API key | [link](https://internlm.intern-ai.org.cn/) | Free monthly quota ~1M input / 3M output tokens (~10 RPM) |
| `jina-ai` | `jina` | Jina AI (Foundation API) | API key, embed/rerank | [link](https://jina.ai) | Bearer API key for api.jina.ai — embeddings, rerank, classify, segment, and search. Dashboard keys take precedence over JINA_AI_API_KEY. This is not the Reader / r.jina.ai card and does not fetch URLs. |
| `jina-reader` | `jr` | Jina Reader (r.jina.ai) | API key | [link](https://jina.ai/reader) | Bearer API key for r.jina.ai URL-to-markdown (/v1/web/fetch only). Does not serve /v1/embeddings or /v1/rerank. The same Jina token as Foundation API works; OmniRoute reuses a jina-ai dashboard key or JINA_AI_API_KEY when this card is empty. |
| `kie` | `kie` | KIE.AI | API key | [link](https://kie.ai) | — |
| `kimi` | `kimi` | Kimi (Legacy Moonshot API) | API key | [link](https://platform.kimi.ai) | — |
| `kimi-coding-apikey` | `kmca` | Kimi Code API Key | API key | [link](https://www.kimi.ai/code) | — |
| `lambda-ai` | `lambda` | Lambda AI | API key | [link](https://lambda.ai) | — |
| `liquid` | `liquid` | Liquid AI | API key | [link](https://liquid.ai) | Get API key at liquid.ai |
| `longcat` | `lc` | LongCat AI | API key | [link](https://longcat.chat/platform/docs) | Free: one-time 10M-token grant after account signup + KYC verification (LongCat-2.0). One-time only — not a recurring daily/monthly allowance. |
| `maritalk` | `maritalk` | Maritalk | API key | [link](https://www.maritaca.ai) | — |
| `meta-llama` | `meta` | Meta Llama API | API key | [link](https://llama.developer.meta.com) | — |
| `minimax` | `minimax` | Minimax Coding | API key | [link](https://www.minimax.io) | — |
| `minimax-cn` | `minimax-cn` | Minimax (China) | API key | [link](https://www.minimaxi.com) | — |
| `mistral` | `mistral` | Mistral | API key | [link](https://mistral.ai) | Free Experiment tier: rate-limited access to all models, no credit card required |
| `mixedbread` | `mxbai` | Mixedbread AI | API key | [link](https://www.mixedbread.com) | Bearer API key for the Mixedbread embeddings API. |
| `modal` | `mdl` | Modal | API key, enterprise | [link](https://modal.com/docs) | Use the bearer token that protects your Modal deployment, if enabled. Base URL should point to your OpenAI-compatible Modal app, for example https://<workspace>--<app>.modal.run/v1. |
| `modelscope` | `ms` | ModelScope | API key | [link](https://modelscope.cn) | Free tier via ModelScope API-Inference — Alibaba account required. |
| `monsterapi` | `monster` | MonsterAPI | API key | [link](https://monsterapi.ai) | ⚠️ **DEPRECATED.** Monster API shuttered operations on 2026-06-30. Use alternative OpenAI-compatible providers. |
| `moonshot` | `moonshot` | Kimi | API key | [link](https://platform.kimi.ai) | — |
| `morph` | `morph` | Morph | API key | [link](https://morphllm.com) | Free tier: 250K credits/month, $0 |
| `nanogpt` | `nanogpt` | NanoGPT | API key | [link](https://nano-gpt.com) | — |
| `nebius` | `nebius` | Nebius AI | API key | [link](https://nebius.com) | ~$1 trial credits on signup for API testing |
| `nlpcloud` | `nlpc` | NLP Cloud | API key | [link](https://docs.nlpcloud.com) | Use your NLP Cloud API key in Authorization: Token <key>. OmniRoute targets the chatbot endpoint on https://api.nlpcloud.io/v1/gpu/<model>/chatbot by default. |
| `nomic` | `nomic` | Nomic | API key | [link](https://nomic.ai) | Get API key at atlas.nomic.ai |
| `nous-research` | `nous` | Nous Research | API key | [link](https://portal.nousresearch.com/help) | Use your Nous Portal API key. OmniRoute targets the official OpenAI-compatible inference endpoint at https://inference-api.nousresearch.com/v1. |
| `novita` | `novita` | Novita AI | API key, aggregator | [link](https://novita.ai) | $0.50 trial credits on signup (valid about 1 year) |
| `nscale` | `nscale` | nScale | API key | [link](https://nscale.com) | $5 free credits on signup for inference testing |
| `nube` | `nube` | Nube.sh | API key | [link](https://nube.sh) | — |
| `nvidia` | `nvidia` | NVIDIA NIM | API key | [link](https://build.nvidia.com) | Free dev access: ~40 RPM, 70+ models (Kimi K2.5, GLM 4.7, DeepSeek V3.2...) |
| `oci` | `oci` | OCI Generative AI | API key, enterprise | [link](https://www.oracle.com/artificial-intelligence/generative-ai) | Use your OCI Generative AI API key or IAM bearer token. Base URL can be https://inference.generativeai.<region>.oci.oraclecloud.com/openai/v1/. |
| `ollama-cloud` | `ollamacloud` | Ollama Cloud | API key | [link](https://ollama.com/settings/keys) | — |
| `openai` | `openai` | OpenAI | API key | [link](https://platform.openai.com) | — |
| `opencode-go` | `opencode-go` | OpenCode Go | API key | [link](https://opencode.ai/go) | — |
| `opencode-zen` | `opencode-zen` | OpenCode Zen | API key | [link](https://opencode.ai/zen) | — |
| `openference-api` | `ofa` | Openference API | API key | [link](https://openference.com) | Free tier: includes Qwen3.8 27b and Llama 3.2 3B — see openference.com/pricing for current terms |
| `openrouter` | `openrouter` | OpenRouter | API key, aggregator | [link](https://openrouter.ai) | Free models at $0/token with :free suffix - 20 RPM / 200 RPD |
| `openvecta` | `openvecta` | OpenVecta | API key | [link](https://openvecta.com) | Free credits on signup for OpenAI-compatible inference across LLMs, embeddings, and reasoning models |
| `ovhcloud` | `ovh` | OVHcloud AI | API key | [link](https://www.ovhcloud.com) | — |
| `paraloncloud` | `paralon` | ParalonCloud | API key | [link](https://paraloncloud.com) | — |
| `perplexity` | `pplx` | Perplexity | API key | [link](https://www.perplexity.ai) | — |
| `perplexity-agent` | `pplx-agent` | Perplexity Agent | API key | [link](https://www.perplexity.ai) | Use your Perplexity API key. OmniRoute routes Agent API model IDs through Perplexity's Responses-compatible endpoint. |
| `pioneer` | `pn` | Pioneer AI | API key | [link](https://pioneer.ai) | — |
| `plamo` | `plamo` | PLaMo | API key | [link](https://plamo.preferredai.jp/api) | — |
| `pollinations` | `pol` | Pollinations AI | API key | [link](https://pollinations.ai) | Anonymous/keyless access to the documented free models is best-effort. Local v3.8.50 verification (2026-07-31) returned 401 via OmniRoute and Cloudflare 1010 on direct upstream probes from the same network. Premium models still require a Pollinations API key from enter.pollinations.ai. |
| `poolside` | `poolside` | Poolside | API key | [link](https://poolside.ai) | Preview ending: direct Poolside Platform inference shuts down on 2026-10-31. Laguna S 2.1 and XS 2.1 are free during Preview; no public numeric quota is published. |
| `predibase` | `predibase` | Predibase | API key | [link](https://predibase.com) | ⚠️ **DEPRECATED.** serving.app.predibase.com no longer resolves (sweep 2026-06-19); the managed serving API appears discontinued. |
| `publicai` | `publicai` | PublicAI | API key | [link](https://publicai.co) | Requires an API key — one-time signup credit, then paid |
| `qianfan` | `qianfan` | Baidu Qianfan | API key | [link](https://cloud.baidu.com/product-s/qianfan_home) | — |
| `qwen-cloud` | `qwc` | Qwen Cloud | API key | [link](https://www.qwencloud.com/) | — |
| `qwen-cloud-token-plan` | `qct` | Qwen Cloud Token Plan | API key | [link](https://www.qwencloud.com/pricing/token-plan) | — |
| `reka` | `reka` | Reka | API key | [link](https://docs.reka.ai/chat/overview) | Use your Reka API key. OmniRoute supports the OpenAI-compatible base URL https://api.reka.ai/v1 and sends both Authorization and X-Api-Key headers for compatibility. |
| `replicate` | `replicate` | Replicate | API key | [link](https://replicate.com) | Pay per use; trial runs may be offered on select models (unverified) |
| `runcrate` | `runcrate` | Runcrate | API key | [link](https://www.runcrate.ai) | Open models are free with your GitHub account |
| `sambanova` | `samba` | SambaNova | API key | [link](https://sambanova.ai) | $5 free credits on signup (30-day validity), no credit card required |
| `sap` | `sap` | SAP Generative AI Hub | API key, enterprise | [link](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/generative-ai-hub-in-sap-ai-core) | Use your SAP AI Core bearer token. Base URL can be your AI_API_URL root or a deploymentUrl from Generative AI Hub. |
| `sarvam` | `sarvam` | Sarvam AI | API key | [link](https://docs.sarvam.ai) | ₹1,000 in free signup credits — never expire |
| `scaleway` | `scw` | Scaleway AI | API key | [link](https://www.scaleway.com/en/docs/ai-data/generative-apis/) | 1M free tokens for new accounts — EU/GDPR compliant (Paris), Qwen3 235B & Llama 70B |
| `sealion` | `sealion` | SEA-LION | API key | [link](https://sea-lion.ai) | Sign in at sea-lion.ai with Google (no card, no region wall), create an API key, then paste it here. |
| `sensenova` | `sensenova` | SenseNova | API key | [link](https://platform.sensenova.cn) | Get API key at platform.sensenova.cn |
| `siliconflow` | `siliconflow` | SiliconFlow | API key | [link](https://cloud.siliconflow.com) | $1 free credits plus currently listed $0 models after identity verification; availability and limits may change |
| `snowflake` | `snowflake` | Snowflake Cortex | API key, enterprise | [link](https://www.snowflake.com) | — |
| `sparkdesk` | `sparkdesk` | SparkDesk | API key | [link](https://xinghuo.xfyun.cn) | Get API key at console.xfyun.cn |
| `stepfun` | `stepfun` | StepFun | API key | [link](https://stepfun.com) | Get API key at platform.stepfun.com |
| `tencent` | `tencent` | Tencent Hunyuan | API key | [link](https://hunyuan.tencent.com) | Get API key at console.cloud.tencent.com |
| `tinyfish` | `tf` | TinyFish Fetch | API key | [link](https://docs.tinyfish.ai/fetch-api) | X-API-Key from agent.tinyfish.ai/api-keys |
| `together` | `together` | Together AI | API key | [link](https://www.together.ai) | — |
| `typesafe` | `typesafe` | TypeSafe AI | API key | [link](https://docs.typesafe.ai) | Bearer API key for api.typesafe.ai. OmniRoute uses it for System One evaluation (Jev) — not chat completions. Store the key here; the jev combo strategy reads it at request time. |
| `typhoon` | `typhoon` | Typhoon | API key | [link](https://docs.opentyphoon.ai) | Free API key with a 5 req/s and 200 req/m rate limit. |
| `uc-direct` | `ucd` | UC Direct (uncensored.com) | API key | [link](https://uncensored.com) | Use your uncensored.com Developer API key (uai_sk_live_...). OmniRoute sends it as the X-api-key header to the OpenAI-compatible https://api.uncensored.com/api/v1 endpoint. The key never expires. This is the metered/credits surface; the un-metered subscription chat is the separate 'uc' provider. |
| `upstage` | `upstage` | Upstage | API key | [link](https://www.upstage.ai) | — |
| `v0-vercel` | `v0` | v0 (Vercel) | API key | [link](https://v0.dev) | — |
| `venice` | `venice` | Venice.ai | API key | [link](https://venice.ai) | — |
| `vercel-ai-gateway` | `vag` | Vercel AI Gateway | API key, aggregator | [link](https://vercel.com/docs/ai-gateway) | — |
| `vertex` | `vertex` | Vertex AI | API key, enterprise | [link](https://cloud.google.com/vertex-ai) | Provide Service Account JSON, an OAuth access token, a Vertex Express API key, or a service-account-bound authorization key. Express mode supports Gemini only; partner models require project-scoped credentials. |
| `vertex-partner` | `vp` | Vertex AI Partners | API key, enterprise | [link](https://cloud.google.com/vertex-ai) | Provide Service Account JSON or OAuth credentials. A service-account-bound authorization key also supports discovery, but partner inference additionally requires its Google Cloud project ID. Standard Express keys support Gemini only. |
| `volcengine` | `volcengine` | Volcengine | API key | [link](https://www.volcengine.com) | — |
| `volcengine-agent-plan` | `veap` | Volcengine Ark Agent Plan | API key | [link](https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan) | Connect your Volcano Engine account or use an Ark Agent Plan subscription API key. |
| `volcengine-coding-plan` | `vecp` | Volcengine Ark Coding Plan | API key | [link](https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan) | Connect your Volcano Engine account or use an Ark Coding Plan subscription API key. |
| `voyage-ai` | `voyage` | Voyage AI | API key, embed/rerank | [link](https://www.voyageai.com) | Bearer API key for Voyage AI embeddings and rerank APIs. |
| `wandb` | `wandb` | Weights & Biases Inference | API key | [link](https://wandb.ai) | — |
| `watsonx` | `watsonx` | IBM watsonx.ai Gateway | API key, enterprise | [link](https://www.ibm.com/products/watsonx-ai) | Use your watsonx bearer token. Base URL can be https://<region>.ml.cloud.ibm.com/ml/gateway/v1/ or a self-managed /ml/gateway/v1 endpoint. |
| `writer` | `writer` | Writer | API key | [link](https://dev.writer.com) | — |
| `xai` | `xai` | xAI (Grok) | API key | [link](https://x.ai) | Use an official xAI API key, or sign in with xAI OAuth. Grok Build JWT sessions remain a separate provider. |
| `xiaomi-mimo` | `mimo` | Xiaomi MiMo | API key | [link](https://mimo.mi.com) | — |
| `xiaomi-mimo-token-plan` | `mimotp` | Xiaomi MiMo Token Plan | API key | [link](https://mimo.mi.com) | — |
| `yi` | `yi` | Yi (01.AI) | API key | [link](https://01.ai) | Get API key at platform.lingyiwanwu.com |
| `zai` | `zai` | Z.AI | API key | [link](https://z.ai/model-api) | — |

## Local Providers (13)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `docker-model-runner` | `dmr` | Docker Model Runner | Local, self-hosted | [link](https://docs.docker.com/ai/model-runner/) | API key optional. Configure the local Docker Model Runner OpenAI-compatible base URL (default: http://localhost:12434/v1). |
| `lemonade` | `lemonade` | Lemonade Server | Local, self-hosted | [link](https://lemonade-server.ai) | API key optional. Configure the local Lemonade OpenAI-compatible base URL (default: http://localhost:13305/api/v1). |
| `llama-cpp` | `llamacpp` | llama.cpp | Local, self-hosted | [link](https://github.com/ggml-org/llama.cpp) | API key optional (use any value, e.g. sk-no-key-required). Configure the llama-server OpenAI-compatible base URL (default: http://127.0.0.1:8080/v1). Note: if Llamafile is also installed, both default to port 8080 — run only one at a time or override the port. |
| `llamafile` | `llamafile` | Llamafile | Local, self-hosted | [link](https://github.com/Mozilla-Ocho/llamafile) | API key optional. Configure the local Llamafile OpenAI-compatible base URL (default: http://127.0.0.1:8080/v1). |
| `lm-studio` | `lmstudio` | LM Studio | Local, self-hosted | [link](https://lmstudio.ai) | API key optional. Configure the local LM Studio OpenAI-compatible base URL (default: http://localhost:1234/v1). |
| `mlx-gemma` | `mlx-gemma` | MLX Gemma 26B | Local, self-hosted | [link](https://github.com/ml-explore/mlx) | No API key required. Runs mlx-lm server locally on port 11435. Requires uv and mlx-lm installed. Model: mlx-community/gemma-4-26B-A4B-it-qat-q4_0-mlx-aligned (~15.9GB peak memory). |
| `mlx-qwen` | `mlx-qwen` | MLX Qwen 3.8 27B | Local, self-hosted | [link](https://github.com/ml-explore/mlx) | No API key required. Runs mlx-lm server locally on port 11436. Requires uv and mlx-lm installed. Model: maglun/Qwen3.8-27B-MLX-Mixed-3.80bpw (~13.1GB peak memory). |
| `ollama-local` | `ollama` | Ollama | Local, self-hosted | [link](https://ollama.com) | No API key required. Ollama runs locally — configure its OpenAI-compatible base URL (default: http://localhost:11434/v1) and make sure Ollama is running before connecting. |
| `oobabooga` | `ooba` | oobabooga | Local, self-hosted | [link](https://github.com/oobabooga/text-generation-webui) | API key optional. Configure the local oobabooga OpenAI-compatible base URL (default: http://localhost:5000/v1). |
| `opencode-server` | `ocs` | OpenCode CLI Server | Local, self-hosted | [link](https://opencode.ai/docs/server/) | No API key required. Uses the opencode CLI's own headless server (`opencode serve`), which holds the opencode credential and talks to the opencode upstream. Set the server URL in the provider settings and start the server from Providers > Services > OpenCode (loopback URLs only, binary from OPENCODE_SERVER_BIN or the usual install locations) or run `opencode serve` yourself; requests never start it. |
| `triton` | `triton` | NVIDIA Triton | Local, self-hosted | [link](https://developer.nvidia.com/triton-inference-server) | API key optional. Configure the Triton OpenAI-compatible base URL (default: http://localhost:8000/v1). |
| `vllm` | `vllm` | vLLM | Local, self-hosted | [link](https://github.com/vllm-project/vllm) | API key optional. Configure the local vLLM OpenAI-compatible base URL (default: http://localhost:8000/v1). |
| `xinference` | `xinference` | XInference | Local, self-hosted | [link](https://inference.readthedocs.io) | API key optional. Configure the local XInference OpenAI-compatible base URL (default: http://localhost:9997/v1). |

## Search Providers (21)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `anysearch-search` | `anysearch` | AnySearch | Search | [link](https://anysearch.com) | Optional API key from anysearch.com (as_sk_...) - free 1000/day; keyless tier has lower limits |
| `brave-search` | `brave-search` | Brave Search | Search | [link](https://brave.com/search/api) | Subscription token from Brave Search API dashboard |
| `codex-search` | `codex_search` | Codex Web Search (ChatGPT) | Search | [link](https://chatgpt.com) | Uses your connected OpenAI Codex (ChatGPT) accounts — no separate key. Each search spends Codex subscription quota (~10k input tokens) and takes ~10–40 s. |
| `context7` | `context7` | Context7 (library docs) | Search | [link](https://context7.com) | API key optional (ctx7sk-...) — anonymous tier works without a key; a key raises the rate limit |
| `exa-search` | `exa-search` | Exa Search | Search | [link](https://exa.ai) | API key from dashboard.exa.ai |
| `firecrawl` | `fc` | Firecrawl | Search | [link](https://firecrawl.dev) | API key from firecrawl.dev/app/api-keys (or set your self-hosted Firecrawl base URL) |
| `google-pse-search` | `google-pse` | Google Programmable Search | Search | [link](https://developers.google.com/custom-search/v1/overview) | Requires a Google API key and your Programmable Search Engine ID (cx) |
| `kagi-search` | `kagi-web-search` | Kagi Search | Search | [link](https://kagi.com/api/docs) | Bearer API key from kagi.com/api/keys |
| `kimi-search` | `kimi-search` | Kimi Search | Search | [link](https://platform.kimi.ai/docs/api/tools-search) | Moonshot AI API key (MOONSHOT_API_KEY) from platform.kimi.ai |
| `linkup-search` | `linkup` | Linkup Search | Search | [link](https://docs.linkup.so) | Bearer API key from the Linkup dashboard |
| `nimble-search` | `nimble` | Nimble Search | Search | [link](https://docs.nimbleway.com/nimble-sdk/web-tools/search) | Bearer API key from the Nimble dashboard |
| `ollama-search` | `ollama-search` | Ollama Search | Search | [link](https://ollama.com/settings/keys) | Same API key as Ollama Cloud (from ollama.com/settings/keys) |
| `parallel-search` | `parallel` | Parallel Search | Search | [link](https://parallel.ai) | API key from platform.parallel.ai (sent as x-api-key) |
| `perplexity-search` | `pplx-search` | Perplexity Search | Search | [link](https://docs.perplexity.ai/guides/search-quickstart) | Same API key as Perplexity (pplx-...) |
| `searchapi-search` | `searchapi` | SearchAPI | Search | [link](https://www.searchapi.io/docs/google) | API key from SearchAPI (query param or Bearer auth) |
| `searxng-search` | `searxng` | SearXNG Search | Search | [link](https://docs.searxng.org) | API key is optional. Set your SearXNG base URL. Some instances may require a bearer token for access. |
| `serper-search` | `serper-search` | Serper Search | Search | [link](https://serper.dev) | API key from serper.dev dashboard |
| `tavily-search` | `tavily-search` | Tavily Search | Search | [link](https://tavily.com) | API key from app.tavily.com (format: tvly-...) |
| `x-search` | `x_search` | X Search (Grok) | Search | [link](https://docs.x.ai/developers/tools/x-search) | SuperGrok OAuth (xai-oauth) or xAI API key. This is Grok X Search, not the X Developer MCP. |
| `xquik-search` | `xquik` | Xquik X Search | Search | [link](https://docs.xquik.com) | Xquik API key (xq_...). Search is metered per returned post; the catalog estimate uses 5 results. |
| `youcom-search` | `youcom-search` | You.com Search | Search | [link](https://you.com/business/api/) | X-API-Key from the You.com platform dashboard |

## Upstream Proxy Providers (2)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `9router` | `nr` | 9router | Upstream proxy | [link](https://www.npmjs.com/package/9router) | — |
| `cliproxyapi` | `cpa` | CLIProxyAPI | Upstream proxy | [link](https://github.com/router-for-me/CLIProxyAPI) | — |

## System Providers (1)

| ID | Alias | Name | Tags | Website | Notes |
|----|-------|------|------|---------|-------|
| `auto` | `auto` | Auto (Zero-Config) | System | — | — |

## Sources of truth

- Catalog: [`src/shared/constants/providers.ts`](../../src/shared/constants/providers.ts)
- Registry (per-model details): [`open-sse/config/providerRegistry.ts`](../../open-sse/config/providerRegistry.ts)
- Executors: [`open-sse/executors/`](../../open-sse/executors/) (115 implementations)
- Translators: [`open-sse/translator/`](../../open-sse/translator/)

## See Also

- [FREE_TIERS.md](./FREE_TIERS.md) — curated free-tier guide
- [USER_GUIDE.md](../guides/USER_GUIDE.md) — provider setup walkthrough
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — overall architecture
