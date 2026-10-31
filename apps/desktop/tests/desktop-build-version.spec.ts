import { describe, expect, it } from 'vitest'
import { customDesktopUpstreamVersion } from '../custom-version.mjs'
import {
  DESKTOP_BUILD_VERSION_ENV,
  desktopBuildVersionPrefix,
  resolveDesktopBuildVersion,
  validateDesktopBuildVersion,
} from '../scripts/desktop-build-version.mjs'

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'

describe('desktop build version', () => {
  it('maps ming RC builds to the corresponding official release', () => {
    const version = '0.2.1-rc5-ming-1'
    expect(customDesktopUpstreamVersion(version)).toBe('0.2.1-rc.5')
    expect(resolveDesktopBuildVersion({ DSH_DESKTOP_UNSIGNED: '1', [DESKTOP_BUILD_VERSION_ENV]: version }, '0.2.1-rc.5')).toBe(version)
    expect(() => resolveDesktopBuildVersion({ DSH_DESKTOP_UNSIGNED: '1', [DESKTOP_BUILD_VERSION_ENV]: version }, '0.2.1-rc.4')).toThrow(/must match product version/u)
    expect(() => resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: version }, '0.2.1-rc.5')).toThrow()
  })

  it.each(['0.2.1-rc05-ming-1', '0.2.1-rc5-ming-0', '0.2.1-rc5-ming-01', '0.2.1-rc5-ming-1+build'])(
    'rejects malformed ming versions: %s', (version) => {
      expect(customDesktopUpstreamVersion(version)).toBeUndefined()
    })
  it.each(['0.2.1-rc.2', '0.2.1-alpha.4', '0.2.1', '0.3.0-beta.1'])(
    'names extension revisions independently from official %s', (official) => {
      for (const revision of [1, 2, 100]) {
        const version = `${official}-alpha-${revision}`
        expect(customDesktopUpstreamVersion(version)).toBe(official)
        expect(resolveDesktopBuildVersion({ DSH_DESKTOP_UNSIGNED: '1', [DESKTOP_BUILD_VERSION_ENV]: version }, PRERELEASE)).toBe(version)
        expect(() => resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: version }, PRERELEASE)).toThrow()
      }
    })

  it.each(['0.2.1-rc.2', '0.2.1-rc.2-alpha-0', '0.2.1-rc.2-alpha-01', '0.2.1-rc.2-alpha-x',
    'not-semver-alpha-1', '0.2.1-rc.2-alpha-1+build'])(
    'does not interpret %s as an extension revision', (version) => {
      expect(customDesktopUpstreamVersion(version)).toBeUndefined()
    })

  it('publishes the product version when no build version is present', () => {
    expect(resolveDesktopBuildVersion({}, PRERELEASE)).toBe(PRERELEASE)
    expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: '   ' }, PRERELEASE)).toBe(PRERELEASE)
  })

  it.each(['0.1.6-alpha.2.20260921.1', '0.1.6-alpha.2.20260921.12'])(
    'accepts %s, which outranks the prerelease base it extends', (buildVersion) => {
      expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: buildVersion }, PRERELEASE)).toBe(buildVersion)
      expect(validateDesktopBuildVersion(buildVersion, PRERELEASE)).toBe(buildVersion)
    })

  it('accepts the documented test form on a stable base', () => {
    // 0.1.6-test.x ranks below 0.1.6, which is why this form only ever reaches a test feed.
    expect(validateDesktopBuildVersion('0.1.6-test.20260921.1', STABLE)).toBe('0.1.6-test.20260921.1')
  })

  it.each([PRERELEASE, STABLE])('accepts %s, the product version itself', (productVersion) => {
    expect(validateDesktopBuildVersion(productVersion, productVersion)).toBe(productVersion)
  })

  it.each(['', 'nightly', '0.1.6-alpha.2.'])(
    'rejects %j as a version', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/is not a version/u)
    })

  it('normalizes what the artifacts carry, so validation and publication agree', () => {
    expect(validateDesktopBuildVersion('v0.1.6-alpha.2.1', PRERELEASE)).toBe('0.1.6-alpha.2.1')
  })

  it('rejects build metadata, which does not affect updater precedence', () => {
    expect(() => validateDesktopBuildVersion('0.1.6-alpha.2.1+build', PRERELEASE)).toThrow(/build metadata/u)
  })

  it.each(['0.1.7-alpha.2.20260921.1', '0.2.6-alpha.2.20260921.1'])(
    'rejects %s because it leaves the product release numbers', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/must extend product version/u)
    })

  it.each(['0.1.6-beta.2.20260921.1', '0.1.6-alpha.3', '0.1.6'])(
    'rejects %s because it does not extend the product prerelease', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/must extend 0\.1\.6-alpha\.2 as/u)
    })

  it.each(['0.1.6-20260921.1', '0.1.6-nightly.20260921.1'])(
    'rejects %s on a stable base, which the test form has to open', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, STABLE)).toThrow(/must extend 0\.1\.6 as 0\.1\.6-test\./u)
    })

  it.each([[PRERELEASE, '0.1.6-alpha.2.'], [STABLE, '0.1.6-test.']])(
    'opens %s build versions with %s', (productVersion, prefix) => {
      expect(desktopBuildVersionPrefix(productVersion)).toBe(prefix)
    })
})
