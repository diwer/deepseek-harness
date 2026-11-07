/** Resolve the update channel sealed into the installed application manifest. */
import { valid } from 'semver'

/** Official release metadata checked by custom builds without permitting artifact installation. */
export interface DesktopOfficialUpdateTracking {
  readonly upstreamVersion: string
  readonly feedUrl: string
}

/**
 * Resolve custom-build tracking sealed into the package, using the official production Nightly feed.
 * @param manifest - Parsed application manifest; an absent upstream version disables tracking.
 * @param platform - Packaged operating system.
 * @param arch - Packaged processor architecture.
 * @returns Official metadata location and upstream comparison version, or no custom tracking.
 */
export function desktopOfficialUpdateTracking(
  manifest: unknown, platform: NodeJS.Platform, arch: string,
): DesktopOfficialUpdateTracking | undefined {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpstreamVersion' in manifest)) return undefined
  const upstreamVersion = manifest.dshDesktopUpstreamVersion
  if (typeof upstreamVersion !== 'string' || valid(upstreamVersion) === null) throw new Error('desktop update: invalid upstream version')
  const target = platform === 'darwin' && (arch === 'arm64' || arch === 'x64') ? `mac-${arch}`
    : platform === 'win32' && arch === 'x64' ? 'win-x64' : undefined
  if (target === undefined) throw new Error('desktop update: unsupported official tracking target')
  return { upstreamVersion, feedUrl: `https://download.deepseek.com/dsh-desk/feeds/${target}/` }
}

/** Installer-owned channel, independent of release version and upload environment. */
export type DesktopUpdateChannel = 'nightly' | 'latest'

/**
 * Read the packaged channel; older manifests retain their existing nightly behavior.
 * @param manifest Parsed application manifest.
 * @returns Validated channel. Invalid explicit values reject instead of changing feeds.
 */
export function desktopUpdateChannel(manifest: unknown): DesktopUpdateChannel {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateChannel' in manifest)) return 'nightly'
  const channel = manifest.dshDesktopUpdateChannel
  if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop update: invalid packaged channel')
  return channel
}
