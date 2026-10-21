import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('records manual-update guidance for builds without an update source', async () => {
    await expect(JSON.stringify({ en: en.updateUnavailable, zh: zh.updateUnavailable }, null, 2) + '\n')
      .toMatchFileSnapshot('./expected/update-unavailable.json')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('records custom-build adaptation guidance and both version identities', async () => {
    const copy = [en, zh].map(messages => ({ message: messages.updateCustomBuild,
      detail: formatDesktopMessage(messages.updateOfficialVersions, { installed: '0.2.1-alpha.4.20261021.2', upstream: '0.2.1-alpha.4', official: '0.2.1-rc.2' }),
      newer: messages.updateOfficialNewer, current: messages.updateOfficialCurrent }))
    await expect(JSON.stringify(copy, null, 2) + '\n').toMatchFileSnapshot('./expected/custom-official-update.json')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('zh-CN')
  })

})
