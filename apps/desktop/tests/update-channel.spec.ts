import { expect, it } from 'vitest'
import { desktopOfficialUpdateTracking, desktopUpdateChannel } from '../src/update-channel.ts'

it('uses the sealed upstream version and official feed for each custom-build target', () => {
  expect(desktopOfficialUpdateTracking({ version: '0.2.1-rc.2-alpha-1', dshDesktopUpstreamVersion: '0.2.1-rc.2' }, 'darwin', 'arm64'))
    .toMatchObject({ upstreamVersion: '0.2.1-rc.2' })
  expect(desktopOfficialUpdateTracking({}, 'darwin', 'arm64')).toBeUndefined()
  for (const [platform, arch, target] of [['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64'], ['win32', 'x64', 'win-x64']] as const) {
    expect(desktopOfficialUpdateTracking({ dshDesktopUpstreamVersion: '0.2.1-alpha.4' }, platform, arch)).toEqual({
      upstreamVersion: '0.2.1-alpha.4', feedUrl: `https://download.deepseek.com/dsh-desk/feeds/${target}/`,
    })
  }
  for (const value of [null, 5, '', 'latest']) {
    expect(() => desktopOfficialUpdateTracking({ dshDesktopUpstreamVersion: value }, 'darwin', 'arm64')).toThrow(/upstream version/u)
  }
  expect(() => desktopOfficialUpdateTracking(null, 'darwin', 'arm64')).toThrow(/manifest/u)
  expect(() => desktopOfficialUpdateTracking({ dshDesktopUpstreamVersion: '1.0.0' }, 'linux', 'arm64')).toThrow(/target/u)
})

it('reads the installed channel independently from the current version', () => {
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'nightly' })).toBe('nightly')
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'latest' })).toBe('latest')
  expect(desktopUpdateChannel({ version: '1.0.0' })).toBe('nightly')
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'beta' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel(null)).toThrow(/manifest/u)
})
