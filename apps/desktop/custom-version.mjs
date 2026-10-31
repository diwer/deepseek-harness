/** Read the official release encoded in an extension build's SemVer version. */
import { parse } from 'semver'

/**
 * Remove the extension revision suffix without changing the official prerelease fields.
 * @param {string} version - Installed or requested version, such as `0.2.1-rc.2-alpha-1`.
 * @returns {string | undefined} Equivalent official version, or undefined for other naming schemes.
 */
export function customDesktopUpstreamVersion(version) {
  const match = /^(?<official>.+)-alpha-[1-9]\d*$/u.exec(version)
  if (match === null) return undefined
  const custom = parse(version)
  const official = parse(match.groups.official)
  if (custom === null || official === null || custom.build.length > 0 || official.build.length > 0) return undefined
  return official.version
}
