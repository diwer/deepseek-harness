import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '../src/index.ts'
import { commandCodeModels, commandCodeProvider } from '../src/commandcode.ts'
import { catalogModels } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'

const protocols = vi.hoisted(() => ({
  anthropic: { stream: vi.fn(), streamSimple: vi.fn() },
  responses: { stream: vi.fn(), streamSimple: vi.fn() },
  chat: { stream: vi.fn(), streamSimple: vi.fn() },
}))
vi.mock('@earendil-works/pi-ai/api/anthropic-messages.lazy', () => ({ anthropicMessagesApi: () => protocols.anthropic }))
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({ openAIResponsesApi: () => protocols.responses }))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({ openAICompletionsApi: () => protocols.chat }))

describe('CommandCode built-in provider', () => {
  it('offers the provider before any user route or credential exists', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {})
      expect(ctx.llm.listProviders()).toEqual([])
      expect(ctx.llm.listConfigurableProviders()).toContainEqual({
        provider: 'commandcode', displayName: 'CommandCode', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'commandcode'], declared: false,
        nativeAuth: { env: ['CMD_API_KEY', 'COMMAND_CODE_API_KEY'], oauth: false },
      })
      const discovered = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'commandcode' })
      expect(discovered.map(model => model.id)).toEqual(commandCodeModels().map(model => model.id))
    } finally { await ctx.fiber.dispose() }
  })

  it('materializes a key-only profile with the complete mixed-protocol catalog', () => {
    const resolved = resolveProfiles({ commandcode: { apiKeyEnv: 'CMD_API_KEY' } }).get('commandcode')!
    expect(resolved.catalogError).toBeUndefined()
    expect(resolved.modelErrors.size).toBe(0)
    const models = resolved.piProvider!.getModels()
    expect(models.length).toBeGreaterThan(80)
    expect(new Set(models.map(model => model.id)).size).toBe(models.length)
    expect(models).toEqual([...catalogModels('commandcode').values()])
    expect(models.find(model => model.id === 'claude-haiku-4-5-20251001')?.compat).toBeUndefined()
    expect(new Set(models.map(model => model.api))).toEqual(new Set(['anthropic-messages', 'openai-responses', 'openai-completions']))
  })

  it.each([
    ['claude-sonnet-4-6', 'anthropic', 'https://api.commandcode.ai/provider'],
    ['gpt-6.1-sol', 'responses', 'https://api.commandcode.ai/provider/v1'],
    ['deepseek/deepseek-v4-flash', 'chat', 'https://api.commandcode.ai/provider/v1'],
  ] as const)('dispatches %s with its protocol-specific URL and compatibility', (id, key, baseUrl) => {
    const provider = commandCodeProvider()
    const model = provider.getModels().find(model => model.id === id)!
    expect(model).toBeDefined()
    expect(model.baseUrl).toBe(baseUrl)
    if (key === 'anthropic') expect(model.compat).toMatchObject({ forceAdaptiveThinking: true })
    if (key === 'chat') expect(model.compat).toMatchObject({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' })
    const context = normalizeContext({ messages: [] })
    provider.streamSimple(model, context)
    provider.stream(model, context)
    expect(protocols[key].streamSimple).toHaveBeenLastCalledWith(model, context, undefined)
    expect(protocols[key].stream).toHaveBeenLastCalledWith(model, context, undefined)
  })
})
