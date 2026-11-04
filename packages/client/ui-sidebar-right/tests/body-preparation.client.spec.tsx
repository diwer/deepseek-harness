// @vitest-environment jsdom
/** Private preparation through the real original Sidebar root, Slots and Session generations. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply, inject } from '../src/client/index.ts'
import type { SidebarRightBodyPreparationPort, SidebarRightPreparedBodyTarget } from '../src/client/body-preparation-types.ts'
import type { SidebarRightSurfaceStore } from '../src/client/service.ts'
import { SidebarStoreAdoptions } from '../src/client/store-adoptions.ts'

const A = 'prepare-a' as SessionId
const B = 'prepare-b' as SessionId
const runtimes: SlotTestRuntime[] = []
const gates: Array<() => void> = []
let animations: PropertyDescriptor | undefined

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})
afterEach(async () => {
  for (const finish of gates.splice(0)) finish()
  try { for (const runtime of runtimes.splice(0)) await runtime.dispose() }
  finally {
    vi.restoreAllMocks()
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animations)
  }
})

async function fixture(onAdopt?: (binding: SessionBinding, store: SidebarRightSurfaceStore) => void) {
  // oxlint-disable-next-line typescript/unbound-method -- Delegate using the spy's exact receiver below.
  const adopted = SidebarStoreAdoptions.prototype.adopt
  const stores = new Map<SessionId, SidebarRightSurfaceStore>()
  vi.spyOn(SidebarStoreAdoptions.prototype, 'adopt').mockImplementation(function (this: SidebarStoreAdoptions, binding, store) {
    adopted.call(this, binding, store)
    stores.set(binding.sessionId, store)
    onAdopt?.(binding, store)
  })
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo }
  runtime.ctx.provide('layout', layout as never)
  runtime.ctx.provide('resources', { pin: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) } as never)
  runtime.slots.installLocale(locale)
  let port: SidebarRightBodyPreparationPort | undefined
  const unregister = vi.fn()
  const receiver = runtime.ctx.provide('sidebarRightBodyPreparation', {
    register(value) { port = value; return unregister },
  })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await runtime.sessions.add({ id: A })
  await runtime.sessions.add({ id: B })
  const selected = runtime.sessions.retainFor(runtime.ctx, A, { source: 'mainView' })
  await selected.ready
  const feature = await runtime.mount({ inject: [...inject], apply })
  const constructed = vi.fn()
  act(() => {
    runtime.ctx.sidebarRightTabs.register({ id: 'test/preparation', kind: 'prepared', multiple: true, keepMounted: true, title: () => 'Prepared' })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/preparation' }, () => { constructed(); return null })
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
  if (port === undefined) throw new Error('expected original-root preparation registration')
  const controller = runtime.ctx.sidebarRight
  const store = (id: SessionId): SidebarRightSurfaceStore => {
    const found = stores.get(id)
    if (found === undefined) throw new Error('expected original adopted Store')
    return found
  }
  return { runtime, feature, selected, port, unregister, receiver, constructed, controller, view, store, layout }
}

function gate() {
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  gates.push(() => { finish.resolve(undefined) })
  return {
    entered: entered.promise, enter: () => { entered.resolve(undefined) },
    finish: () => { finish.resolve(undefined) }, wait: finish.promise,
  }
}

it('prepares a never-selected body after reservation without Session, navigation, presentation or DOM focus changes', async () => {
  const h = await fixture()
  const selected = h.controller.mounted.getSnapshot()
  const layoutCalls = h.layout.openRightbar.mock.calls.length
  const input = document.createElement('input')
  h.view.container.append(input); input.focus()
  const publish = gate()
  let target: SidebarRightPreparedBodyTarget | undefined
  const pending = h.port.prepareBody(B, 'prepared', new AbortController().signal, (value) => {
    target = value
    expect(h.constructed).not.toHaveBeenCalled()
    expect(h.controller.tabDomain.bodyMountsOf(B).getSnapshot()).toEqual([])
    expect(h.store(B).getSnapshot().bySession[B]?.unpublishedBodies).toContain(value.occurrence.tabId)
    publish.enter()
    return publish.wait
  })
  await publish.entered
  expect(h.constructed).not.toHaveBeenCalled()
  publish.finish()
  const lease = await pending
  await h.runtime.flush()
  expect(h.constructed).toHaveBeenCalled()
  expect(lease.binding).toBe(target?.binding)
  expect(lease.occurrence).toBe(target?.occurrence)
  expect(h.controller.mounted.getSnapshot()).toBe(selected)
  expect(h.layout.openRightbar).toHaveBeenCalledTimes(layoutCalls)
  expect(document.activeElement).toBe(input)
  expect(lease.occurrence.navigation.getSnapshot().revision).toBe(0)
  expect(h.view.container.querySelector<HTMLElement>(`[data-sidebar-right-session="${B}"]`)?.hidden).toBe(true)
  await lease.release()
  expect(lease.signal.aborted).toBe(true)
  expect(() => { lease.assertCurrent() }).toThrow()
})

it('blocks construction before reservation even when an insertion observer expands and synchronously renders the active first tab', async () => {
  let unsubscribe: (() => void) | undefined
  const h = await fixture((binding, store) => {
    if (binding.sessionId !== A) return
    unsubscribe = store.subscribe(() => {
      const surface = store.getSnapshot().bySession[A]
      if (surface?.unpublishedBodies?.length !== 1 || surface.layout.expanded) return
      flushSync(() => { store.actions.setExpanded(A, true) })
    })
  })
  const before = vi.fn(() => { expect(h.constructed).not.toHaveBeenCalled() })
  const lease = await h.port.prepareBody(A, 'prepared', new AbortController().signal, before)
  await h.runtime.flush()
  expect(before).toHaveBeenCalledOnce()
  expect(h.constructed).toHaveBeenCalled()
  const surface = h.store(A).getSnapshot().bySession[A]!
  expect(surface.layout.tabs[lease.occurrence.tabId]).toBeDefined()
  unsubscribe?.()
  await lease.release()
})

it('captures after insertion observers and rolls back cancellation inside the committed Store notification without ever publishing demand', async () => {
  const caller = new AbortController()
  const reason = new Error('cancel during insert')
  const h = await fixture((binding, store) => {
    if (binding.sessionId !== B) return
    store.subscribe(() => {
      if ((store.getSnapshot().bySession[B]?.unpublishedBodies?.length ?? 0) > 0) caller.abort(reason)
    })
  })
  const before = vi.fn()
  await expect(h.port.prepareBody(B, 'prepared', caller.signal, before)).rejects.toBe(reason)
  expect(before).not.toHaveBeenCalled()
  expect(h.constructed).not.toHaveBeenCalled()
  expect(h.controller.tabDomain.bodyMountsOf(B).getSnapshot()).toEqual([])
  expect(h.controller.tabsIn(B)).toEqual([])
})

it('revokes cancellation before publication immediately and ignores late callback fulfillment', async () => {
  const h = await fixture()
  const caller = new AbortController()
  const publish = gate()
  let target: SidebarRightPreparedBodyTarget | undefined
  const pending = h.port.prepareBody(B, 'prepared', caller.signal, (value) => { target = value; publish.enter(); return publish.wait })
  const failed = expect(pending).rejects.toThrow('cancel reservation')
  await publish.entered
  caller.abort(new Error('cancel reservation'))
  expect(target?.signal.aborted).toBe(true)
  expect(h.controller.tabDomain.bodyMountsOf(B).getSnapshot()).toEqual([])
  await failed
  publish.finish()
  await h.runtime.flush()
  expect(h.constructed).not.toHaveBeenCalled()
  expect(h.controller.tabsIn(B)).toEqual([])
})

it('keeps the exact occurrence gated and release pending until asynchronous native cleanup completes', async () => {
  const h = await fixture()
  const native = gate()
  const close = vi.fn(() => { native.enter(); return native.wait })
  h.controller.registerCloseHandler('prepared', close)
  const lease = await h.port.prepareBody(B, 'prepared', new AbortController().signal, () => {})
  const done = vi.fn()
  const released = lease.release()
  void released.then(done)
  expect(lease.release()).toBe(released)
  expect(lease.signal.aborted).toBe(true)
  expect(h.controller.tabDomain.bodyMountsOf(B).getSnapshot()).toEqual([])
  await native.entered
  expect(done).not.toHaveBeenCalled()
  expect(lease.occurrence.signal.aborted).toBe(true)
  expect(h.controller.tabsIn(B)).toHaveLength(1)
  native.finish()
  await released
  expect(close).toHaveBeenCalledOnce()
  expect(h.controller.tabsIn(B)).toEqual([])
})

it('revokes preparations before native cleanup and keeps original-root feature disposal pending for it', async () => {
  const h = await fixture()
  const native = gate()
  const close = vi.fn(() => { native.enter(); return native.wait })
  h.controller.registerCloseHandler('prepared', close)
  const lease = await h.port.prepareBody(B, 'prepared', new AbortController().signal, () => {})
  const done = vi.fn()
  const disposal = h.feature.fiber.dispose()
  void disposal.then(done)
  try {
    expect(lease.signal.aborted).toBe(true)
    expect(h.controller.tabDomain.bodyMountsOf(B).getSnapshot()).toEqual([])
    expect(() => { lease.assertCurrent() }).toThrow('released')
    await Promise.race([
      native.entered,
      disposal.then(() => { throw new Error('Root disposed before native cleanup started') }),
    ])
    expect(done).not.toHaveBeenCalled()
  } finally {
    native.finish()
    await disposal
  }
  await lease.release()
  expect(close).toHaveBeenCalledOnce()
})

it('joins manual delayed close without running native cleanup twice', async () => {
  const h = await fixture()
  const native = gate()
  const close = vi.fn(() => { native.enter(); return native.wait })
  h.controller.registerCloseHandler('prepared', close)
  const lease = await h.port.prepareBody(B, 'prepared', new AbortController().signal, () => {})
  h.controller.closeIn(B, lease.occurrence.tabId)
  expect(lease.signal.aborted).toBe(true)
  const release = lease.release()
  await native.entered
  const done = vi.fn(); void release.then(done)
  expect(done).not.toHaveBeenCalled()
  native.finish()
  await release
  expect(close).toHaveBeenCalledOnce()
})

it('cancels pending preparation when the optional receiver disappears while preserving manual Sidebar navigation', async () => {
  const h = await fixture()
  const publish = gate()
  let target: SidebarRightPreparedBodyTarget | undefined
  const failed = expect(h.port.prepareBody(B, 'prepared', new AbortController().signal, (value) => {
    target = value; publish.enter(); return publish.wait
  })).rejects.toThrow('released')
  await publish.entered
  h.receiver()
  await h.runtime.flush()
  expect(target?.signal.aborted).toBe(true)
  await failed
  expect(h.unregister).toHaveBeenCalledOnce()
  act(() => { h.controller.openTab('prepared') })
  expect(h.controller.active()?.kind).toBe('prepared')
})

it('preserves both reservation and actual cleanup failures', async () => {
  const h = await fixture()
  const primary = new Error('reservation failed')
  const cleanup = new Error('native close failed')
  h.controller.registerCloseHandler('prepared', () => Promise.reject(cleanup))
  const failed = await h.port.prepareBody(B, 'prepared', new AbortController().signal, () => { throw primary }).catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(AggregateError)
  if (!(failed instanceof AggregateError)) throw new Error('expected aggregate failure')
  expect(failed.errors[0]).toBe(primary)
  expect(failed.errors[1]).toBeInstanceOf(AggregateError)
  expect(h.constructed).not.toHaveBeenCalled()
})
