import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightSurfaceStore } from './service.ts'

/** Owns renderer-created Store subscriptions for their exact Session generations. */
export class SidebarStoreAdoptions {
  private readonly releases = new Map<SessionId, () => void>()
  private closed = false

  constructor(private readonly adoptStore: (sessionId: SessionId, store: SidebarRightSurfaceStore) => () => void) {}

  /**
   * Adopt a Store until its generation or this feature stops.
   * @param binding - exact live generation that created the Store.
   * @param store - renderer-created Store instance.
   */
  adopt(binding: SessionBinding, store: SidebarRightSurfaceStore): void {
    if (this.closed) throw new Error('sidebarRight: Store adoption owner is disposed')
    const { sessionId } = binding
    let active = true
    let withdraw: (() => void) | undefined
    const release = (): void => {
      if (!active) return
      active = false
      if (this.releases.get(sessionId) === release) this.releases.delete(sessionId)
      void disposeScope()
      withdraw?.()
    }
    const disposeScope = binding.ctx.effect(() => release, 'ui-sidebar-right: Session Store adoption')
    const current = (): boolean => active && this.releases.get(sessionId) === release
    const previous = this.releases.get(sessionId)
    this.releases.set(sessionId, release)
    try {
      previous?.()
      if (!current()) return
      withdraw = this.adoptStore(sessionId, store)
      if (!current()) withdraw()
    } catch (error) {
      release()
      throw error
    }
  }

  /** Withdraw all adoptions and unregister their generation callbacks. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const release of this.releases.values()) release()
  }
}
