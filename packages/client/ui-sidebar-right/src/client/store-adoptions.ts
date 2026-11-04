import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightSurfaceStore } from './service.ts'

/** Borrowed publication, invalidated by any replacement, generation teardown or feature shutdown. */
export interface SidebarStoreAdoption {
  readonly binding: SessionBinding
  readonly store: SidebarRightSurfaceStore
  readonly signal: AbortSignal
  /** Check after every await and reentrant callback; fulfillment does not extend validity. */
  readonly assertCurrent: () => void
}

interface AdoptionRecord {
  readonly lease: SidebarStoreAdoption
  committed: boolean
  readonly release: (reason: unknown, rejectWaiters: boolean) => void
}

interface AdoptionWaiter {
  readonly resolve: (record: AdoptionRecord) => void
  readonly reject: (reason: unknown) => void
}

/** Owns renderer-created Store subscriptions for their exact Session generations. */
export class SidebarStoreAdoptions {
  private readonly records = new Map<SessionId, AdoptionRecord>()
  private readonly waiters = new Map<SessionBinding, Set<AdoptionWaiter>>()
  private closed = false

  constructor(private readonly adoptStore: (sessionId: SessionId, store: SidebarRightSurfaceStore) => () => void) {}

  /**
   * Wait for actual renderer adoption without creating a Store or retaining a Session.
   * @param binding - exact generation; another generation with the same id cannot satisfy it.
   * @param signal - cancels this pending wait only; callbacks are removed on settlement.
   * @returns a borrowed lease after adoption setup returns and its record is still current.
   * @throws on cancellation, generation replacement/teardown, shutdown or current setup failure.
   */
  wait(binding: SessionBinding, signal: AbortSignal): Promise<SidebarStoreAdoption> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      if (this.closed) throw new Error('sidebarRight: Store adoption owner is disposed')
      this.assertBindingLive(binding)
      let active = true
      let disposeScope: (() => Promise<void>) | undefined
      const cleanup = (): void => {
        active = false
        const group = this.waiters.get(binding)
        group?.delete(waiter)
        if (group?.size === 0) this.waiters.delete(binding)
        signal.removeEventListener('abort', abort)
        void disposeScope?.()
      }
      const fail = (reason: unknown): void => {
        if (!active) return
        cleanup()
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's exact abort or setup failure reason.
        reject(reason)
      }
      const abort = (): void => { fail(signal.reason) }
      const waiter: AdoptionWaiter = {
        reject: fail,
        resolve: (record) => {
          if (!active) return
          cleanup()
          try {
            signal.throwIfAborted()
            record.lease.assertCurrent()
            resolve(record.lease)
          } catch (error) {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact cancellation reason.
            reject(error)
          }
        },
      }
      let group = this.waiters.get(binding)
      if (group === undefined) this.waiters.set(binding, group = new Set())
      group.add(waiter)
      try {
        disposeScope = binding.ctx.effect(() => () => { fail(new Error('sidebarRight: Session generation stopped')) }, 'ui-sidebar-right: Store adoption wait')
        const pending = (): boolean => active
        if (!pending()) {
          void disposeScope()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        if (!pending()) {
          signal.removeEventListener('abort', abort)
          return
        }
        if (signal.aborted) {
          abort()
          return
        }
        this.assertBindingLive(binding)
        const record = this.records.get(binding.sessionId)
        if (record?.lease.binding === binding && record.committed) waiter.resolve(record)
      } catch (error) {
        fail(error)
      }
    })
  }

  /**
   * Adopt a Store until replacement, generation teardown or feature shutdown.
   * @param binding - exact live generation that created the Store.
   * @param store - renderer-created Store instance.
   */
  adopt(binding: SessionBinding, store: SidebarRightSurfaceStore): void {
    if (this.closed) throw new Error('sidebarRight: Store adoption owner is disposed')
    this.assertBindingLive(binding)
    const { sessionId } = binding
    const lifetime = new AbortController()
    let active = true
    let withdraw: (() => void) | undefined
    const current = (): boolean => active && this.records.get(sessionId) === record
    const release = (reason: unknown, rejectWaiters: boolean): void => {
      if (!active) return
      active = false
      if (this.records.get(sessionId) === record) this.records.delete(sessionId)
      void disposeScope()
      if (rejectWaiters) this.rejectWaiters(binding, reason)
      lifetime.abort(reason)
      withdraw?.()
    }
    const record: AdoptionRecord = {
      committed: false,
      release,
      lease: {
        binding, store, signal: lifetime.signal,
        assertCurrent: () => {
          lifetime.signal.throwIfAborted()
          this.assertBindingLive(binding)
          if (!current() || !record.committed) throw new Error('sidebarRight: Store adoption is no longer current')
        },
      },
    }
    const disposeScope = binding.ctx.effect(() => () => { release(new Error('sidebarRight: Session generation stopped'), true) }, 'ui-sidebar-right: Session Store adoption')
    try {
      this.assertBindingLive(binding)
      const previous = this.records.get(sessionId)
      this.records.set(sessionId, record)
      previous?.release(new Error('sidebarRight: Store adoption was replaced'), previous.lease.binding !== binding)
      if (!current()) return
      this.assertBindingLive(binding)
      for (const pendingBinding of this.waiters.keys()) {
        if (pendingBinding.sessionId === sessionId && pendingBinding !== binding) {
          this.rejectWaiters(pendingBinding, new Error('sidebarRight: Session generation was replaced'))
          if (!current()) return
          this.assertBindingLive(binding)
        }
      }
      withdraw = this.adoptStore(sessionId, store)
      if (!current()) {
        withdraw()
        return
      }
      this.assertBindingLive(binding)
      record.committed = true
      for (const waiter of this.waiters.get(binding) ?? []) {
        if (!current()) return
        waiter.resolve(record)
      }
    } catch (error) {
      release(error, current())
      throw error
    }
  }

  /** Withdraw all adoptions, revoke leases and reject waits; unregister generation callbacks. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    const reason = new Error('sidebarRight: Store adoption owner is disposed')
    for (const binding of this.waiters.keys()) this.rejectWaiters(binding, reason)
    for (const record of this.records.values()) record.release(reason, true)
  }

  private assertBindingLive(binding: SessionBinding): void {
    binding.ctx.fiber.assertActive()
    // Sessions retire bindings before retention callbacks and deferred fiber cleanup.
    if (binding.ctx.sessions.binding(binding.sessionId) !== binding) {
      throw new Error('sidebarRight: Session generation is no longer live')
    }
  }

  private rejectWaiters(binding: SessionBinding, reason: unknown): void {
    for (const waiter of this.waiters.get(binding) ?? []) waiter.reject(reason)
  }
}
