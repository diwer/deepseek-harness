/** Read the official release encoded in an extension build's SemVer version. */

/**
 * Remove the extension revision suffix without changing the official prerelease fields.
 * @param version - Installed or requested version, such as `0.2.1-rc.2-alpha-1`.
 * @returns Equivalent official version, or undefined for other naming schemes.
 */
export function customDesktopUpstreamVersion(version: string): string | undefined
