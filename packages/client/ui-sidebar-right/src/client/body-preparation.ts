/** Effect-owned preparation through original Session views and renderer-adopted Stores only. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightBodyPreparationPort, SidebarRightPreparedBody, SidebarRightPreparedBodyTarget } from './body-preparation-types.ts'
import { pageAddress } from './contract/seed.ts'
import type { SidebarSessionViewHold, SidebarSessionViews } from './session-views.ts'
import type { SidebarStoreAdoption, SidebarStoreAdoptions } from './store-adoptions.ts'
import type { SidebarRightSurfaceStore } from './service.ts'
import type { TabDomain, TabOccurrence } from './tab-domain.ts'
import type { SidebarRightTabRegistry } from './tab-registry.ts'

/** Race external readiness without retaining an abort listener or accepting late fulfillment. */
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's exact cancellation reason.
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the readiness failure verbatim.
        reject(error)
      })
    if (signal.aborted) abort()
  })
}

/** Owns private preparation transactions, independently of the manual root's lifetime. */
export class SidebarBodyPreparations implements SidebarRightBodyPreparationPort {
  private readonly operations = new Set<() => Promise<void>>()
  private readonly cleanups = new Set<Promise<void>>()
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly views: SidebarSessionViews,
    private readonly adoptions: SidebarStoreAdoptions,
    private readonly tabs: SidebarRightTabRegistry,
    private readonly domain: TabDomain,
    private readonly removePrepared: (store: SidebarRightSurfaceStore, tab: TabRecord, occurrence: TabOccurrence) => Promise<void>,
  ) {}

  /**
   * @inheritdoc
   * @param caller - cancellation lifetime, including the returned preparation.
   */
  async prepareBody(sessionId: SessionId, kind: string, caller: AbortSignal,
    beforePublishTarget: (target: SidebarRightPreparedBodyTarget) => void | Promise<void>): Promise<SidebarRightPreparedBody> {
    caller.throwIfAborted()
    if (this.closed) throw new Error('sidebarRight: body preparation owner is disposed')
    const lifetime = new AbortController()
    // Native cleanup retains its original subtree after preparation authority ends.
    const retention = new AbortController()
    const settled = Promise.withResolvers<void>()
    let hold: SidebarSessionViewHold | undefined
    let binding: SessionBinding | undefined
    let adoption: SidebarStoreAdoption | undefined
    let tab: TabRecord | undefined
    let occurrence: TabOccurrence | undefined
    let releaseDemand: (() => void) | undefined
    let stopGeneration: (() => void) | undefined
    let cleanup: Promise<void> | undefined
    const reason = new Error('sidebarRight: body preparation released')
    const assertCurrent = (): void => {
      lifetime.signal.throwIfAborted()
      caller.throwIfAborted()
      if (this.closed) throw new Error('sidebarRight: body preparation owner is disposed')
      if (binding !== undefined) {
        binding.ctx.fiber.assertActive()
        if (binding.ctx.sessions.binding(sessionId) !== binding) throw new Error('sidebarRight: Session generation changed')
      }
      adoption?.assertCurrent()
      if (occurrence !== undefined && (!this.domain.isCurrent(occurrence) || occurrence.signal.aborted
        || adoption?.store.getSnapshot().bySession[sessionId]?.layout.tabs[occurrence.tabId] !== tab)) {
        throw new Error('sidebarRight: prepared occurrence changed')
      }
    }
    const release = (): Promise<void> => {
      if (cleanup !== undefined) return cleanup
      const done = Promise.withResolvers<void>()
      cleanup = done.promise
      this.cleanups.add(cleanup)
      this.operations.delete(release)
      caller.removeEventListener('abort', cancel)
      adoption?.signal.removeEventListener('abort', cancel)
      occurrence?.signal.removeEventListener('abort', cancel)
      const failures: unknown[] = []
      // Revoke private authority, listeners and body demand before native close.
      try { stopGeneration?.() } catch (error) { failures.push(error) }
      lifetime.abort(caller.aborted ? caller.reason
        : adoption?.signal.aborted === true ? adoption.signal.reason
          : occurrence?.signal.aborted === true ? occurrence.signal.reason : reason)
      try { releaseDemand?.() } catch (error) { failures.push(error) }
      void settled.promise.then(async () => {
        if (adoption !== undefined && tab !== undefined && occurrence !== undefined) {
          try { await this.removePrepared(adoption.store, tab, occurrence) } catch (error) { failures.push(error) }
        }
        try { hold?.release() } catch (error) { failures.push(error) }
        retention.abort(reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Sidebar body preparation cleanup failed')
      }).then(done.resolve, done.reject)
      void cleanup.then(() => { this.cleanups.delete(done.promise) }, () => { this.cleanups.delete(done.promise) })
      return cleanup
    }
    const cancel = (): void => { void release().catch((error: unknown) => { console.error('Sidebar body preparation cleanup failed:', error) }) }
    this.operations.add(release)
    caller.addEventListener('abort', cancel, { once: true })
    try {
      hold = this.views.hold(sessionId, retention.signal)
      assertCurrent()
      binding = hold.reference.binding
      const exactBinding = binding
      // Retention publishes generation retirement before delayed scoped-effect disposal.
      stopGeneration = binding.ctx.sessions.retainInfo(sessionId).subscribe(() => {
        if (exactBinding.ctx.sessions.binding(sessionId) !== exactBinding) cancel()
      })
      assertCurrent()
      const readyBinding = await cancellable(hold.reference.ready, lifetime.signal)
      assertCurrent()
      if (readyBinding !== binding) throw new Error('sidebarRight: Session readiness changed generation')
      adoption = await this.adoptions.wait(binding, lifetime.signal)
      assertCurrent()
      adoption.signal.addEventListener('abort', cancel, { once: true })
      const definition = this.tabs.get(kind)
      if (definition === undefined) throw new Error(`sidebarRight: unknown tab kind "${kind}"`)
      const contentId = `${pageAddress(kind)}/${randomUUID()}`
      const title = definition.title(contentId)
      assertCurrent()
      // The action atomically commits a deny-only body gate, including the zero-tab case.
      try { adoption.store.actions.prepareContent(sessionId, { kind, contentId, title }) }
      finally {
        // Capture only from the fully settled Store, including observers that cancel or throw.
        tab = Object.values(adoption.store.getSnapshot().bySession[sessionId]?.layout.tabs ?? {})
          .find(record => record.contentId === contentId && record.kind === kind)
        if (tab !== undefined) occurrence = this.domain.occurrence(sessionId, tab)
      }
      assertCurrent()
      if (occurrence === undefined) throw new Error('sidebarRight: prepared tab disappeared during settlement')
      occurrence.signal.addEventListener('abort', cancel, { once: true })
      const target: SidebarRightPreparedBodyTarget = { binding, occurrence, signal: lifetime.signal, assertCurrent }
      const before = beforePublishTarget(target)
      if (before !== undefined) await cancellable(before, lifetime.signal)
      assertCurrent()
      releaseDemand = this.domain.requestBodyMount(occurrence, lifetime.signal)
      assertCurrent()
      adoption.store.actions.publishPreparedBody(sessionId, occurrence.tabId)
      assertCurrent()
      return { ...target, release }
    } catch (error) {
      // Release waits only for Store settlement, never for abandoned external readiness.
      settled.resolve()
      try { await release() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Sidebar body preparation and cleanup failed')
      }
      throw error
    } finally {
      settled.resolve()
    }
  }

  /** Revoke every operation synchronously; await already-started and newly-started native cleanup. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const done = Promise.withResolvers<void>()
    this.disposal = done.promise
    this.closed = true
    for (const release of [...this.operations]) void release()
    void Promise.allSettled([...this.cleanups]).then((results) => {
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Sidebar body preparation shutdown failed')
    }).then(done.resolve, done.reject)
    return this.disposal
  }
}
