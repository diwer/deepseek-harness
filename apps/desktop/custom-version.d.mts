/** Read the official release encoded in an extension build's SemVer version. */

/**
 * Read the official release represented by a custom desktop version.
 * @param version - Installed or requested version, such as `0.2.1-rc.2-alpha-1`.
 * @returns Equivalent official version, or undefined for other naming schemes.
 */
export function customDesktopUpstreamVersion(version: string): string | undefined
