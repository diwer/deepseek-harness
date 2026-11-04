// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { SidebarSessionView } from '../src/client/session-view.ts'
import { SidebarSessionViews } from '../src/client/session-views.ts'

const A = 'a' as SessionId
const B = 'b' as SessionId
const TAB = 'tab' as TabId
const runtimes: SlotTestRuntime[] = []
const owners: { dispose(): void }[] = []

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
})

async function runtime() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.sessions.add({ id: A })
  await runtime.sessions.add({ id: B })
  return runtime
}

it('keeps one reference per View until the final committed root of a retired View unmounts', async () => {
  const r = await runtime()
  const disposed = vi.fn()
  const changed = vi.fn()
  const view = new SidebarSessionView(A, r.sessions, disposed, changed)
  owners.push(view)
  await view.reference.ready
  const release = vi.spyOn(view.reference, 'release')
  const firstMount = view.mount()
  const secondMount = view.mount()
  const first = new AbortController()
  const second = new AbortController()
  const firstHold = view.retainTab(TAB, first.signal)
  const secondHold = view.retainTab(TAB, second.signal)
  firstHold()
  firstHold()
  expect(view.hasRetainedTabs).toBe(true)
  expect(changed).toHaveBeenCalledOnce()
  second.abort()
  secondHold()
  expect(view.hasRetainedTabs).toBe(false)
  view.retainTab(TAB, second.signal)()
  view.retire()
  firstMount()
  expect(release).not.toHaveBeenCalled()
  secondMount()
  expect(release).toHaveBeenCalledOnce()
  view.retainTab(TAB, first.signal)()
  view.dispose()
  expect(disposed).toHaveBeenCalledExactlyOnceWith(view)
})

it('retires only unselected Views without retained bodies and rejects released reference identities', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  views.select(A)
  const first = views.source.getSnapshot()
  const a = first[0]!
  views.select(A)
  expect(views.source.getSnapshot()).toBe(first)
  const unmount = views.mount(a.reference)
  const lifetime = new AbortController()
  const release = vi.spyOn(a.reference, 'release')
  a.retainTab(TAB, lifetime.signal)
  views.select(B)
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[A, false], [B, true]])
  lifetime.abort()
  expect(views.source.getSnapshot().map(view => view.sessionId)).toEqual([B])
  expect(release).not.toHaveBeenCalled()
  unmount()
  expect(release).toHaveBeenCalledOnce()
  expect(() => views.mount(a.reference)).toThrow('no longer owned')
  views.select(undefined)
  expect(views.source.getSnapshot()).toEqual([])
  views.dispose()
  views.select(A)
  views.mount(a.reference)()
  expect(views.source.getSnapshot()).toEqual([])
})

it('reports opening failure and releases Views even when committed roots are still present', async () => {
  const r = await runtime()
  const reference = r.sessions.retain(A, { source: 'sidebarView' })
  const failure = new Error('opening failed')
  const release = vi.fn(() => { reference.release() })
  vi.spyOn(r.sessions, 'retain').mockReturnValueOnce({
    sessionId: reference.sessionId,
    get binding() { return reference.binding },
    ready: Promise.reject(failure),
    release,
    [Symbol.dispose]: () => { reference.release() },
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  views.select(A)
  const view = views.source.getSnapshot()[0]!
  const unmount = views.mount(view.reference)
  await expect(view.reference.ready).rejects.toBe(failure)
  expect(error).toHaveBeenCalledWith('Sidebar Session opening failed:', failure)
  views.dispose()
  expect(release).toHaveBeenCalledOnce()
  unmount()
  expect(release).toHaveBeenCalledOnce()
})

function trackRetains(r: SlotTestRuntime, afterRetain?: () => void) {
  const retain = r.sessions.retain.bind(r.sessions)
  const allocated: { reference: ReturnType<typeof retain>; release: () => void }[] = []
  const calls = vi.spyOn(r.sessions, 'retain').mockImplementation((target, options) => {
    const reference = retain(target, options)
    allocated.push({ reference, release: vi.spyOn(reference, 'release') })
    afterRetain?.()
    return reference
  })
  return { allocated, calls }
}

it('rejects pre-aborted holds before allocating and checks abort before a disposed owner', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const retain = vi.spyOn(r.sessions, 'retain')
  const lifetime = new AbortController()
  const reason = new Error('background demand cancelled')
  lifetime.abort(reason)
  const empty = views.source.getSnapshot()

  expect(() => views.hold(A, lifetime.signal)).toThrow(reason)
  expect(views.source.getSnapshot()).toBe(empty)
  expect(retain).not.toHaveBeenCalled()

  views.dispose()
  expect(() => views.hold(A, lifetime.signal)).toThrow(reason)
  expect(() => views.hold(B, new AbortController().signal)).toThrow('Sidebar Session views are disposed')
  expect(retain).not.toHaveBeenCalled()
  expect(views.source.getSnapshot()).toEqual([])
})

it('holds background Views without selecting them until the final demand and committed root release', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  views.select(A)
  const foreground = views.source.getSnapshot()[0]!
  await foreground.reference.ready
  const retain = vi.spyOn(r.sessions, 'retain')
  const first = new AbortController()
  const second = new AbortController()
  const firstHold = views.hold(B, first.signal)
  const backgroundSnapshot = views.source.getSnapshot()
  const secondHold = views.hold(B, second.signal)
  expect(views.source.getSnapshot()).toBe(backgroundSnapshot)
  await firstHold.reference.ready
  const release = vi.spyOn(firstHold.reference, 'release')
  const firstUnmount = views.mount(firstHold.reference)
  const secondUnmount = views.mount(secondHold.reference)

  expect(secondHold.reference).toBe(firstHold.reference)
  expect(retain).toHaveBeenCalledExactlyOnceWith(B, { source: 'sidebarView' })
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[A, true], [B, false]])
  expect(views.source.getSnapshot()[0]!.reference).toBe(foreground.reference)

  firstHold.release()
  firstHold.release()
  first.abort()
  expect(views.source.getSnapshot()).toBe(backgroundSnapshot)
  expect(views.source.getSnapshot().map(view => view.sessionId)).toEqual([A, B])
  expect(release).not.toHaveBeenCalled()
  second.abort()
  secondHold.release()
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[A, true]])
  expect(release).not.toHaveBeenCalled()
  firstUnmount()
  expect(release).not.toHaveBeenCalled()
  secondUnmount()
  expect(release).toHaveBeenCalledOnce()
  expect(() => views.mount(firstHold.reference)).toThrow('no longer owned')
})

it.each(['hold', 'tab'] as const)('keeps background holds independent of retained bodies when %s releases first', async (first) => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetime = new AbortController()
  const tabLifetime = new AbortController()
  const hold = views.hold(B, lifetime.signal)
  await hold.reference.ready
  const view = views.source.getSnapshot()[0]!
  const releaseTab = view.retainTab(TAB, tabLifetime.signal)
  const referenceRelease = hold.reference.release.bind(hold.reference)
  const withdrawnAtRelease: SessionId[][] = []
  const release = vi.spyOn(hold.reference, 'release').mockImplementation(() => {
    withdrawnAtRelease.push(views.source.getSnapshot().map(current => current.sessionId))
    referenceRelease()
  })

  if (first === 'hold') hold.release()
  else tabLifetime.abort()
  expect(views.source.getSnapshot().map(current => [current.sessionId, current.selected])).toEqual([[B, false]])
  expect(views.source.getSnapshot()[0]!.reference).toBe(hold.reference)
  expect(release).not.toHaveBeenCalled()

  if (first === 'hold') tabLifetime.abort()
  else hold.release()
  expect(views.source.getSnapshot()).toEqual([])
  expect(withdrawnAtRelease).toEqual([[]])
  expect(release).toHaveBeenCalledOnce()
  releaseTab()
  hold.release()
  lifetime.abort()
  expect(release).toHaveBeenCalledOnce()
})

it('reuses a held reference across foreground changes and preserves a selected View after its hold releases', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const retain = vi.spyOn(r.sessions, 'retain')
  const hold = views.hold(B, new AbortController().signal)
  await hold.reference.ready
  const release = vi.spyOn(hold.reference, 'release')

  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[B, false]])
  views.select(B)
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[B, true]])
  const foregroundSnapshot = views.source.getSnapshot()
  const foregroundHold = views.hold(B, new AbortController().signal)
  expect(foregroundHold.reference).toBe(hold.reference)
  expect(views.source.getSnapshot()).toBe(foregroundSnapshot)
  foregroundHold.release()
  expect(views.source.getSnapshot()).toBe(foregroundSnapshot)
  views.select(undefined)
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[B, false]])
  expect(views.source.getSnapshot()[0]!.reference).toBe(hold.reference)
  views.select(B)
  hold.release()
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[B, true]])
  expect(release).not.toHaveBeenCalled()
  expect(retain).toHaveBeenCalledExactlyOnceWith(B, { source: 'sidebarView' })
  views.select(undefined)
  expect(views.source.getSnapshot()).toEqual([])
  expect(release).toHaveBeenCalledOnce()
})

it('allocates a new reference after cancellation while the retired committed root finishes independently', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const retain = vi.spyOn(r.sessions, 'retain')
  const first = new AbortController()
  const oldHold = views.hold(B, first.signal)
  await oldHold.reference.ready
  const oldRelease = vi.spyOn(oldHold.reference, 'release')
  const unmountOld = views.mount(oldHold.reference)
  first.abort()
  expect(views.source.getSnapshot()).toEqual([])
  expect(oldRelease).not.toHaveBeenCalled()

  const second = new AbortController()
  const newHold = views.hold(B, second.signal)
  await newHold.reference.ready
  const newRelease = vi.spyOn(newHold.reference, 'release')
  expect(newHold.reference).not.toBe(oldHold.reference)
  expect(retain).toHaveBeenCalledTimes(2)
  expect(views.source.getSnapshot()[0]!.reference).toBe(newHold.reference)
  oldHold.release()
  unmountOld()
  expect(oldRelease).toHaveBeenCalledOnce()
  expect(newRelease).not.toHaveBeenCalled()
  expect(views.source.getSnapshot()[0]!.reference).toBe(newHold.reference)
  expect(() => newHold.reference.binding).not.toThrow()
  expect(() => views.mount(oldHold.reference)).toThrow('no longer owned')

  newHold.release()
  second.abort()
  expect(views.source.getSnapshot()).toEqual([])
  expect(newRelease).toHaveBeenCalledOnce()
})

it('disposes every held reference and abort subscription without reviving Views during later cleanup', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetimes = [new AbortController(), new AbortController(), new AbortController()]
  const listeners = lifetimes.map(({ signal }) => ({
    added: vi.spyOn(signal, 'addEventListener'),
    removed: vi.spyOn(signal, 'removeEventListener'),
  }))
  const first = views.hold(A, lifetimes[0]!.signal)
  const second = views.hold(A, lifetimes[1]!.signal)
  const third = views.hold(B, lifetimes[2]!.signal)
  await Promise.all([first.reference.ready, third.reference.ready])
  const firstRelease = vi.spyOn(first.reference, 'release')
  const thirdRelease = vi.spyOn(third.reference, 'release')
  const unmountFirst = views.mount(first.reference)
  const unmountThird = views.mount(third.reference)
  expect(second.reference).toBe(first.reference)
  const abortListeners = listeners.map(({ added }) => added.mock.calls.find(([type]) => type === 'abort')?.[1])
  for (const listener of abortListeners) expect(listener).toBeDefined()

  views.dispose()
  expect(views.source.getSnapshot()).toEqual([])
  expect(firstRelease).toHaveBeenCalledOnce()
  expect(thirdRelease).toHaveBeenCalledOnce()
  listeners.forEach(({ removed }, index) => {
    expect(removed.mock.calls.some(([type, listener]) => type === 'abort' && listener === abortListeners[index])).toBe(true)
  })
  expect(() => {
    first.release()
    second.release()
    third.release()
    for (const lifetime of lifetimes) lifetime.abort()
    unmountFirst()
    unmountThird()
    views.dispose()
  }).not.toThrow()
  expect(views.source.getSnapshot()).toEqual([])
  expect(firstRelease).toHaveBeenCalledOnce()
  expect(thirdRelease).toHaveBeenCalledOnce()
  expect(() => views.hold(A, new AbortController().signal)).toThrow('Sidebar Session views are disposed')
})

it('establishes demand before publishing and withdraws it when a synchronous subscriber aborts', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  views.select(A)
  await views.source.getSnapshot()[0]!.reference.ready
  const { allocated } = trackRetains(r)
  const lifetime = new AbortController()
  const reason = new Error('cancelled by source subscriber')
  let entered = false
  let heldDuringSelection: SessionId[] | undefined
  let remainingAfterAbort: SessionId[] | undefined
  const unsubscribe = views.source.subscribe(() => {
    if (entered || !views.source.getSnapshot().some(view => view.sessionId === B)) return
    entered = true
    views.select(undefined)
    heldDuringSelection = views.source.getSnapshot().map(view => view.sessionId)
    lifetime.abort(reason)
    remainingAfterAbort = views.source.getSnapshot().map(view => view.sessionId)
  })
  owners.push({ dispose: unsubscribe })

  expect(() => views.hold(B, lifetime.signal)).toThrow(reason)
  expect(entered).toBe(true)
  expect(heldDuringSelection).toEqual([B])
  expect(remainingAfterAbort).toEqual([])
  expect(views.source.getSnapshot()).toEqual([])
  expect(allocated).toHaveLength(1)
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
  expect(() => allocated[0]!.reference.binding).toThrow('released')
})

it('releases a newly allocated reference when its signal aborts synchronously inside retain', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetime = new AbortController()
  const reason = new Error('cancelled during Session retain')
  const { allocated, calls } = trackRetains(r, () => { lifetime.abort(reason) })

  expect(() => views.hold(B, lifetime.signal)).toThrow(reason)
  expect(calls).toHaveBeenCalledExactlyOnceWith(B, { source: 'sidebarView' })
  expect(allocated).toHaveLength(1)
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
  expect(() => allocated[0]!.reference.binding).toThrow('released')
  expect(views.source.getSnapshot()).toEqual([])
  views.dispose()
  lifetime.abort()
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
})

it('rejects synchronous same-Session reentry from retention observers without allocating a second View', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const retention = r.sessions.retainInfo(B)
  let entered = false
  let reentrantError: unknown
  const unsubscribe = retention.subscribe(() => {
    if (entered || retention.getSnapshot().referenceCount === 0) return
    entered = true
    try {
      views.hold(B, new AbortController().signal)
    } catch (error) {
      reentrantError = error
    }
  })
  owners.push({ dispose: unsubscribe })

  const hold = views.hold(B, new AbortController().signal)
  await hold.reference.ready
  expect(entered).toBe(true)
  expect(retention.getSnapshot().retainedBy.sidebarView).toBe(1)
  expect(reentrantError).toMatchObject({ message: 'Sidebar Session view allocation is already in progress' })
  expect(views.source.getSnapshot().map(view => view.reference)).toEqual([hold.reference])
  hold.release()
  expect(retention.getSnapshot().referenceCount).toBe(0)
  expect(views.source.getSnapshot()).toEqual([])

  const retry = views.hold(B, new AbortController().signal)
  await retry.reference.ready
  expect(retry.reference).not.toBe(hold.reference)
  expect(retention.getSnapshot().retainedBy.sidebarView).toBe(1)
  retry.release()
  expect(retention.getSnapshot().referenceCount).toBe(0)
})

it('clears the allocation guard when Session retain throws so a later demand can retry', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const failure = new Error('Session allocation failed')
  vi.spyOn(r.sessions, 'retain').mockImplementationOnce(() => { throw failure })

  expect(() => views.hold(B, new AbortController().signal)).toThrow(failure)
  expect(views.source.getSnapshot()).toEqual([])
  expect(r.sessions.retainInfo(B).getSnapshot().referenceCount).toBe(0)
  const retry = views.hold(B, new AbortController().signal)
  await retry.reference.ready
  retry.release()
  expect(r.sessions.retainInfo(B).getSnapshot().referenceCount).toBe(0)
})

it('releases a newly allocated reference if Session retain synchronously disposes its view owner', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetime = new AbortController()
  const { allocated } = trackRetains(r, () => { views.dispose() })

  expect(() => views.hold(B, lifetime.signal)).toThrow('Sidebar Session views are disposed')
  expect(views.source.getSnapshot()).toEqual([])
  expect(allocated).toHaveLength(1)
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
  expect(() => allocated[0]!.reference.binding).toThrow('released')
  expect(r.sessions.retainInfo(B).getSnapshot().referenceCount).toBe(0)
  lifetime.abort()
  views.dispose()
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
})

it('rejects a hold when publication synchronously disposes the owner without aborting its signal', async () => {
  const r = await runtime()
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetime = new AbortController()
  const { allocated } = trackRetains(r)
  const unsubscribe = views.source.subscribe(() => {
    if (views.source.getSnapshot().length > 0) views.dispose()
  })
  owners.push({ dispose: unsubscribe })

  expect(() => views.hold(B, lifetime.signal)).toThrow('Sidebar Session views are disposed')
  expect(lifetime.signal.aborted).toBe(false)
  expect(views.source.getSnapshot()).toEqual([])
  expect(allocated).toHaveLength(1)
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
  expect(() => allocated[0]!.reference.binding).toThrow('released')
  lifetime.abort()
  expect(allocated[0]!.release).toHaveBeenCalledOnce()
  expect(views.source.getSnapshot()).toEqual([])
})

it('retires a failed opening only after its caller releases demand and committed roots unmount', async () => {
  const r = await runtime()
  const reference = r.sessions.retain(B, { source: 'sidebarView' })
  await reference.ready
  const failure = new Error('background Session opening failed')
  const release = vi.fn(() => { reference.release() })
  vi.spyOn(r.sessions, 'retain').mockReturnValueOnce({
    sessionId: reference.sessionId,
    get binding() { return reference.binding },
    ready: Promise.reject(failure),
    release,
    [Symbol.dispose]: () => { reference.release() },
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const views = new SidebarSessionViews(r.sessions)
  owners.push(views)
  const lifetime = new AbortController()
  const hold = views.hold(B, lifetime.signal)
  const firstUnmount = views.mount(hold.reference)
  const secondUnmount = views.mount(hold.reference)

  await expect(hold.reference.ready).rejects.toBe(failure)
  expect(error).toHaveBeenCalledWith('Sidebar Session opening failed:', failure)
  expect(views.source.getSnapshot().map(view => [view.sessionId, view.selected])).toEqual([[B, false]])
  expect(release).not.toHaveBeenCalled()
  hold.release()
  expect(views.source.getSnapshot()).toEqual([])
  expect(release).not.toHaveBeenCalled()
  firstUnmount()
  expect(release).not.toHaveBeenCalled()
  secondUnmount()
  expect(release).toHaveBeenCalledOnce()
  expect(() => reference.binding).toThrow('released')
  lifetime.abort()
  hold.release()
  expect(release).toHaveBeenCalledOnce()
})
