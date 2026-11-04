/** Session-owned storage accounts for native Browser guests. */

/**
 * Tabs in one Session share storage; Workspace membership never joins accounts.
 * This key selects storage only and grants no automation authority.
 * @param sessionId - owning DSH Session.
 * @param signal - guest initialization lifetime.
 * @returns the process-local storage account for this Session.
 */
export async function browserSessionStorage(sessionId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return `session:${sessionId}`
}
