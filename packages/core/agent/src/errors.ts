/**
 * Structured failures for process-local Agent activity admission.
 *
 * @module @deepseek-ai/dsh-agent
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Another activity owns maintenance admission; retry after its quiescence. */
export class AgentActivityBusyError extends Error {
  /**
   * Identify the Agent whose current activity prevented maintenance.
   * @param id - live Agent/session identity.
   */
  constructor(id: SessionId) {
    super(`agent "${id}" already has active work`)
    this.name = 'AgentActivityBusyError'
  }
}
