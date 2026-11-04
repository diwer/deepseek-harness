/** Desktop-private, type-only original-root body preparation injection. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabOccurrence } from './tab-domain.ts'

/** Exact committed Sidebar target; neither native-guest readiness nor task authority. */
export interface SidebarRightPreparedBodyTarget {
  readonly binding: SessionBinding
  readonly occurrence: TabOccurrence
  readonly signal: AbortSignal
  /** Check after every await and reentrant callback; a fulfilled preparation can become stale. */
  readonly assertCurrent: () => void
}

/** An owned preparation; releasing demand alone does not acknowledge React or native disposal. */
export interface SidebarRightPreparedBody extends SidebarRightPreparedBodyTarget {
  /** Revoke synchronously, then await exact newly-created-record cleanup; idempotent. */
  readonly release: () => Promise<void>
}

/** Capability supplied only by the genuine Sidebar root's owning effect. */
export interface SidebarRightBodyPreparationPort {
  /**
   * Prepare a distinct page without Session selection, navigation or panel reveal.
   * Preserve an existing active tab; an initially empty pane must mark its first tab active.
   * Atomically block its body until beforePublishTarget settles, including synchronous Store observers.
   * @param sessionId - Session whose original subtree must render the body.
   * @param kind - registered page kind.
   * @param signal - caller lifetime, including the returned lease.
   * @param beforePublishTarget - installs the consumer's reservation before any body demand/construction.
   * @returns exact settled target; rejects cancellation and preserves cleanup failures.
   */
  prepareBody(sessionId: SessionId, kind: string, signal: AbortSignal,
    beforePublishTarget: (target: SidebarRightPreparedBodyTarget) => void | Promise<void>): Promise<SidebarRightPreparedBody>
}

/** Desktop owns this optional receiver; unregistering a port must not affect manual Sidebar use. */
export interface SidebarRightBodyPreparationReceiver {
  /**
   * Accept a scoped original-root capability.
   * @param port - effect-owned preparation entry.
   * @returns exact registration removal.
   */
  register(port: SidebarRightBodyPreparationPort): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop-private optional receiver, not a public navigation or model Service. */
    sidebarRightBodyPreparation: SidebarRightBodyPreparationReceiver
  }
}
