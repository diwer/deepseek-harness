import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopBrowserLeaseId,
  DesktopBrowserTaskCancel,
  DesktopBrowserTaskCommand,
  DesktopBrowserTaskRequest,
  DesktopBrowserTaskResult,
  DesktopBrowserTaskScope,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { BrowserTaskChannel } from '../src/browser-task-channel.ts'

const lease = '00000000-0000-4000-8000-000000000001' as DesktopBrowserLeaseId
const otherLease = '00000000-0000-4000-8000-000000000002' as DesktopBrowserLeaseId

const scope: DesktopBrowserTaskScope = {
  runEpoch: 'run', providerEpoch: 'provider', agentEpoch: 'agent', taskId: 'task', taskEpoch: 'task-epoch', sessionId: 'session',
}

function fixture(send?: (message: DesktopBrowserTaskRequest | DesktopBrowserTaskCancel) => Promise<void>) {
  const messages: (DesktopBrowserTaskRequest | DesktopBrowserTaskCancel)[] = []
  const failures: Error[] = []
  const channel = new BrowserTaskChannel('run', {
    send: (message) => { messages.push(message); return send?.(message) ?? Promise.resolve() },
    onFailure: error => failures.push(error),
  })
  const signal = new AbortController()
  const request = (command: DesktopBrowserTaskCommand = { action: 'prepare' }, metadata = scope) => channel.request(metadata,
    command, { signal: signal.signal, deadlineAt: Date.now() + 1000 })
  const reply = (value: DesktopBrowserTaskResult | object, id = 1, metadata: object = scope) => channel.receive({
    type: 'browser-task/reply', direction: 'main-to-host', requestId: id, scope: metadata, outcome: { kind: 'result', value },
  })
  const ack = (id = 1, error?: string) => channel.receive({
    type: 'browser-task/cancelled', direction: 'main-to-host', requestId: id, scope, ...(error === undefined ? {} : { error }),
  })
  return { channel, messages, failures, signal, request, reply, ack }
}

const channels: BrowserTaskChannel[] = []
function tracked(send?: (message: DesktopBrowserTaskRequest | DesktopBrowserTaskCancel) => Promise<void>) {
  const test = fixture(send)
  channels.push(test.channel)
  return test
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.disconnect(new Error('fixture ended'))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Host-private Browser task channel', () => {
  it('reserves requests before synchronous delivery reenters with a reply', async () => {
    let receive: (message: unknown) => boolean = () => false
    const test = tracked(async (message) => {
      if (message.type === 'browser-task/request') expect(receive({
        type: 'browser-task/reply', direction: 'main-to-host', requestId: message.requestId, scope: message.scope,
        outcome: { kind: 'result', value: { action: 'prepared', lease } },
      })).toBe(true)
    })
    receive = message => test.channel.receive(message)
    await expect(test.request()).resolves.toEqual({ action: 'prepared', lease })
    expect(test.reply({ action: 'prepared', lease: otherLease })).toBe(false)
    expect(test.failures).toEqual([])
  })

  it('allocates strictly increasing IDs and matches concurrent replies independently', async () => {
    const test = tracked()
    const first = test.request()
    const second = test.request({ action: 'screenshot', lease })
    expect(test.messages.map(message => message.requestId)).toEqual([1, 2])
    test.reply({ action: 'screenshot', png: 'bytes' }, 2)
    test.reply({ action: 'prepared', lease })
    await expect(first).resolves.toEqual({ action: 'prepared', lease })
    await expect(second).resolves.toEqual({ action: 'screenshot', png: 'bytes' })
  })

  it.each(['runEpoch', 'providerEpoch', 'agentEpoch', 'taskId', 'taskEpoch', 'sessionId'] as const)(
    'ignores a reply with a foreign %s', async (field) => {
      const test = tracked()
      const pending = test.request()
      expect(test.reply({ action: 'prepared', lease: otherLease }, 1, { ...scope, [field]: 'foreign' })).toBe(false)
      test.reply({ action: 'prepared', lease })
      await expect(pending).resolves.toEqual({ action: 'prepared', lease })
    },
  )

  it('rejects another local run before sending and rejects invalid deadlines', async () => {
    const test = tracked()
    await expect(test.request({ action: 'prepare' }, { ...scope, runEpoch: 'foreign' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    for (const deadlineAt of [Date.now() - 1, Date.now() + 31_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(test.channel.request(scope, { action: 'prepare' }, { signal: test.signal.signal, deadlineAt }))
        .rejects.toMatchObject({ code: 'INVALID_DEADLINE' })
    }
    expect(test.messages).toEqual([])
  })

  it.each([
    null,
    { type: 'browser-task/reply', direction: 'host-to-main', requestId: 1, scope },
    { type: 'browser-task/reply', direction: 'main-to-host', requestId: 0, scope },
    { type: 'browser-task/reply', direction: 'main-to-host', requestId: 1.5, scope },
    { type: 'browser-task/reply', direction: 'main-to-host', requestId: 2, scope },
  ])('ignores malformed or uncorrelated message %j', async (message) => {
    const test = tracked()
    const pending = test.request()
    expect(test.channel.receive(message)).toBe(false)
    test.reply({ action: 'prepared', lease })
    await pending
  })

  it('does not admit an already aborted caller', async () => {
    const test = tracked()
    test.signal.abort('cancelled')
    await expect(test.request()).rejects.toMatchObject({ code: 'ABORTED', cause: 'cancelled' })
    expect(test.messages).toEqual([])
  })

  it('holds aborted work until the separate cleanup ACK, ignoring late normal success', async () => {
    const test = tracked()
    const pending = test.request()
    let settled = false
    const rejected = expect(pending.finally(() => { settled = true })).rejects.toMatchObject({ code: 'ABORTED' })
    test.signal.abort()
    expect(test.messages.at(-1)).toMatchObject({ type: 'browser-task/cancel', requestId: 1, scope })
    expect(test.reply({ action: 'prepared', lease })).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    test.ack()
    await rejected
    expect(test.ack()).toBe(false)
    await expect(test.channel.retire(scope)).resolves.toBeUndefined()
  })

  it('retains successful metadata so explicit retirement reclaims a result revoked after reply', async () => {
    const test = tracked()
    const pending = test.request()
    test.reply({ action: 'prepared', lease })
    await pending
    test.signal.abort()
    expect(test.messages).toHaveLength(1)
    const retiring = test.channel.retire(scope)
    let drained = false
    void retiring.then(() => { drained = true })
    expect(test.messages.at(-1)).toMatchObject({ type: 'browser-task/cancel', requestId: 1 })
    expect(test.reply({ action: 'prepared', lease: otherLease })).toBe(false)
    await Promise.resolve()
    expect(drained).toBe(false)
    test.ack()
    await retiring
    await expect(test.channel.request(scope, { action: 'prepare' }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
    })).rejects.toMatchObject({ code: 'RETIRED' })
  })

  it('retiring any request holds every admitted request of that task until one ACK', async () => {
    const test = tracked()
    const first = test.request()
    const second = test.request()
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'ABORTED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'ABORTED' })
    // Different caller signals are not needed for this test: retirement removes both listeners before the abort dispatch continues.
    test.signal.abort()
    expect(test.messages.filter(message => message.type === 'browser-task/cancel')).toHaveLength(1)
    test.reply({ action: 'prepared', lease })
    test.reply({ action: 'prepared', lease }, 2)
    test.ack(2)
    await firstRejected
    await secondRejected
  })

  it('ignores foreign cancellation acknowledgements', async () => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    test.signal.abort()
    expect(test.channel.receive({ type: 'browser-task/cancelled', direction: 'main-to-host', requestId: 1,
      scope: { ...scope, taskEpoch: 'stale' } })).toBe(false)
    test.ack()
    await rejected
  })

  it('reports failed native cleanup without treating it as a successful drain', async () => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const retired = test.channel.retire(scope)
    const cleanupRejected = expect(retired).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    test.ack(1, 'guest destruction failed')
    await rejected
    await cleanupRejected
    expect(test.failures).toEqual([expect.objectContaining({ code: 'CANCEL_FAILED' })])
    await expect(test.channel.close()).rejects.toBe(test.failures[0])
  })

  it.each([
    { action: 'navigated', url: 'https://wrong-action.test' },
    { action: 'prepared', lease: 'not-a-uuid' },
    { action: 'prepared', lease: '00000000-0000-4000-0000-000000000001' },
    { action: 'prepared', lease: '' },
    { action: 'prepared', lease: 1 },
  ])('retires malformed or mismatched results %j', async (value) => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(test.reply(value)).toBe(true)
    expect(test.messages.at(-1)?.type).toBe('browser-task/cancel')
    test.ack()
    await rejected
    expect(test.failures).toEqual([expect.objectContaining({ code: 'PROTOCOL_ERROR' })])
  })

  it('propagates correlated Main errors and preserves metadata for cleanup', async () => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'REMOTE_ERROR', message: 'not prepared' })
    expect(test.channel.receive({ type: 'browser-task/reply', direction: 'main-to-host', requestId: 1, scope,
      outcome: { kind: 'error', message: 'not prepared' } })).toBe(true)
    await rejected
    const retired = test.channel.retire(scope)
    test.ack()
    await retired
  })

  it('converts a deadline to cancellation and waits beyond that deadline for native drainage', async () => {
    vi.useFakeTimers()
    const test = tracked()
    const pending = test.request()
    let settled = false
    const rejected = expect(pending.finally(() => { settled = true })).rejects.toMatchObject({ code: 'DEADLINE' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(test.messages.at(-1)?.type).toBe('browser-task/cancel')
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    test.ack()
    await rejected
  })

  it('detaches timers and abort listeners after normal results', async () => {
    vi.useFakeTimers()
    const test = tracked()
    const removed = vi.spyOn(test.signal.signal, 'removeEventListener')
    const pending = test.request()
    test.reply({ action: 'prepared', lease })
    await pending
    expect(vi.getTimerCount()).toBe(0)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    await vi.advanceTimersByTimeAsync(2000)
    test.signal.abort()
    expect(test.messages).toHaveLength(1)
    removed.mockRestore()
  })

  it('stops admission synchronously on close and waits for actual cleanup', async () => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RETIRED' })
    const closing = test.channel.close()
    expect(test.channel.close()).toBe(closing)
    await expect(test.request()).rejects.toMatchObject({ code: 'CLOSED' })
    test.reply({ action: 'prepared', lease })
    test.ack()
    await rejected
    await closing
  })

  it('reserves close before synchronous cancellation delivery reenters it', async () => {
    let nested: Promise<void> | undefined
    const test = tracked(async (message) => {
      if (message.type !== 'browser-task/cancel') return
      nested = test.channel.close()
      test.channel.receive({ type: 'browser-task/cancelled', direction: 'main-to-host', requestId: message.requestId, scope })
    })
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RETIRED' })
    const closing = test.channel.close()
    expect(nested).toBe(closing)
    await rejected
    await closing
  })

  it('joins every task cleanup even when another task reports failed cancellation', async () => {
    const test = tracked()
    const first = test.request()
    const otherScope = { ...scope, taskId: 'other' }
    const second = test.request({ action: 'prepare' }, otherScope)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'RETIRED' })
    let settled = false
    const closing = test.channel.close()
    const closeRejected = expect(closing.finally(() => { settled = true })).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    test.ack(1, 'failed')
    await firstRejected
    expect(settled).toBe(false)
    test.channel.receive({ type: 'browser-task/cancelled', direction: 'main-to-host', requestId: 2, scope: otherScope })
    await secondRejected
    await closeRejected
  })

  it('keeps close pending until previously admitted IPC sends finish', async () => {
    const delivery = Promise.withResolvers<undefined>()
    const test = tracked(message => message.type === 'browser-task/request' ? delivery.promise : Promise.resolve())
    const pending = test.request()
    test.reply({ action: 'prepared', lease })
    await pending
    let closed = false
    const closing = test.channel.close().then(() => { closed = true })
    test.ack()
    await Promise.resolve()
    expect(closed).toBe(false)
    delivery.resolve(undefined)
    await closing
  })

  it('joins a held send when close starts after disconnection', async () => {
    vi.useFakeTimers()
    const delivery = Promise.withResolvers<undefined>()
    const test = tracked(() => delivery.promise)
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    test.channel.disconnect(new Error('IPC lost'))
    let settled = false
    const closing = test.channel.close()
    const outcome = closing.catch((error: unknown) => { settled = true; return error })
    try {
      await rejected
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      delivery.resolve(undefined)
      expect(await outcome).toBe(test.failures[0])
    } finally { delivery.resolve(undefined); await outcome }
  })

  it('retains every failed cancellation in joined close', async () => {
    const test = tracked()
    const otherScope = { ...scope, taskId: 'other' }
    const first = test.request()
    const second = test.request({ action: 'prepare' }, otherScope)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const closing = test.channel.close()
    const outcome = closing.catch((error: unknown) => error)
    test.ack(1, 'first native cleanup failed')
    test.channel.receive({ type: 'browser-task/cancelled', direction: 'main-to-host', requestId: 2,
      scope: otherScope, error: 'second native cleanup failed' })
    await Promise.all([firstRejected, secondRejected])
    expect(await outcome).toMatchObject({ errors: test.failures })
    expect(test.failures).toHaveLength(2)
  })

  it('retains native cleanup failure and every later delivery failure after disconnect', async () => {
    vi.useFakeTimers()
    const firstDelivery = Promise.withResolvers<undefined>()
    const secondDelivery = Promise.withResolvers<undefined>()
    const test = tracked(message => message.type === 'browser-task/cancel' ? Promise.resolve()
      : message.requestId === 1 ? firstDelivery.promise : secondDelivery.promise)
    const first = test.request()
    const second = test.request({ action: 'prepare' }, { ...scope, taskId: 'other' })
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'DISCONNECTED' })
    const closing = test.channel.close()
    let settled = false
    const outcome = closing.catch((error: unknown) => { settled = true; return error })
    const firstCause = new Error('first queued delivery failed')
    const secondCause = new Error('second queued delivery failed')
    try {
      test.ack(1, 'native cleanup failed')
      test.channel.disconnect(new Error('IPC lost'))
      await Promise.all([firstRejected, secondRejected])
      firstDelivery.reject(firstCause)
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      secondDelivery.reject(secondCause)
      expect(await outcome).toMatchObject({ errors: [
        expect.objectContaining({ code: 'CANCEL_FAILED' }),
        expect.objectContaining({ code: 'DISCONNECTED' }),
        expect.objectContaining({ code: 'SEND_FAILED', cause: firstCause }),
        expect.objectContaining({ code: 'SEND_FAILED', cause: secondCause }),
      ] })
      expect(test.failures).toEqual([
        expect.objectContaining({ code: 'CANCEL_FAILED' }), expect.objectContaining({ code: 'DISCONNECTED' }),
      ])
    } finally { firstDelivery.resolve(undefined); secondDelivery.resolve(undefined); await outcome }
  })

  it('settles close when cancellation delivery synchronously disconnects before later tasks retire', async () => {
    vi.useFakeTimers()
    const test = tracked(async (message) => {
      if (message.type === 'browser-task/cancel') test.channel.disconnect(new Error('IPC lost during cancellation'))
    })
    const first = test.request()
    const second = test.request({ action: 'prepare' }, { ...scope, taskId: 'other' })
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'DISCONNECTED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'DISCONNECTED' })
    let settled = false
    const outcome = test.channel.close().catch((error: unknown) => { settled = true; return error })
    await Promise.all([firstRejected, secondRejected])
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(await outcome).toBe(test.failures[0])
    expect(test.messages.filter(message => message.type === 'browser-task/cancel')).toHaveLength(1)
  })

  it('rejects pending work and cleanup on disconnect without fabricating ACK', async () => {
    const test = tracked()
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    test.signal.abort()
    const retired = test.channel.retire(scope)
    const cleanupRejected = expect(retired).rejects.toMatchObject({ code: 'DISCONNECTED' })
    test.channel.disconnect(new Error('IPC lost'))
    await rejected
    await cleanupRejected
    expect(test.ack()).toBe(false)
    expect(test.failures).toHaveLength(1)
    await expect(test.request()).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(test.channel.close()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  it.each([false, true])('contains IPC send rejection (synchronous: %s)', async (synchronous) => {
    const cause = new Error('send failed')
    const test = tracked(() => { if (synchronous) throw cause; return Promise.reject(cause) })
    await expect(test.request()).rejects.toMatchObject({ code: 'SEND_FAILED', cause })
    expect(test.failures).toHaveLength(1)
    await expect(test.channel.close()).rejects.toMatchObject({ code: 'SEND_FAILED' })
  })

  it('contains a throwing diagnostic callback without unhandled sends or replacing the transport failure', async () => {
    const diagnostic = new Error('diagnostic failed')
    const cause = new Error('send failed')
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    const channel = new BrowserTaskChannel('run', {
      send: () => Promise.reject(cause),
      onFailure: () => { throw diagnostic },
    })
    channels.push(channel)
    await expect(channel.request(scope, { action: 'prepare' }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
    })).rejects.toMatchObject({ code: 'SEND_FAILED', cause })
    await expect(channel.close()).rejects.toMatchObject({ code: 'SEND_FAILED', cause })
    expect(fallback).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ code: 'SEND_FAILED' }), diagnostic)
  })

  it('preserves failed cleanup when its diagnostic callback throws', async () => {
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    const channel = new BrowserTaskChannel('run', {
      send: () => Promise.resolve(), onFailure: () => { throw new Error('diagnostic failed') },
    })
    channels.push(channel)
    const pending = channel.request(scope, { action: 'prepare' }, {
      signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    const retired = channel.retire(scope)
    const cleanupRejected = expect(retired).rejects.toMatchObject({ code: 'CANCEL_FAILED' })
    expect(() => channel.receive({ type: 'browser-task/cancelled', direction: 'main-to-host', requestId: 1,
      scope, error: 'native destruction failed' })).not.toThrow()
    await rejected
    await cleanupRejected
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('contains cancellation send failure without accepting a late result', async () => {
    const test = tracked(message => message.type === 'browser-task/cancel' ? Promise.reject(new Error('cancel lost')) : Promise.resolve())
    const pending = test.request()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SEND_FAILED' })
    test.signal.abort()
    await rejected
    expect(test.reply({ action: 'prepared', lease })).toBe(false)
    await expect(test.channel.retire(scope)).rejects.toMatchObject({ code: 'SEND_FAILED' })
  })

  it('does not cancel another task when a different scope retires', async () => {
    const test = tracked()
    const first = test.request()
    const otherScope = { ...scope, taskId: 'other' }
    const other = test.request({ action: 'prepare' }, otherScope)
    const rejected = expect(first).rejects.toMatchObject({ code: 'RETIRED' })
    const retiring = test.channel.retire(scope)
    test.reply({ action: 'prepared', lease: otherLease }, 2, otherScope)
    await expect(other).resolves.toMatchObject({ lease: otherLease })
    test.ack()
    await rejected
    await retiring
  })
})
