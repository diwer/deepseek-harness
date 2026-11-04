/** Selection and retention policy for independently owned Sidebar Session views. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarSessionView } from './session-view.ts'

/** The reference is exclusively a framework SessionProvider target, not a business-component service. */
export interface SidebarSessionViewSnapshot {
  readonly sessionId: SessionId
  readonly reference: SessionReference
  readonly selected: boolean
  /** Stable for this View's lifetime, independently of Session injection bindings. */
  readonly retainTab: SidebarSessionView['retainTab']
}

/** One independently cancellable demand for the original Sidebar Session subtree. */
export interface SidebarSessionViewHold {
  /** Framework SessionProvider target; readiness does not imply store adoption or a mounted body. */
  readonly reference: SessionReference
  /** Release this demand only; committed roots still own the final unmount boundary. */
  readonly release: () => void
}

/** Selects and retires views; the Sidebar plugin's injected dependencies own global teardown. */
export class SidebarSessionViews {
  /** Selected and retained View targets observed by the root renderer. */
  readonly source = createSnapshotStore<readonly SidebarSessionViewSnapshot[]>([])
  private readonly views = new Map<SessionId, SidebarSessionView>()
  private readonly viewsByReference = new Map<SessionReference, SidebarSessionView>()
  private readonly allocating = new Set<SessionId>()
  private selected: SessionId | undefined
  private closed = false

  constructor(private readonly sessions: ISessions) {}

  /**
   * Change the foreground Session while preserving retained background Views.
   * @param sessionId - main selection, or absence.
   */
  select(sessionId: SessionId | undefined): void {
    if (this.closed || this.selected === sessionId) return
    this.selected = sessionId
    if (sessionId !== undefined) this.getOrCreate(sessionId)
    for (const view of this.views.values()) this.prune(view)
    this.publish()
  }

  /**
   * Publish a background Session through the same root, without changing selection.
   * This is rendering demand, not task authority or store/tab/guest readiness.
   * @param sessionId - Session whose original subtree is needed.
   * @param signal - demand lifetime, independent of selection and retained bodies.
   * @returns owned reference and idempotent release, also released by abort or shutdown.
   * @throws the abort reason if cancelled, including during publication; an error after owner shutdown
   * or on synchronous same-Session reentry before Session allocation returns its reference.
   */
  hold(sessionId: SessionId, signal: AbortSignal): SidebarSessionViewHold {
    signal.throwIfAborted()
    this.assertOpen()
    const existing = this.views.get(sessionId)
    const view = existing ?? this.getOrCreate(sessionId)
    let release: () => void
    try {
      release = view.hold(signal)
    } catch (error) {
      this.prune(view)
      throw error
    }
    // Establish the demand before notifying roots: a subscriber can select,
    // cancel or dispose synchronously while this publication is in progress.
    // Extra demands on an existing view do not change the render snapshot.
    if (existing === undefined) this.publish()
    signal.throwIfAborted()
    this.assertOpen()
    return { reference: view.reference, release }
  }

  /**
   * Bind a committed root; release retired references after that root unmounts.
   * @param reference - framework target published by this owner.
   * @returns releases this committed mount.
   */
  mount(reference: SessionReference): () => void {
    const view = this.viewsByReference.get(reference)
    if (view === undefined) {
      if (this.closed) return () => {}
      throw new Error('Sidebar Session view reference is no longer owned')
    }
    return view.mount()
  }

  /** Plugin shutdown releases every view and demand, including any awaiting a React unmount. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.views.clear()
    this.source.set([])
    for (const view of this.viewsByReference.values()) view.dispose()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Sidebar Session views are disposed')
  }

  private getOrCreate(sessionId: SessionId): SidebarSessionView {
    const existing = this.views.get(sessionId)
    if (existing !== undefined) return existing
    // Retention observers run inside sessions.retain(), before its reference
    // is available. Never expose a partial View or allocate a second one.
    if (this.allocating.has(sessionId)) throw new Error('Sidebar Session view allocation is already in progress')
    this.allocating.add(sessionId)
    try {
      const view = new SidebarSessionView(sessionId, this.sessions, (disposed) => {
        this.viewsByReference.delete(disposed.reference)
      }, (released) => { this.prune(released) })
      // Session allocation may synchronously trigger plugin shutdown.
      if (this.closed) {
        view.dispose()
        throw new Error('Sidebar Session views are disposed')
      }
      this.views.set(sessionId, view)
      this.viewsByReference.set(view.reference, view)
      return view
    } finally {
      this.allocating.delete(sessionId)
    }
  }

  private prune(view: SidebarSessionView): void {
    if (view.sessionId === this.selected || view.hasRetainedTabs || view.hasHolds || this.views.get(view.sessionId) !== view) return
    this.views.delete(view.sessionId)
    // Render targets must be withdrawn before an unmounted view can release its reference.
    this.publish()
    view.retire()
  }

  private publish(): void {
    this.source.set([...this.views.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map(view => ({
      sessionId: view.sessionId, reference: view.reference, selected: view.sessionId === this.selected, retainTab: view.retainTab,
    })))
  }
}
