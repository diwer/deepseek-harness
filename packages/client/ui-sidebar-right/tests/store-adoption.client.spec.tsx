// @vitest-environment jsdom
/** Store adoption ownership through the original sidebar and production slot renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { SidebarStoreAdoptions } from '../src/client/store-adoptions.ts'
import { SidebarSessionViews } from '../src/client/session-views.ts'

const SESSION = 's-adoption' as SessionId
const OTHER = 's-other' as SessionId
const runtimes: SlotTestRuntime[] = []
const gates: Array<() => void> = []
let animations: PropertyDescriptor | undefined

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animations)
  }
})

async function mountSidebar() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo } as never)
  runtime.ctx.provide('resources', { pin: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) } as never)
  runtime.slots.installLocale(locale)
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await runtime.sessions.add({ id: SESSION })
  await runtime.sessions.add({ id: OTHER })
  let reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'mainView' })
  const feature = await runtime.mount({ inject: [...inject], apply })
  act(() => {
    runtime.ctx.sidebarRightTabs.register({ id: 'test/page', kind: 'adoption-test', title: () => 'Test' })
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
  const controller = runtime.ctx.sidebarRight
  const store = () => runtime.storeOf('rightbar.session', reference) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
  const select = (id: SessionId): void => {
    const next = runtime.sessions.retainFor(runtime.ctx, id, { source: 'mainView' })
    reference.release()
    reference = next
  }
  const open = () => {
    act(() => { controller.openTab('adoption-test') })
    const tab = controller.active()!
    return controller.tabDomain.occurrence(SESSION, tab)
  }
  return { runtime, feature, controller, view, store, select, open, binding: () => reference.binding }
}

async function preparationSidebar() {
  const adopted = vi.spyOn(SidebarStoreAdoptions.prototype, 'adopt')
  const selected = vi.spyOn(SidebarSessionViews.prototype, 'select')
  const h = await mountSidebar()
  const adoptions = adopted.mock.contexts[0]
  const views = selected.mock.contexts[0]
  if (!(adoptions instanceof SidebarStoreAdoptions)) throw new Error('expected original Store-adoption owner')
  if (!(views instanceof SidebarSessionViews)) throw new Error('expected original Session-view owner')
  const reference = h.runtime.sessions.retainFor(h.runtime.ctx, OTHER, { source: 'testOperation' })
  await reference.ready
  return { ...h, adopted, adoptions, views, reference }
}

describe('actual renderer Store readiness', () => {
  it('waits beyond reference readiness until the original never-selected Session root adopts its Store', async () => {
    const h = await preparationSidebar()
    const lifetime = new AbortController()
    const selected = h.controller.mounted.getSnapshot()
    const input = document.createElement('input')
    h.view.container.append(input)
    input.focus()
    const pending = h.adoptions.wait(h.reference.binding, lifetime.signal)
    const delivered = vi.fn()
    void pending.then(delivered, () => {})
    await h.runtime.flush()
    expect(delivered).not.toHaveBeenCalled()
    expect(h.adopted.mock.calls.some(([binding]) => binding === h.reference.binding)).toBe(false)
    expect(h.view.container.querySelector(`[data-sidebar-right-session="${OTHER}"]`)).toBeNull()
    let hold: ReturnType<SidebarSessionViews['hold']> | undefined
    act(() => { hold = h.views.hold(OTHER, lifetime.signal) })
    const lease = await pending
    lease.assertCurrent()
    expect(lease.binding).toBe(h.reference.binding)
    expect(lease.store).toBe(h.adopted.mock.calls.find(([binding]) => binding === h.reference.binding)?.[1])
    expect(delivered).toHaveBeenCalledOnce()
    expect(h.controller.mounted.getSnapshot()).toBe(selected)
    expect(document.activeElement).toBe(input)
    expect(h.view.container.querySelector<HTMLElement>(`[data-sidebar-right-session="${OTHER}"]`)?.hidden).toBe(true)
    act(() => { hold?.release(); h.reference.release() })
    await h.runtime.flush()
    expect(lease.signal.aborted).toBe(true)
    expect(() => { lease.assertCurrent() }).toThrow()
  })

  it('does not let a cancelled waiter obstruct later actual renderer adoption', async () => {
    const h = await preparationSidebar()
    const cancelled = new AbortController()
    const reason = new Error('preparation cancelled before rendering')
    const rejected = expect(h.adoptions.wait(h.reference.binding, cancelled.signal)).rejects.toBe(reason)
    cancelled.abort(reason)
    await rejected
    let hold: ReturnType<SidebarSessionViews['hold']> | undefined
    const lifetime = new AbortController()
    const pending = h.adoptions.wait(h.reference.binding, lifetime.signal)
    act(() => { hold = h.views.hold(OTHER, lifetime.signal) })
    const lease = await pending
    expect(lease.binding).toBe(h.reference.binding)
    lease.assertCurrent()
    act(() => { hold?.release(); h.reference.release() })
    await h.runtime.flush()
    expect(lease.signal.aborted).toBe(true)
  })

  it('rejects pending background readiness and revokes a delivered foreground lease on feature unload', async () => {
    const h = await preparationSidebar()
    const lifetime = new AbortController()
    const foreground = await h.adoptions.wait(h.binding(), lifetime.signal)
    const rejected = expect(h.adoptions.wait(h.reference.binding, lifetime.signal)).rejects.toThrow('Store adoption owner is disposed')
    await h.feature.dispose()
    await rejected
    expect(foreground.signal.aborted).toBe(true)
    expect(() => { foreground.assertCurrent() }).toThrow('Store adoption owner is disposed')
    expect(h.reference.binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Store adoption wait')).toHaveLength(0)
  })
})

describe('sidebar Store adoption ownership', () => {
  it('withdraws a released generation before any replacement Store is created', async () => {
    const h = await mountSidebar()
    const binding = h.binding()
    const oldStore = h.store()
    const occurrence = h.open()
    expect(h.view.container.querySelector('[data-slot="rightbar.session"]')).not.toBeNull()
    act(() => { h.select(OTHER) })
    await h.runtime.flush()
    expect(h.runtime.sessions.binding(SESSION)).toBeUndefined()
    expect(occurrence.signal.aborted).toBe(true)
    expect(h.controller.tabsIn(SESSION)).toEqual([])
    expect(binding.ctx.fiber.getEffects().some(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toBe(false)
    const inventory = h.controller.openTabs.getSnapshot()
    act(() => { oldStore.actions.duplicateTab(SESSION, occurrence.tabId) })
    expect(h.controller.openTabs.getSnapshot()).toBe(inventory)
    act(() => { h.select(SESSION) })
    await h.runtime.flush()
    expect(h.binding()).not.toBe(binding)
    expect(h.store()).not.toBe(oldStore)
    const restored = h.controller.tabsIn(SESSION).find(tab => tab.id === occurrence.tabId)!
    expect(h.controller.tabDomain.occurrence(SESSION, restored).signal.aborted).toBe(false)
  })

  it('keeps the replacement adoption when old-generation teardown finishes late', async () => {
    const h = await mountSidebar()
    const oldBinding = h.binding()
    const oldStore = h.store()
    const oldOccurrence = h.open()
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    gates.push(() => { finish.resolve(undefined) })
    oldBinding.ctx.effect(() => async () => { entered.resolve(undefined); await finish.promise }, 'test: hold old-generation teardown')
    act(() => { h.select(OTHER) })
    await entered.promise
    const other = h.runtime.sessions.retain(OTHER)
    await other.ready
    other.release()
    expect(h.runtime.sessions.binding(SESSION)).toBeUndefined()
    act(() => { h.select(SESSION) })
    const replacement = h.binding()
    const replacementStore = h.store()
    expect(replacement).not.toBe(oldBinding)
    expect(replacementStore).not.toBe(oldStore)
    expect(oldOccurrence.signal.aborted).toBe(true)
    const restored = h.controller.tabsIn(SESSION).find(tab => tab.id === oldOccurrence.tabId)!
    const occurrence = h.controller.tabDomain.occurrence(SESSION, restored)
    finish.resolve(undefined)
    await h.runtime.flush()
    expect(h.runtime.sessions.binding(SESSION)).toBe(replacement)
    expect(occurrence.signal.aborted).toBe(false)
    act(() => { h.controller.closeIn(SESSION, restored.id) })
    expect(occurrence.signal.aborted).toBe(true)
  })

  it('unregisters generation callbacks and subscriptions on feature unload', async () => {
    const h = await mountSidebar()
    const binding = h.binding()
    const instance = h.store()
    const occurrence = h.open()
    expect(binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toHaveLength(1)
    await h.feature.dispose()
    await h.feature.dispose()
    expect(h.runtime.sessions.binding(SESSION)).toBe(binding)
    expect(binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toEqual([])
    expect(occurrence.signal.aborted).toBe(true)
    expect(h.controller.tabsIn(SESSION)).toEqual([])
    const inventory = h.controller.openTabs.getSnapshot()
    act(() => { instance.actions.duplicateTab(SESSION, occurrence.tabId) })
    expect(h.controller.openTabs.getSnapshot()).toBe(inventory)
  })

  it('releases a withdrawal returned after synchronous owner shutdown exactly once', async () => {
    const h = await mountSidebar()
    const withdraw = vi.fn()
    const owner = new SidebarStoreAdoptions(() => { owner.dispose(); return withdraw })
    act(() => { owner.adopt(h.binding(), h.store()) })
    owner.dispose()
    expect(withdraw).toHaveBeenCalledOnce()
    expect(h.binding().ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toHaveLength(1)
  })

  it('keeps a reentrant replacement created while the previous adoption is withdrawing', async () => {
    const h = await mountSidebar()
    const binding = h.binding()
    const store = h.store()
    const withdraw = vi.fn()
    const previous = vi.fn(() => { owner.adopt(binding, store) })
    const adopt = vi.fn(() => withdraw).mockReturnValueOnce(previous)
    const owner = new SidebarStoreAdoptions(adopt)
    try {
      owner.adopt(binding, store)
      owner.adopt(binding, store)
      expect(previous).toHaveBeenCalledOnce()
      expect(adopt).toHaveBeenCalledTimes(2)
      expect(withdraw).not.toHaveBeenCalled()
      expect(binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toHaveLength(2)
    } finally {
      owner.dispose()
    }
    expect(withdraw).toHaveBeenCalledOnce()
  })

  it('rolls back generation callbacks after adoption setup throws', async () => {
    const h = await mountSidebar()
    const failure = new Error('test adoption failure')
    const owner = new SidebarStoreAdoptions(() => { throw failure })
    expect(() => { owner.adopt(h.binding(), h.store()) }).toThrow(failure)
    expect(h.binding().ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')).toHaveLength(1)
    owner.dispose()
  })
})
