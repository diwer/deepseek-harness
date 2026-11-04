// @vitest-environment jsdom
/** Private transaction timing with real Sessions and original View/adoption owners. */
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarSessionViews } from '../src/client/session-views.ts'
import { SidebarStoreAdoptions } from '../src/client/store-adoptions.ts'
import { SidebarBodyPreparations } from '../src/client/body-preparation.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { createSidebarRightController } from '../src/client/service.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 'private-lifetime' as SessionId
const runtimes: SlotTestRuntime[] = []
const cleanups: Array<() => void | Promise<void>> = []
const gates: Array<() => void> = []

afterEach(async () => {
  for (const finish of gates.splice(0)) finish()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
})

async function fixture() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.sessions.add({ id: SESSION })
  const reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'testFixture' })
  await reference.ready
  const binding = reference.binding
  const tabs = new SidebarRightTabRegistry(runtime.ctx)
  tabs.register({ id: 'test/private', kind: 'prepared', title: () => 'Prepared' })
  const views = new SidebarSessionViews(runtime.sessions)
  cleanups.push(() => { views.dispose() })
  const controller = createSidebarRightController(tabs, () => {}, {
    autoFullscreen: () => false, openWithFocus: (_id, open) => { open() }, closeWithFocus: (_id, _pane, close) => { close() },
  })
  const adoptions = new SidebarStoreAdoptions(controller.adopt)
  cleanups.push(() => { adoptions.dispose() })
  const subject = new SidebarBodyPreparations(views, adoptions, tabs, controller.controller.tabDomain, controller.removePrepared)
  cleanups.push(() => subject.dispose())
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'Guide' })).create()
  const adopt = () => { adoptions.adopt(binding, store) }
  return { runtime, reference, binding, views, adoptions, subject, store, adopt, controller: controller.controller }
}

function gate() {
  const finish = Promise.withResolvers<undefined>()
  gates.push(() => { finish.resolve(undefined) })
  return { finish: () => { finish.resolve(undefined) }, promise: finish.promise }
}

it('undo retires the blocked occurrence and redo restores an independent ungated occurrence', async () => {
  const h = await fixture()
  h.adopt()
  const pending = h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, (target) => {
    h.store.actions.undo(SESSION)
    expect(target.signal.aborted).toBe(true)
    h.store.actions.redo(SESSION)
    const record = h.store.getSnapshot().bySession[SESSION]!.layout.tabs[target.occurrence.tabId]!
    const restored = h.controller.tabDomain.occurrence(SESSION, record)
    expect(restored).not.toBe(target.occurrence)
    expect(restored.signal.aborted).toBe(false)
    expect(h.store.getSnapshot().bySession[SESSION]?.unpublishedBodies).toEqual([])
  })
  await expect(pending).rejects.toThrow('aborted')
  expect(Object.values(h.store.getSnapshot().bySession[SESSION]!.layout.tabs)).toHaveLength(1)
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
})

it('waits for reference readiness and real adoption as separate settlement points', async () => {
  const h = await fixture()
  const ready = gate()
  const retained = h.runtime.sessions.retain.bind(h.runtime.sessions)
  vi.spyOn(h.runtime.sessions, 'retain').mockImplementation((id, options) => {
    const reference = retained(id, options)
    return { sessionId: reference.sessionId, get binding() { return reference.binding },
      ready: reference.ready.then(async (binding) => { await ready.promise; return binding }), release: () => { reference.release() },
      [Symbol.dispose]: () => { reference.release() } }
  })
  const before = vi.fn()
  const pending = h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, before)
  expect(h.views.source.getSnapshot()).toHaveLength(1)
  expect(h.store.getSnapshot().bySession).toEqual({})
  expect(before).not.toHaveBeenCalled()
  ready.finish()
  await h.runtime.flush()
  expect(before).not.toHaveBeenCalled()
  expect(h.store.getSnapshot().bySession).toEqual({})
  h.adopt()
  const lease = await pending
  expect(before).toHaveBeenCalledOnce()
  expect(lease.binding).toBe(h.binding)
  await lease.release()
})

it('cancels before adoption and detaches the exact adoption waiter synchronously', async () => {
  const h = await fixture()
  const caller = new AbortController()
  const before = vi.fn()
  const pending = h.subject.prepareBody(SESSION, 'prepared', caller.signal, before)
  const failed = expect(pending).rejects.toThrow('cancel adoption')
  await h.runtime.flush()
  const effects = () => h.binding.ctx.fiber.getEffects().filter(item => item.label === 'ui-sidebar-right: Store adoption wait')
  expect(effects()).toHaveLength(1)
  caller.abort(new Error('cancel adoption'))
  expect(effects()).toEqual([])
  await failed
  h.adopt()
  expect(before).not.toHaveBeenCalled()
  expect(h.store.getSnapshot().bySession).toEqual({})
})

it('cancels pending readiness without waiting for or adopting its late fulfillment', async () => {
  const h = await fixture()
  const ready = gate()
  const retained = h.runtime.sessions.retain.bind(h.runtime.sessions)
  vi.spyOn(h.runtime.sessions, 'retain').mockImplementation((id, options) => {
    const reference = retained(id, options)
    return { sessionId: reference.sessionId, get binding() { return reference.binding },
      ready: reference.ready.then(async (binding) => { await ready.promise; return binding }), release: () => { reference.release() },
      [Symbol.dispose]: () => { reference.release() } }
  })
  const caller = new AbortController()
  const before = vi.fn()
  const pending = h.subject.prepareBody(SESSION, 'prepared', caller.signal, before)
  await h.runtime.flush()
  caller.abort(new Error('cancel readiness'))
  await expect(pending).rejects.toThrow('cancel readiness')
  expect(h.views.source.getSnapshot()).toEqual([])
  ready.finish()
  await h.runtime.flush()
  h.adopt()
  expect(before).not.toHaveBeenCalled()
  expect(h.store.getSnapshot().bySession).toEqual({})
})

it('rejects reentrant close at reservation and never resurrects its demand', async () => {
  const h = await fixture()
  h.adopt()
  await expect(h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, (target) => {
    h.controller.closeIn(SESSION, target.occurrence.tabId)
    expect(target.signal.aborted).toBe(true)
  })).rejects.toThrow('aborted')
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
  expect(h.controller.tabsIn(SESSION)).toEqual([])
})

it('does not roll back a replacement created reentrantly during reservation', async () => {
  const h = await fixture()
  h.adoptions.adopt(h.binding, h.store)
  let replaced: string | undefined
  await expect(h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, (target) => {
    replaced = target.occurrence.tabId
    h.controller.openTabIn(SESSION, 'prepared', { replaceTab: target.occurrence.tabId })
    expect(target.signal.aborted).toBe(true)
  })).rejects.toThrow('aborted')
  expect(h.controller.tabsIn(SESSION)).toHaveLength(1)
  expect(h.controller.tabsIn(SESSION)[0]?.id).not.toBe(replaced)
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
})

it('withdraws demand during a publication observer and rolls back only the prepared occurrence', async () => {
  const h = await fixture()
  h.adopt()
  h.controller.openTabIn(SESSION, 'prepared')
  const original = h.controller.tabsIn(SESSION)[0]!
  const caller = new AbortController()
  h.controller.tabDomain.bodyMountsOf(SESSION).subscribe(() => {
    if (h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot().length > 0) caller.abort(new Error('cancel demand observer'))
  })
  await expect(h.subject.prepareBody(SESSION, 'prepared', caller.signal, () => {})).rejects.toThrow('cancel demand observer')
  expect(h.controller.tabsIn(SESSION)).toEqual([original])
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
})

it('revokes a published lease on binding retirement before delayed adoption teardown completes', async () => {
  const h = await fixture()
  const delayed = gate()
  const entered = Promise.withResolvers<undefined>()
  const effect = h.binding.ctx.effect.bind(h.binding.ctx)
  vi.spyOn(h.binding.ctx, 'effect').mockImplementation((execute, label) => {
    if (label !== 'ui-sidebar-right: Session Store adoption') return effect(execute, label)
    return effect((): ReturnType<typeof execute> => {
      const cleanup = execute()
      return async () => { entered.resolve(undefined); await delayed.promise; if (typeof cleanup === 'function') await cleanup() }
    }, label)
  })
  h.adopt()
  const lease = await h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, () => {})
  const dispose = h.binding.ctx.fiber.dispose()
  await entered.promise
  expect(h.runtime.sessions.binding(SESSION)).toBeUndefined()
  expect(lease.signal.aborted).toBe(true)
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
  expect(() => { lease.assertCurrent() }).toThrow()
  delayed.finish()
  await dispose
  await lease.release()
})

it('keeps cleanup dependencies alive after reservation failure until actual native disposal settles', async () => {
  const h = await fixture()
  h.adopt()
  const delayed = gate()
  const entered = Promise.withResolvers<undefined>()
  const unsubscribe = h.views.source.subscribe(() => {
    if (h.views.source.getSnapshot().length === 0) h.adoptions.dispose()
  })
  cleanups.push(unsubscribe)
  h.controller.registerCloseHandler('prepared', () => { entered.resolve(undefined); return delayed.promise })
  const primary = new Error('reservation failed')
  const pending = h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, () => { throw primary })
  const rejected = expect(pending).rejects.toBe(primary)
  await Promise.race([
    entered.promise,
    pending.catch(() => { throw new Error('Preparation settled before native cleanup started') }),
  ])
  expect(h.views.source.getSnapshot()).toHaveLength(1)
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
  delayed.finish()
  await rejected
  expect(h.views.source.getSnapshot()).toEqual([])
})

it('synchronously revokes all preparations on owner disposal and awaits delayed native close', async () => {
  const h = await fixture()
  h.adopt()
  const delayed = gate()
  const entered = Promise.withResolvers<undefined>()
  h.controller.registerCloseHandler('prepared', () => { entered.resolve(undefined); return delayed.promise })
  const lease = await h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, () => {})
  const done = vi.fn()
  const disposing = h.subject.dispose()
  void disposing.then(done)
  expect(lease.signal.aborted).toBe(true)
  expect(h.controller.tabDomain.bodyMountsOf(SESSION).getSnapshot()).toEqual([])
  await entered.promise
  expect(done).not.toHaveBeenCalled()
  delayed.finish()
  await disposing
  expect(h.controller.tabsIn(SESSION)).toEqual([])
  await expect(h.subject.prepareBody(SESSION, 'prepared', new AbortController().signal, () => {})).rejects.toThrow('disposed')
})
