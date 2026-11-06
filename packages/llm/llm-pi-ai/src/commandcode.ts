/** CommandCode catalog and model-specific dispatch through its compatible APIs. */
import { envApiKeyAuth } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { COMMANDCODE_MODELS } from './commandcode-data.generated.ts'

/** Environment variables accepted by CommandCode's official pi integration. */
export const COMMANDCODE_KEY_ENV = ['CMD_API_KEY', 'COMMAND_CODE_API_KEY'] as const

const ROOT = 'https://api.commandcode.ai/provider'
const streams: Readonly<Record<string, ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi(),
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
}

/**
 * Read the bundled CommandCode catalog without network or credential access.
 * @returns Chat models with the endpoint and compatibility their protocol requires.
 */
export function commandCodeModels(): readonly Model<Api>[] {
  return COMMANDCODE_MODELS.flatMap(([id, name, contextWindow, routes]): Model<Api>[] => {
    const endpoints: readonly string[] = routes
    const api = endpoints.includes('/messages') ? 'anthropic-messages'
      : id.startsWith('gpt-') && endpoints.includes('/responses') ? 'openai-responses'
        : endpoints.includes('/chat/completions') ? 'openai-completions'
          : endpoints.includes('/responses') ? 'openai-responses' : undefined
    if (api === undefined) return []
    const vision = /^(claude-|gpt-|google\/)/.test(id)
    return [{
      id, name, api, provider: 'commandcode', contextWindow,
      baseUrl: api === 'anthropic-messages' ? ROOT : `${ROOT}/v1`,
      maxTokens: 32768,
      reasoning: vision,
      input: vision ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...api === 'openai-completions'
        ? { compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } }
        : api === 'anthropic-messages' && /(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5|mythos-5)/.test(id)
          ? { compat: { forceAdaptiveThinking: true } } : {},
    }]
  })
}

/**
 * Construct the built-in CommandCode provider with one shared API-key identity.
 * @returns Provider dispatching each catalog model through its advertised protocol.
 */
export function commandCodeProvider(): Provider {
  const models = commandCodeModels()
  const protocol = (api: Api): ProviderStreams => {
    const stream = streams[api]
    if (stream === undefined) throw new Error(`Unsupported CommandCode protocol: ${api}`)
    return stream
  }
  return {
    id: 'commandcode', name: 'CommandCode',
    auth: { apiKey: envApiKeyAuth('CommandCode API key', COMMANDCODE_KEY_ENV) },
    getModels: () => models,
    stream: (model, context, options) => protocol(model.api).stream(model, context, options),
    streamSimple: (model, context, options) => protocol(model.api).streamSimple(model, context, options),
  }
}
