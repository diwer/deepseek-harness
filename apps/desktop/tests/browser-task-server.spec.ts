import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId, DesktopBrowserTaskCancelled, DesktopBrowserTaskReply,
  DesktopBrowserTaskRequest, DesktopBrowserTaskResult, DesktopBrowserTaskScope } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopBrowserTaskServer, type DesktopBrowserTaskHandler } from '../src/browser-task-server.ts'
import { BrowserTaskChannel } from '../../desktop-host/src/browser-task-channel.ts'

const runEpoch = randomUUID()
const lease = randomUUID() as DesktopBrowserLeaseId
const prepared: DesktopBrowserTaskResult = { action: 'prepared', lease }
const scope = (): DesktopBrowserTaskScope => ({ runEpoch, providerEpoch: randomUUID(), agentEpoch: randomUUID(),
  taskId: randomUUID(), taskEpoch: randomUUID(), sessionId: 'same-session' })
const request = (requestId = 1, task = scope()): DesktopBrowserTaskRequest => ({
  type: 'browser-task/request', direction: 'host-to-main', requestId, scope: task,
  deadlineAt: Date.now() + 20_000, command: { action: 'prepare' },
})
const cancel = (original: DesktopBrowserTaskRequest) => ({
  type: 'browser-task/cancel', direction: 'host-to-main', requestId: original.requestId, scope: original.scope,
})
const servers: DesktopBrowserTaskServer[] = []
afterEach(async () => { await Promise.allSettled(servers.splice(0).map(server => server.close())); vi.useRealTimers() })
function setup(handler?: DesktopBrowserTaskHandler) {
  const replies: (DesktopBrowserTaskReply | DesktopBrowserTaskCancelled)[] = []
  const failure = vi.fn()
  const server = new DesktopBrowserTaskServer(runEpoch, async (reply) => { replies.push(reply) }, handler, failure)
  servers.push(server)
  return { server, replies, failure }
}

// Main's native handler is an injected owning port, not renderer-provided authority.
describe('private Host-to-Main browser task server', () => {
  it('rejects unsupported task requests without acquiring a manual guest', async () => {
    const { server, replies } = setup()
    expect(server.receive({ type: 'ready' })).toBe(false)
    const original = request()
    expect(server.receive(original)).toBe(true)
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toMatchObject({ type: 'browser-task/reply', requestId: 1, scope: original.scope,
      outcome: { kind: 'error', message: 'desktop browser: native task provider is unavailable' } })
  })

  it('reserves exact work before a synchronously reentrant cancellation and drains late success', async () => {
    const operation = Promise.withResolvers<DesktopBrowserTaskResult>()
    const native = Promise.withResolvers<undefined>()
    const original = request()
    let aborted: AbortSignal | undefined
    let calls = 0
    const handler: DesktopBrowserTaskHandler = {
      execute: (_request, signal) => {
        aborted = signal
        server.receive(cancel(original))
        return operation.promise
      },
      retire: () => { calls++; return native.promise },
    }
    const state = setup(handler)
    const server = state.server
    try {
      server.receive(original)
      expect(aborted?.aborted).toBe(true)
      expect(calls).toBe(1)
      expect(state.replies).toHaveLength(0)
      native.resolve(undefined)
      await Promise.resolve(undefined)
      expect(state.replies).toHaveLength(0)
      operation.resolve(prepared)
      await vi.waitFor(() => { expect(state.replies).toHaveLength(2) })
      expect(state.replies.find(reply => reply.type === 'browser-task/cancelled')).toEqual({
        type: 'browser-task/cancelled', direction: 'main-to-host', requestId: 1, scope: original.scope,
      })
      expect(state.replies.find(reply => reply.type === 'browser-task/reply')).toMatchObject({ outcome: { kind: 'error' } })
      server.receive(cancel(original))
      await vi.waitFor(() => { expect(state.replies).toHaveLength(3) })
      expect(calls).toBe(1)
    } finally { operation.resolve(prepared); native.resolve(undefined) }
  })

  it('retains completed request identity for cancellation after a successful normal reply', async () => {
    const retire = vi.fn(async () => {})
    const { server, replies } = setup({ execute: async () => prepared, retire })
    const original = request()
    server.receive(original)
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toMatchObject({ outcome: { kind: 'result', value: prepared } })
    server.receive(cancel(original))
    await vi.waitFor(() => { expect(replies).toHaveLength(2) })
    expect(retire).toHaveBeenCalledWith(original.scope)
    server.receive(request(2, original.scope))
    await vi.waitFor(() => { expect(replies).toHaveLength(3) })
    expect(replies[2]).toMatchObject({ outcome: { kind: 'error' } })
  })

  it('cancels one task without blocking another task in the same Session', async () => {
    const a = Promise.withResolvers<DesktopBrowserTaskResult>()
    const b = Promise.withResolvers<DesktopBrowserTaskResult>()
    const cleanup = Promise.withResolvers<undefined>()
    const first = request(1)
    const second = request(2)
    const signals = new Map<string, AbortSignal>()
    const retired: string[] = []
    const { server, replies } = setup({
      execute: (message, signal) => {
        signals.set(message.scope.taskId, signal)
        return message.requestId === 1 ? a.promise : b.promise
      },
      retire: (task) => {
        retired.push(task.taskId)
        return task.taskId === first.scope.taskId ? cleanup.promise : Promise.resolve(undefined)
      },
    })
    try {
      server.receive(first)
      server.receive(second)
      server.receive(cancel(first))
      expect(signals.get(first.scope.taskId)?.aborted).toBe(true)
      expect(signals.get(second.scope.taskId)?.aborted).toBe(false)
      expect(retired).toEqual([first.scope.taskId])
      b.resolve(prepared)
      await vi.waitFor(() => { expect(replies).toHaveLength(1) })
      expect(replies[0]).toMatchObject({ requestId: 2, outcome: { kind: 'result' } })
      a.resolve(prepared)
      await Promise.resolve(undefined)
      expect(replies).toHaveLength(1)
      cleanup.resolve(undefined)
      await vi.waitFor(() => { expect(replies).toHaveLength(3) })
    } finally { a.resolve(prepared); b.resolve(prepared); cleanup.resolve(undefined) }
  })

  it.each([
    (original: DesktopBrowserTaskRequest) => ({ ...original, direction: 'main-to-host' }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, requestId: 0 }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, scope: { ...original.scope, runEpoch: randomUUID() } }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, deadlineAt: Date.now() + 60_000 }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, command: { action: 'evaluate', script: '1' } }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, command: { action: 'navigate', lease: 'manual-tab', url: 'https://example.com' } }),
    (original: DesktopBrowserTaskRequest) => ({ ...original, additional: 'field' }),
  ])('rejects malformed or wrong-run requests before native admission (%#)', (forge) => {
    const execute = vi.fn(async () => prepared)
    const { server } = setup({ execute, retire: async () => {} })
    expect(() => server.receive(forge(request()))).toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects replay, reused task epochs and foreign cancellations without native effects', async () => {
    const execute = vi.fn(async () => prepared)
    const retire = vi.fn(async () => {})
    const { server, replies } = setup({ execute, retire })
    const original = request()
    server.receive(original)
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(() => server.receive(original)).toThrow('stale task request')
    expect(() => server.receive({ ...request(2, original.scope), scope: { ...original.scope, taskEpoch: randomUUID() } })).toThrow('task identity changed')
    expect(() => server.receive({ ...cancel(original), scope: { ...original.scope, sessionId: 'foreign' } })).toThrow('unknown task cancellation')
    expect(() => server.receive({ ...cancel(original), requestId: 7 })).toThrow('unknown task cancellation')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(retire).not.toHaveBeenCalled()
  })

  it('starts native admission closure before notifying reentrant abort listeners', async () => {
    const operation = Promise.withResolvers<DesktopBrowserTaskResult>()
    let nativeClosed = false
    let observed = false
    const { server } = setup({ execute: (_request, signal) => {
      signal.addEventListener('abort', () => { observed = nativeClosed })
      return operation.promise
    }, retire: async () => { nativeClosed = true } })
    const original = request()
    try {
      server.receive(original)
      server.receive(cancel(original))
      expect(observed).toBe(true)
    } finally { operation.resolve(prepared) }
  })

  it('retains failed native cleanup for concurrent cancellation acknowledgements and close', async () => {
    const failure = new Error('native cleanup failed')
    const { server, replies } = setup({ execute: async () => prepared, retire: async () => { throw failure } })
    const original = request()
    server.receive(original)
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    server.receive(cancel(original))
    server.receive(cancel(original))
    await vi.waitFor(() => { expect(replies).toHaveLength(3) })
    for (const reply of replies.slice(1)) expect(reply).toMatchObject({ type: 'browser-task/cancelled', error: 'desktop browser: native task retirement failed' })
    await expect(server.close()).rejects.toThrow('task channel cleanup failed')
    await expect(server.close()).rejects.toThrow('task channel cleanup failed')
  })

  it('retires on deadline without reporting an early acquisition failure', async () => {
    vi.useFakeTimers()
    const operation = Promise.withResolvers<DesktopBrowserTaskResult>()
    const cleanup = Promise.withResolvers<undefined>()
    const { server, replies } = setup({ execute: () => operation.promise, retire: () => cleanup.promise })
    const original = { ...request(), deadlineAt: Date.now() + 10 }
    try {
      server.receive(original)
      await vi.advanceTimersByTimeAsync(10)
      operation.resolve(prepared)
      await vi.advanceTimersByTimeAsync(0)
      expect(replies).toHaveLength(0)
      cleanup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ outcome: { kind: 'error' } })
    } finally { operation.resolve(prepared); cleanup.resolve(undefined) }
  })

  it('reserves joined close before handler reentry and suppresses post-disconnect replies', async () => {
    const operation = Promise.withResolvers<DesktopBrowserTaskResult>()
    let reentrant: Promise<void> | undefined
    const state = setup({ execute: () => operation.promise, retire: async () => { reentrant = server.close() } })
    const server = state.server
    try {
      server.receive(request())
      const closing = server.close()
      expect(reentrant).toBe(closing)
      expect(server.close()).toBe(closing)
      expect(() => server.receive(request(2))).toThrow('channel is closed')
      operation.resolve(prepared)
      await closing
      expect(state.replies).toHaveLength(0)
    } finally { operation.resolve(prepared) }
  })

  it('observes disconnected send failures without unhandled rejection', async () => {
    const observed = vi.fn()
    const server = new DesktopBrowserTaskServer(runEpoch, async () => { throw new Error('disconnected') },
      { execute: async () => prepared, retire: async () => {} }, observed)
    servers.push(server)
    server.receive(request())
    await vi.waitFor(() => { expect(observed).toHaveBeenCalledOnce() })
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ message: 'disconnected' })
    await expect(server.close()).rejects.toThrow('task channel cleanup failed')
    await expect(server.close()).rejects.toThrow('task channel cleanup failed')
  })

  it('keeps cancellation IPC alive during native drain and rejects late work without executing it', async () => {
    const cleanup = Promise.withResolvers<undefined>()
    const original = request()
    const execute = vi.fn(async () => prepared)
    const { server, replies } = setup({ execute, retire: () => cleanup.promise })
    try {
      server.receive(original)
      await vi.waitFor(() => { expect(replies).toHaveLength(1) })
      const draining = server.drain()
      server.receive(cancel(original))
      server.receive(request(2, original.scope))
      expect(replies).toHaveLength(1)
      expect(execute).toHaveBeenCalledTimes(1)
      cleanup.resolve(undefined)
      await draining
      await vi.waitFor(() => { expect(replies).toHaveLength(3) })
      expect(replies).toContainEqual(expect.objectContaining({ type: 'browser-task/cancelled' }))
      expect(replies.find(reply => reply.requestId === 2)).toMatchObject({ outcome: { kind: 'error' } })
    } finally { cleanup.resolve(undefined) }
  })

  it('joins real Host-channel cancellation after Main starts graceful drain', async () => {
    const native = Promise.withResolvers<undefined>()
    const execute = vi.fn(async () => prepared)
    const server = new DesktopBrowserTaskServer(runEpoch, async (reply) => { channel.receive(reply) },
      { execute, retire: () => native.promise }, () => {})
    servers.push(server)
    const channel = new BrowserTaskChannel(runEpoch, { send: async (message) => { server.receive(message) }, onFailure: () => {} })
    try {
      await expect(channel.request(scope(), { action: 'prepare' }, { signal: new AbortController().signal, deadlineAt: Date.now() + 20_000 })).resolves.toEqual(prepared)
      const mainDrain = server.drain()
      const hostClose = channel.close()
      native.resolve(undefined)
      await Promise.all([mainDrain, hostClose])
      expect(execute).toHaveBeenCalledOnce()
      await server.close()
    } finally { native.resolve(undefined); await channel.close().catch(() => {}) }
  })

  it('retires a deadline expired in IPC without executing native work or failing the Host', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const native = Promise.withResolvers<undefined>()
    const execute = vi.fn(async () => prepared)
    const failed = vi.fn()
    const server = new DesktopBrowserTaskServer(runEpoch, async (reply) => { channel.receive(reply) },
      { execute, retire: () => native.promise }, failed)
    servers.push(server)
    const channel = new BrowserTaskChannel(runEpoch, { send: async (message) => { sent.push(message) }, onFailure: failed })
    let settled = false
    const operation = channel.request(scope(), { action: 'prepare' }, { signal: new AbortController().signal, deadlineAt: Date.now() + 5 })
    const rejected = operation.then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
    try {
      await vi.advanceTimersByTimeAsync(5)
      expect(sent).toHaveLength(2)
      server.receive(sent[0])
      server.receive(sent[1])
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      native.resolve(undefined)
      await expect(rejected).resolves.toHaveProperty('code', 'DEADLINE')
      expect(failed).not.toHaveBeenCalled()
    } finally {
      native.resolve(undefined)
      await channel.close().catch(() => {})
    }
  })
})
