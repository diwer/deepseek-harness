/** Explicit first-body demand follows committed occurrences, never tab IDs alone. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DockController } from '@deepseek-ai/dsh-client-ui-dockkit'
import { TabDomain } from '../src/client/tab-domain.ts'

const SESSION = 'body-one' as SessionId
const OTHER = 'body-two' as SessionId

function harness() {
  const controller = new DockController({
    makeInitialTab: id => ({ id, kind: 'browser', contentId: 'browser://one', title: 'One' }),
    makePaneTab: id => ({ id, kind: 'browser', contentId: 'browser://two', title: 'Two' }),
  })
  const pin = vi.fn()
  const domain = new TabDomain({ openResourceIn() {}, openTabIn() {}, closeIn() {} }, pin)
  const layout = () => controller.getSnapshot().state
  domain.sync(SESSION, layout())
  const tab = Object.values(layout().tabs)[0]
  if (tab === undefined) throw new Error('expected seeded record')
  const occurrence = domain.occurrence(SESSION, tab)
  return { controller, domain, layout, tab, occurrence, pin, source: domain.bodyMountsOf(SESSION) }
}

describe('occurrence-scoped first-body demand', () => {
  it('counts independent requests with stable snapshots and no layout or navigation changes', () => {
    const { domain, layout, occurrence, source } = harness()
    const before = layout()
    const navigation = occurrence.navigation.getSnapshot()
    const changed = vi.fn()
    const unsubscribe = source.subscribe(changed)
    const first = domain.requestBodyMount(occurrence, new AbortController().signal)
    const requested = source.getSnapshot()
    expect(requested).toEqual([occurrence.id])
    expect(JSON.parse(JSON.stringify(requested))).toEqual(requested)
    const second = domain.requestBodyMount(occurrence, new AbortController().signal)
    expect(source.getSnapshot()).toBe(requested)
    first(); first()
    expect(source.getSnapshot()).toBe(requested)
    expect(changed).toHaveBeenCalledTimes(1)
    second(); second()
    expect(source.getSnapshot()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(layout()).toBe(before)
    expect(occurrence.navigation.getSnapshot()).toBe(navigation)
    unsubscribe(); domain.dispose()
  })

  it('releases and detaches both abort listeners when a requester cancels', () => {
    const { domain, occurrence, source } = harness()
    const request = new AbortController()
    const add = vi.spyOn(request.signal, 'addEventListener')
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    const occurrenceRemove = vi.spyOn(occurrence.signal, 'removeEventListener')
    const release = domain.requestBodyMount(occurrence, request.signal)
    const listener = add.mock.calls[0]?.[1]
    request.abort()
    expect(source.getSnapshot()).toEqual([])
    expect(remove).toHaveBeenCalledWith('abort', listener)
    expect(occurrenceRemove).toHaveBeenCalledWith('abort', listener)
    release()
    expect(remove).toHaveBeenCalledTimes(1)
    domain.dispose()
  })

  it('rejects pre-abort, copied targets and navigation-only occurrences without publishing', () => {
    const { domain, controller, layout, occurrence, source } = harness()
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    expect(() => domain.requestBodyMount(occurrence, cancelled.signal)).toThrow('cancelled')
    expect(() => domain.requestBodyMount({ ...occurrence }, new AbortController().signal)).toThrow('live committed')
    const id = controller.openContent({ kind: 'browser', contentId: 'browser://uncommitted', title: 'New' })
    domain.navigate(SESSION, id, { address: 'browser://uncommitted', params: undefined })
    const pending = domain.occurrence(SESSION, { id })
    expect(() => domain.requestBodyMount(pending, new AbortController().signal)).toThrow('live committed')
    expect(source.getSnapshot()).toEqual([])
    domain.sync(SESSION, layout())
    const release = domain.requestBodyMount(pending, new AbortController().signal)
    expect(source.getSnapshot()).toEqual([pending.id])
    release(); domain.dispose()
  })

  it('never transfers a closed occurrence request to an undone close, even before a render', () => {
    const { controller, domain, layout, tab, occurrence, source } = harness()
    const release = domain.requestBodyMount(occurrence, new AbortController().signal)
    controller.closeTab(tab.id)
    domain.sync(SESSION, layout())
    controller.undo()
    domain.sync(SESSION, layout())
    const restored = domain.occurrence(SESSION, tab)
    expect(restored.id).not.toBe(occurrence.id)
    expect(occurrence.signal.aborted).toBe(true)
    expect(source.getSnapshot()).toEqual([])
    expect(() => domain.requestBodyMount(occurrence, new AbortController().signal)).toThrow('live committed')
    const next = domain.requestBodyMount(restored, new AbortController().signal)
    release()
    expect(source.getSnapshot()).toEqual([restored.id])
    next(); domain.dispose()
  })

  it('isolates identical tab IDs across Sessions and leaves a live navigation demand unchanged', () => {
    const { domain, layout, tab, occurrence, source } = harness()
    domain.sync(OTHER, layout())
    const other = domain.occurrence(OTHER, tab)
    const otherSource = domain.bodyMountsOf(OTHER)
    const first = domain.requestBodyMount(occurrence, new AbortController().signal)
    const second = domain.requestBodyMount(other, new AbortController().signal)
    const snapshot = source.getSnapshot()
    domain.navigate(SESSION, tab.id, { address: 'browser://next', params: undefined })
    expect(source.getSnapshot()).toBe(snapshot)
    domain.forgetSession(SESSION)
    expect(occurrence.signal.aborted).toBe(true)
    expect(source.getSnapshot()).toEqual([])
    expect(other.signal.aborted).toBe(false)
    expect(otherSource.getSnapshot()).toEqual([other.id])
    first(); second(); domain.dispose()
  })

  it('rolls back cancellation during synchronous publication', () => {
    const { domain, occurrence, source } = harness()
    const request = new AbortController()
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().length > 0) request.abort(new Error('cancel during publish'))
    })
    expect(() => domain.requestBodyMount(occurrence, request.signal)).toThrow('cancel during publish')
    expect(source.getSnapshot()).toEqual([])
    unsubscribe(); domain.dispose()
  })

  it('abandons a stale reconciliation when demand release disposes the owner', () => {
    const { controller, domain, layout, tab, occurrence, pin, source } = harness()
    const release = domain.requestBodyMount(occurrence, new AbortController().signal)
    const replacement = controller.openContent({ kind: 'browser', contentId: 'browser://replacement', title: 'Replacement' })
    controller.closeTab(tab.id)
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().length === 0) domain.dispose()
    })
    domain.sync(SESSION, layout())
    expect(occurrence.signal.aborted).toBe(true)
    expect(() => domain.occurrence(SESSION, { id: replacement })).toThrow('no committed occurrence')
    expect(pin).toHaveBeenCalledTimes(1)
    release(); unsubscribe(); domain.dispose()
  })

  it.each(['dispose', 'forgetSession'] as const)('stops a pin callback from reviving state after %s', (action) => {
    const { controller, domain, layout, occurrence, pin } = harness()
    const signals: AbortSignal[] = []
    pin.mockImplementation((_address: string, signal: AbortSignal) => {
      signals.push(signal)
      if (action === 'dispose') domain.dispose()
      else domain.forgetSession(SESSION)
    })
    controller.openContent({ kind: 'browser', contentId: 'browser://next', title: 'Next' })
    const last = controller.openContent({ kind: 'browser', contentId: 'browser://last', title: 'Last' })
    domain.sync(SESSION, layout())
    expect(occurrence.signal.aborted).toBe(true)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(() => domain.occurrence(SESSION, { id: last })).toThrow('no committed occurrence')
    domain.dispose()
  })

  it('does not reconcile a reentrant undo against the older close layout', () => {
    const { controller, domain, layout, tab, occurrence, source } = harness()
    const release = domain.requestBodyMount(occurrence, new AbortController().signal)
    let restored = false
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().length > 0 || restored) return
      restored = true
      controller.undo()
      domain.sync(SESSION, layout())
    })
    controller.closeTab(tab.id)
    domain.sync(SESSION, layout())
    const next = domain.occurrence(SESSION, tab)
    expect(next.id).not.toBe(occurrence.id)
    expect(next.signal.aborted).toBe(false)
    expect(source.getSnapshot()).toEqual([])
    release(); unsubscribe(); domain.dispose()
  })

  it('disposes before acknowledgement and cannot revive through late sync or navigation', () => {
    const { domain, layout, tab, occurrence, source } = harness()
    const unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().length > 0) domain.dispose()
    })
    expect(() => domain.requestBodyMount(occurrence, new AbortController().signal)).toThrow('retired during publication')
    expect(source.getSnapshot()).toEqual([])
    expect(occurrence.signal.aborted).toBe(true)
    domain.sync(SESSION, layout())
    domain.navigate(SESSION, tab.id, { address: 'browser://late', params: undefined })
    expect(() => domain.occurrence(SESSION, tab)).toThrow('no committed occurrence')
    domain.dispose(); unsubscribe()
  })
})
