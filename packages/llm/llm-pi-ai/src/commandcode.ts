/** Command Code's bundled Provider API catalog, from its public /provider/v1/models endpoint. */

import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { DEFAULT_MAX_TOKENS } from './model-defaults.ts'

/** Public endpoint and native credential reference for Command Code. */
export const COMMAND_CODE_DEFAULTS = {
  defaultBaseURL: 'https://api.commandcode.ai/provider/v1',
  env: ['CMD_API_KEY'],
}

/** Model id, display name, context capacity and supported protocol, bundled for offline discovery. */
const CATALOG: readonly (readonly [string, string, number, 'anthropic-messages' | 'openai-completions'])[] = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 'anthropic-messages'],
  ['claude-sonnet-5', 'Claude Sonnet 5', 1000000, 'anthropic-messages'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, 'anthropic-messages'],
  ['claude-fable-5-1', 'Claude Fable 5.1', 1000000, 'anthropic-messages'],
  ['claude-fable-5', 'Claude Fable 5', 1000000, 'anthropic-messages'],
  ['claude-opus-5-5', 'Claude Opus 5.5', 1000000, 'anthropic-messages'],
  ['claude-opus-5', 'Claude Opus 5', 1000000, 'anthropic-messages'],
  ['claude-opus-4-8', 'Claude Opus 4.8', 1000000, 'anthropic-messages'],
  ['claude-opus-4-7', 'Claude Opus 4.7', 1000000, 'anthropic-messages'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', 1000000, 'anthropic-messages'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 'anthropic-messages'],
  ['gpt-6-astra', 'GPT-6 Astra', 1050000, 'openai-completions'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol', 1050000, 'openai-completions'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra', 1050000, 'openai-completions'],
  ['gpt-6-sol', 'GPT-6 Sol', 1050000, 'openai-completions'],
  ['gpt-6-luna', 'GPT-6 Luna', 1050000, 'openai-completions'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 1050000, 'openai-completions'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 1050000, 'openai-completions'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 1050000, 'openai-completions'],
  ['gpt-5.5', 'GPT-5.5', 400000, 'openai-completions'],
  ['gpt-5.4', 'GPT-5.4', 400000, 'openai-completions'],
  ['gpt-5.3-codex', 'GPT-5.3 Codex', 400000, 'openai-completions'],
  ['gpt-5.4-mini', 'GPT-5.4 Mini', 400000, 'openai-completions'],
  ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro (latest)', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (latest)', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (exp)', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4-flash-fast', 'DeepSeek V4 Flash Fast', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (latest)', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4.1-flash-fast', 'DeepSeek V4.1 Flash Fast (latest)', 1000000, 'openai-completions'],
  ['deepseek/deepseek-v4.1-flash-ultrafast', 'DeepSeek V4.1 Flash Ultrafast', 1048576, 'openai-completions'],
  ['moonshotai/Kimi-K3.1-Pro', 'Kimi K3.1 Pro', 1048576, 'openai-completions'],
  ['moonshotai/Kimi-K3', 'Kimi K3', 1000000, 'openai-completions'],
  ['moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', 256000, 'openai-completions'],
  ['moonshotai/Kimi-K2.7-Code-Highspeed', 'Kimi K2.7 Code HighSpeed', 262000, 'openai-completions'],
  ['moonshotai/Kimi-K2.6', 'Kimi K2.6', 256000, 'openai-completions'],
  ['moonshotai/Kimi-K2.5', 'Kimi K2.5', 256000, 'openai-completions'],
  ['z-ai/glm-5.3-flash', 'GLM-5.3 Flash', 1048576, 'openai-completions'],
  ['z-ai/glm-5.3-flashx', 'GLM-5.3 FlashX', 1000000, 'openai-completions'],
  ['zai-org/GLM-5.3', 'GLM-5.3', 1000000, 'openai-completions'],
  ['zai-org/GLM-5.2', 'GLM-5.2', 1000000, 'openai-completions'],
  ['zai-org/GLM-5.2-Fast', 'GLM-5.2 Fast', 1000000, 'openai-completions'],
  ['zai-org/GLM-5.1', 'GLM-5.1', 200000, 'openai-completions'],
  ['zai-org/GLM-5', 'GLM-5', 200000, 'openai-completions'],
  ['minimax/minimax-m3.1-flash', 'MiniMax M3.1 Flash', 1000000, 'openai-completions'],
  ['MiniMaxAI/MiniMax-M3', 'MiniMax M3', 1000000, 'openai-completions'],
  ['MiniMaxAI/MiniMax-M2.7', 'MiniMax M2.7', 200000, 'openai-completions'],
  ['MiniMaxAI/MiniMax-M2.5', 'MiniMax M2.5', 200000, 'openai-completions'],
  ['ornith/ornith-1.5-122b', 'Ornith 1.5 122B', 262144, 'openai-completions'],
  ['xiaomi/mimo-v2.6-pro', 'MiMo V2.6 Pro', 1048576, 'openai-completions'],
  ['xiaomi/mimo-v2.6-pro-ultraspeed', 'MiMo V2.6 Pro UltraSpeed', 1048576, 'openai-completions'],
  ['xiaomi/mimo-v2.6-flash', 'MiMo V2.6 Flash', 1048576, 'openai-completions'],
  ['Qwen/Qwen3.8-Omni-Flash', 'Qwen 3.8 Omni Flash', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.8-Max-Prime', 'Qwen 3.8 Max Prime', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.8-Max-0902', 'Qwen 3.8 Max 0902', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.8-Max', 'Qwen 3.8 Max', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.8-27B', 'Qwen 3.8 27B', 262144, 'openai-completions'],
  ['Qwen/Qwen3.8-Flash', 'Qwen 3.8 Flash', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.7-Max', 'Qwen 3.7 Max', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.7-Plus', 'Qwen 3.7 Plus', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.7-Flash', 'Qwen 3.7 Flash', 1000000, 'openai-completions'],
  ['Qwen/Qwen3.6-Max-Preview', 'Qwen 3.6 Max Preview', 200000, 'openai-completions'],
  ['Qwen/Qwen3.6-Plus', 'Qwen 3.6 Plus', 200000, 'openai-completions'],
  ['meituan/LongCat-2.0', 'LongCat 2.0', 1048576, 'openai-completions'],
  ['stepfun/Step-5-Preview', 'Step 5 Preview', 1000000, 'openai-completions'],
  ['stepfun/Step-3.7-Flash', 'Step 3.7 Flash', 256000, 'openai-completions'],
  ['stepfun/Step-3.5-Flash', 'Step 3.5 Flash', 262144, 'openai-completions'],
  ['tencent/hy3-paid', 'Tencent Hy3', 262144, 'openai-completions'],
  ['tencent/hy4-preview', 'Tencent Hy4 Preview', 1048576, 'openai-completions'],
  ['google/gemini-4-argon', 'Gemini 4 Argon', 1000000, 'openai-completions'],
  ['google/gemini-3.8-flash', 'Gemini 3.8 Flash', 1000000, 'openai-completions'],
  ['google/gemini-3.7-flash', 'Gemini 3.7 Flash', 1048576, 'openai-completions'],
  ['google/gemini-3.6-flash', 'Gemini 3.6 Flash', 1000000, 'openai-completions'],
  ['google/gemini-3.5-flash', 'Gemini 3.5 Flash', 1000000, 'openai-completions'],
  ['google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 1000000, 'openai-completions'],
  ['google/gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', 1000000, 'openai-completions'],
  ['sakana/fugu-ultra', 'Fugu Ultra', 1000000, 'openai-completions'],
  ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 1000000, 'openai-completions'],
  ['nvidia/nemotron-3.5-super-vl', 'Nemotron 3.5 Super VL', 262144, 'openai-completions'],
  ['thinkingmachines/inkling', 'Inkling', 256000, 'openai-completions'],
  ['thinkingmachines/inkling-small', 'Inkling Small', 1000000, 'openai-completions'],
  ['stealth/glyph-cluster:free', 'Glyph Cluster', 256000, 'openai-completions'],
  ['stealth/crouton-alpha', 'Crouton Alpha', 1048576, 'openai-completions'],
  ['reflection/beam:free', 'Beam 1.0', 1048576, 'openai-completions'],
  ['inclusionai/ling-3.1-flash', 'Ling 3.1 Flash', 262144, 'openai-completions'],
  ['inclusionai/ling-3.1-flash-1019', 'Ling 3.1 Flash 1019', 1000000, 'openai-completions'],
  ['meta/muse-spark-1.1', 'Muse Spark 1.1', 1048576, 'openai-completions'],
  ['meta/muse-spark-1.2', 'Muse Spark 1.2', 1048576, 'openai-completions'],
  ['meta/muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 1048576, 'openai-completions'],
  ['meta/muse-spark-1.3', 'Muse Spark 1.3', 1048576, 'openai-completions'],
  ['meta/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 1048576, 'openai-completions'],
  ['meta/muse-spark-open', 'Muse Spark Open', 1048576, 'openai-completions'],
  ['meta/muse-wonder-1.0', 'Muse Wonder', 1048576, 'openai-completions'],
  ['xai/grok-4.5', 'Grok 4.5', 500000, 'openai-completions'],
  ['xai/grok-4.6', 'Grok 4.6', 500000, 'openai-completions'],
  ['xai/grok-4.7', 'Grok 4.7', 500000, 'openai-completions'],
  ['mistral/mistral-large-4', 'Mistral Large 4', 524288, 'openai-completions'],
]

/**
 * Build the Command Code provider without network access or credential reads.
 * Claude uses Messages; the other bundled models use Chat Completions.
 * The public listing omits output caps and modalities, so models use the
 * adapter's output-cap fallback and declare text input only; model overrides
 * can specify additional capabilities verified for the selected model.
 * @returns A provider with request-owned authentication and protocol dispatch.
 */
export function commandCodeProvider(): Provider {
  const completions = openAICompletionsApi()
  const messages = anthropicMessagesApi()
  const models: Model<Api>[] = CATALOG.map(([id, name, contextWindow, api]) => ({
    id, name, contextWindow, api,
    provider: 'commandcode',
    baseUrl: COMMAND_CODE_DEFAULTS.defaultBaseURL,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }))
  return {
    id: 'commandcode',
    name: 'Command Code',
    baseUrl: COMMAND_CODE_DEFAULTS.defaultBaseURL,
    auth: { apiKey: {
      name: 'Command Code API key',
      resolve: async ({ ctx, credential }) => {
        const apiKey = credential?.key ?? await ctx.env('CMD_API_KEY')
        return apiKey === undefined ? undefined : { auth: { apiKey }, source: 'CMD_API_KEY' }
      },
    } },
    getModels: () => models,
    stream: (model, context, options) => (model.api === 'anthropic-messages' ? messages : completions).stream(model, context, options),
    streamSimple: (model, context, options) => (model.api === 'anthropic-messages' ? messages : completions).streamSimple(model, context, options),
  }
}
