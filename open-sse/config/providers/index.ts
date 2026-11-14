import type { RegistryEntry } from "./shared.ts";

import { byteplusProvider } from "./registry/byteplus/index.ts";
import { mlxGemmaProvider } from "./registry/mlx/index.ts";
import { mlxQwenProvider } from "./registry/mlx/index.ts";
import { ollama_cloudProvider } from "./registry/ollama-cloud/index.ts";
import { friendliaiProvider } from "./registry/friendliai/index.ts";
import { anthropicProvider } from "./registry/anthropic/index.ts";
import { sambanovaProvider } from "./registry/sambanova/index.ts";
import { deepaiProvider } from "./registry/deepai/index.ts";
import { upstageProvider } from "./registry/upstage/index.ts";
import { nebiusProvider } from "./registry/nebius/index.ts";
import { fireworksProvider } from "./registry/fireworks/index.ts";
import { freebuffProvider } from "./registry/freebuff/index.ts";
import { glmProvider } from "./registry/glm/index.ts";
import { glmtProvider } from "./registry/glm/t/index.ts";
import { glm_cnProvider } from "./registry/glm/cn/index.ts";
import { agnes_cnProvider } from "./registry/agnes/cn/index.ts";
import { traeProvider } from "./registry/trae/index.ts";
import { kilocodeProvider } from "./registry/kilocode/index.ts";
import { workbuddyProvider } from "./registry/workbuddy/index.ts";
import { githubProvider } from "./registry/github/index.ts";
import { gheCopilotProvider } from "./registry/ghe-copilot/index.ts";
import { difyProvider } from "./registry/dify/index.ts";
import { ovhcloudProvider } from "./registry/ovhcloud/index.ts";
import { claudeProvider } from "./registry/claude/index.ts";
import { cloudflarePlaygroundProvider } from "./registry/cloudflare-playground/index.ts";
import { bedrockProvider } from "./registry/bedrock/index.ts";
import { qoderProvider } from "./registry/qoder/index.ts";
import { xiaomi_mimoProvider } from "./registry/xiaomi-mimo/index.ts";
import { xiaomi_mimo_token_planProvider } from "./registry/xiaomi-mimo-token-plan/index.ts";
import { codestralProvider } from "./registry/codestral/index.ts";
import { wandbProvider } from "./registry/wandb/index.ts";
import { predibaseProvider } from "./registry/predibase/index.ts";
import { baichuanProvider } from "./registry/baichuan/index.ts";
import { yiProvider } from "./registry/yi/index.ts";
import { deepseekProvider } from "./registry/deepseek/index.ts";
import { kimi_coding_apikeyProvider } from "./registry/kimi/coding-apikey/index.ts";
import { kimi_codingProvider } from "./registry/kimi/coding/index.ts";
import { kimiProvider } from "./registry/kimi/index.ts";
import { groqProvider } from "./registry/groq/index.ts";
import { inference_netProvider } from "./registry/inference-net/index.ts";
import { hetznerProvider } from "./registry/hetzner/index.ts";
import { grokifiedProvider } from "./registry/grokified/index.ts";
import { replicateProvider } from "./registry/replicate/index.ts";
import { cerebriumProvider } from "./registry/cerebrium/index.ts";
import { cerebrasProvider } from "./registry/cerebras/index.ts";
import { nubeProvider } from "./registry/nube/index.ts";
import { clinepassProvider } from "./registry/clinepass/index.ts";
import { sparkdeskProvider } from "./registry/sparkdesk/index.ts";
import { nlpcloudProvider } from "./registry/nlpcloud/index.ts";
import { nvidiaProvider } from "./registry/nvidia/index.ts";
import { mistralProvider } from "./registry/mistral/index.ts";
import { togetherProvider } from "./registry/together/index.ts";
import { cohereProvider } from "./registry/cohere/index.ts";
import { cursorProvider, cursor_apiProvider } from "./registry/cursor/index.ts";
import { volcengineProvider } from "./registry/volcengine/index.ts";
import { volcengine_agent_planProvider } from "./registry/volcengine/agent-plan/index.ts";
import { volcengine_coding_planProvider } from "./registry/volcengine/coding-plan/index.ts";
import { tencentProvider } from "./registry/tencent/index.ts";
import { cozeProvider } from "./registry/coze/index.ts";
import { ai21Provider } from "./registry/ai21/index.ts";
import { publicaiProvider } from "./registry/publicai/index.ts";
import { featherless_aiProvider } from "./registry/featherless-ai/index.ts";
import { antigravityProvider } from "./registry/antigravity/index.ts";
import { openaiProvider } from "./registry/openai/index.ts";
import { snowflakeProvider } from "./registry/snowflake/index.ts";
import { huggingfaceProvider } from "./registry/huggingface/index.ts";
import { qwen_cloudProvider } from "./registry/qwen-cloud/index.ts";
import { qwen_cloud_token_planProvider } from "./registry/qwen-cloud-token-plan/index.ts";
import { modalProvider } from "./registry/modal/index.ts";
import { kieProvider } from "./registry/kie/index.ts";
import { monsterapiProvider } from "./registry/monsterapi/index.ts";
import { modelscopeProvider } from "./registry/modelscope/index.ts";
import { sensenovaProvider } from "./registry/sensenova/index.ts";
import { hyperbolicProvider } from "./registry/hyperbolic/index.ts";
import { lambda_aiProvider } from "./registry/lambda-ai/index.ts";
import { runcrateProvider } from "./registry/runcrate/index.ts";
import { iflytekProvider } from "./registry/iflytek/index.ts";
import { moonshotProvider } from "./registry/moonshot/index.ts";
import { perplexityProvider } from "./registry/perplexity/index.ts";
import { perplexityAgentProvider } from "./registry/perplexity/agent/index.ts";
import { minimaxProvider } from "./registry/minimax/index.ts";
import { minimax_cnProvider } from "./registry/minimax/cn/index.ts";
import { bytezProvider } from "./registry/bytez/index.ts";
import { blackboxProvider } from "./registry/blackbox/index.ts";
import { uncloseaiProvider } from "./registry/uncloseai/index.ts";
import { nscaleProvider } from "./registry/nscale/index.ts";
import { openrouterProvider } from "./registry/openrouter/index.ts";
import { openvectaProvider } from "./registry/openvecta/index.ts";
import { openferenceProvider } from "./registry/openference/index.ts";
import { openference_apiProvider } from "./registry/openference-api/index.ts";
import { stepfunProvider } from "./registry/stepfun/index.ts";
import { liquidProvider } from "./registry/liquid/index.ts";
import { arceeAiProvider } from "./registry/arcee-ai/index.ts";
import { deepinfraProvider } from "./registry/deepinfra/index.ts";
import { agyProvider } from "./registry/agy/index.ts";
import { agnesProvider } from "./registry/agnes/index.ts";
import { aihordeProvider } from "./registry/aihorde/index.ts";
import { longcatProvider } from "./registry/longcat/index.ts";
import { vertex_partnerProvider } from "./registry/vertex/partner/index.ts";
import { vertexProvider } from "./registry/vertex/index.ts";
import { duckduckgo_webProvider } from "./registry/duckduckgo-web/index.ts";
import { xaiProvider, xai_oauthProvider } from "./registry/xai/index.ts";
import { morphProvider } from "./registry/morph/index.ts";
import { siliconflowProvider } from "./registry/siliconflow/index.ts";
import { gitlab_duoProvider } from "./registry/gitlab-duo/index.ts";
import { novitaProvider } from "./registry/novita/index.ts";
import { devin_desktopProvider } from "./registry/devin-desktop/index.ts";
import { zcodeProvider } from "./registry/zcode/index.ts";
import { minimaxCodeProvider } from "./registry/minimax-code/index.ts";
import { zed_hostedProvider } from "./registry/zed-hosted/index.ts";
import { nanogptProvider } from "./registry/nanogpt/index.ts";
import { apmixProvider } from "./registry/apmix/index.ts";
import { scalewayProvider } from "./registry/scaleway/index.ts";
import { zaiProvider } from "./registry/zai/index.ts";
import { bigmodelProvider } from "./registry/bigmodel/index.ts";
import { galadrielProvider } from "./registry/galadriel/index.ts";
import { qianfanProvider } from "./registry/qianfan/index.ts";
import { meta_llamaProvider } from "./registry/meta-llama/index.ts";
import { cloudflare_aiProvider } from "./registry/cloudflare-ai/index.ts";
import { nous_researchProvider } from "./registry/nous-research/index.ts";
import { alibabaProvider } from "./registry/alibaba/index.ts";
import { alibaba_cnProvider } from "./registry/alibaba/cn/index.ts";
import { doubaoProvider } from "./registry/doubao/index.ts";
import { bailian_coding_planProvider } from "./registry/bailian-coding-plan/index.ts";
import { gigachatProvider } from "./registry/gigachat/index.ts";
import { devin_cliProvider } from "./registry/devin-cli/index.ts";
import { devin_cli_agenticProvider } from "./registry/devin-cli-agentic/index.ts";
import { auggieProvider } from "./registry/auggie/index.ts";
import { chutesProvider } from "./registry/chutes/index.ts";
import { databricksProvider } from "./registry/databricks/index.ts";
import { rekaProvider } from "./registry/reka/index.ts";
import { typhoonProvider } from "./registry/typhoon/index.ts";
import { inceptionProvider } from "./registry/inception/index.ts";
import { sarvamProvider } from "./registry/sarvam/index.ts";
import { writerProvider } from "./registry/writer/index.ts";
import { plamoProvider } from "./registry/plamo/index.ts";
import { clova_studioProvider } from "./registry/clova-studio/index.ts";
import { internlmProvider } from "./registry/internlm/index.ts";
import { ant_lingProvider } from "./registry/ant-ling/index.ts";
import { vercel_ai_gatewayProvider } from "./registry/vercel-ai-gateway/index.ts";
import { v0_vercelProvider } from "./registry/v0-vercel/index.ts";
import { opencode_zenProvider } from "./registry/opencode/zen/index.ts";
import { opencode_goProvider } from "./registry/opencode/go/index.ts";
import { opencode_serverProvider } from "./registry/opencode-server/index.ts";
import { maritalkProvider } from "./registry/maritalk/index.ts";
import { basetenProvider } from "./registry/baseten/index.ts";
import { geminiProvider } from "./registry/gemini/index.ts";
import { clineProvider } from "./registry/cline/index.ts";
import { herokuProvider } from "./registry/heroku/index.ts";
import { baiduProvider } from "./registry/baidu/index.ts";
import { pollinationsProvider } from "./registry/pollinations/index.ts";
import { codexProvider } from "./registry/codex/index.ts";
import { chatgptProvider } from "./registry/chatgpt/index.ts";
import { codexAppServerProvider } from "./registry/codex-app-server/index.ts";
import { ucDirectProvider } from "./registry/uc-direct/index.ts";
import { veniceProvider } from "./registry/venice/index.ts";
import { kiroProvider } from "./registry/kiro/index.ts";
import { grok_cliProvider } from "./registry/grok-cli/index.ts";
import { codebuddy_cnProvider } from "./registry/codebuddy-cn/index.ts";
import { codebuddy_intlProvider } from "./registry/codebuddy-intl/index.ts";
import { pioneerProvider } from "./registry/pioneer/index.ts";
import { sealionProvider } from "./registry/sealion/index.ts";
import { digitaloceanProvider } from "./registry/digitalocean/index.ts";
import { hcnsecProvider } from "./registry/hcnsec/index.ts";
import { muse_codeProvider } from "./registry/muse-code/index.ts";
import { poolsideProvider } from "./registry/poolside/index.ts";
import { megabrainProvider } from "./registry/megabrain/index.ts";
import { paraloncloudProvider } from "./registry/paraloncloud/index.ts";

export const REGISTRY: Record<string, RegistryEntry> = {
  "mlx-gemma": mlxGemmaProvider,
  "mlx-qwen": mlxQwenProvider,
  "ollama-cloud": ollama_cloudProvider,
  friendliai: friendliaiProvider,
  anthropic: anthropicProvider,
  sambanova: sambanovaProvider,
  upstage: upstageProvider,
  deepai: deepaiProvider,
  nebius: nebiusProvider,
  fireworks: fireworksProvider,
  freebuff: freebuffProvider,
  glm: glmProvider,
  glmt: glmtProvider,
  "glm-cn": glm_cnProvider,
  trae: traeProvider,
  kilocode: kilocodeProvider,
  workbuddy: workbuddyProvider,
  github: githubProvider,
  "ghe-copilot": gheCopilotProvider,
  dify: difyProvider,
  ovhcloud: ovhcloudProvider,
  claude: claudeProvider,
  "cloudflare-playground": cloudflarePlaygroundProvider,
  bedrock: bedrockProvider,
  qoder: qoderProvider,
  "xiaomi-mimo": xiaomi_mimoProvider,
  "xiaomi-mimo-token-plan": xiaomi_mimo_token_planProvider,
  codestral: codestralProvider,
  wandb: wandbProvider,
  predibase: predibaseProvider,
  baichuan: baichuanProvider,
  yi: yiProvider,
  deepseek: deepseekProvider,
  "kimi-coding-apikey": kimi_coding_apikeyProvider,
  "kimi-coding": kimi_codingProvider,
  kimi: kimiProvider,
  groq: groqProvider,
  "inference-net": inference_netProvider,
  hetzner: hetznerProvider,
  grokified: grokifiedProvider,
  replicate: replicateProvider,
  cerebrium: cerebriumProvider,
  cerebras: cerebrasProvider,
  nube: nubeProvider,
  clinepass: clinepassProvider,
  sparkdesk: sparkdeskProvider,
  nlpcloud: nlpcloudProvider,
  nvidia: nvidiaProvider,
  mistral: mistralProvider,
  together: togetherProvider,
  cohere: cohereProvider,
  cursor: cursorProvider,
  "cursor-api": cursor_apiProvider,
  volcengine: volcengineProvider,
  "volcengine-agent-plan": volcengine_agent_planProvider,
  "volcengine-coding-plan": volcengine_coding_planProvider,
  tencent: tencentProvider,
  coze: cozeProvider,
  ai21: ai21Provider,
  publicai: publicaiProvider,
  "featherless-ai": featherless_aiProvider,
  antigravity: antigravityProvider,
  openai: openaiProvider,
  snowflake: snowflakeProvider,
  huggingface: huggingfaceProvider,
  "qwen-cloud": qwen_cloudProvider,
  "qwen-cloud-token-plan": qwen_cloud_token_planProvider,
  modal: modalProvider,
  kie: kieProvider,
  monsterapi: monsterapiProvider,
  modelscope: modelscopeProvider,
  sensenova: sensenovaProvider,
  hyperbolic: hyperbolicProvider,
  "lambda-ai": lambda_aiProvider,
  runcrate: runcrateProvider,
  iflytek: iflytekProvider,
  moonshot: moonshotProvider,
  perplexity: perplexityProvider,
  "perplexity-agent": perplexityAgentProvider,
  minimax: minimaxProvider,
  "minimax-cn": minimax_cnProvider,
  bytez: bytezProvider,
  blackbox: blackboxProvider,
  uncloseai: uncloseaiProvider,
  nscale: nscaleProvider,
  openrouter: openrouterProvider,
  openvecta: openvectaProvider,
  openference: openferenceProvider,
  "openference-api": openference_apiProvider,
  stepfun: stepfunProvider,
  liquid: liquidProvider,
  "arcee-ai": arceeAiProvider,
  deepinfra: deepinfraProvider,
  agy: agyProvider,
  agnes: agnesProvider,
  "agnes-cn": agnes_cnProvider,
  aihorde: aihordeProvider,
  longcat: longcatProvider,
  "vertex-partner": vertex_partnerProvider,
  vertex: vertexProvider,
  "duckduckgo-web": duckduckgo_webProvider,
  xai: xaiProvider,
  "xai-oauth": xai_oauthProvider,
  morph: morphProvider,
  siliconflow: siliconflowProvider,
  "gitlab-duo": gitlab_duoProvider,
  novita: novitaProvider,
  "devin-desktop": devin_desktopProvider,
  zcode: zcodeProvider,
  "minimax-code": minimaxCodeProvider,
  "zed-hosted": zed_hostedProvider,
  nanogpt: nanogptProvider,
  apmix: apmixProvider,
  scaleway: scalewayProvider,
  zai: zaiProvider,
  bigmodel: bigmodelProvider,
  galadriel: galadrielProvider,
  qianfan: qianfanProvider,
  "meta-llama": meta_llamaProvider,
  "cloudflare-ai": cloudflare_aiProvider,
  "nous-research": nous_researchProvider,
  alibaba: alibabaProvider,
  "alibaba-cn": alibaba_cnProvider,
  doubao: doubaoProvider,
  "bailian-coding-plan": bailian_coding_planProvider,
  gigachat: gigachatProvider,
  "devin-cli": devin_cliProvider,
  "devin-cli-agentic": devin_cli_agenticProvider,
  auggie: auggieProvider,
  chutes: chutesProvider,
  databricks: databricksProvider,
  reka: rekaProvider,
  typhoon: typhoonProvider,
  inception: inceptionProvider,
  sarvam: sarvamProvider,
  writer: writerProvider,
  plamo: plamoProvider,
  "clova-studio": clova_studioProvider,
  internlm: internlmProvider,
  "ant-ling": ant_lingProvider,
  "vercel-ai-gateway": vercel_ai_gatewayProvider,
  "v0-vercel": v0_vercelProvider,
  "opencode-zen": opencode_zenProvider,
  "opencode-go": opencode_goProvider,
  "opencode-server": opencode_serverProvider,
  maritalk: maritalkProvider,
  baseten: basetenProvider,
  gemini: geminiProvider,
  cline: clineProvider,
  heroku: herokuProvider,
  baidu: baiduProvider,
  pollinations: pollinationsProvider,
  codex: codexProvider,
  chatgpt: chatgptProvider,
  "codex-app-server": codexAppServerProvider,
  "uc-direct": ucDirectProvider,
  venice: veniceProvider,
  kiro: kiroProvider,
  byteplus: byteplusProvider,
  "grok-cli": grok_cliProvider,
  "codebuddy-cn": codebuddy_cnProvider,
  "codebuddy-intl": codebuddy_intlProvider,
  pioneer: pioneerProvider,
  sealion: sealionProvider,
  digitalocean: digitaloceanProvider,
  hcnsec: hcnsecProvider,
  "muse-code": muse_codeProvider,
  poolside: poolsideProvider,
  paraloncloud: paraloncloudProvider,
  // Last, so its bare upstream ids (anthropic/…, z-ai/…) never shadow another
  // provider's; address them as megabrain/<model>.
  megabrain: megabrainProvider,
};
