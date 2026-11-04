import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentActivity } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  BrowserTaskScopeRegistry,
  type BrowserTaskScopeCapability,
  type BrowserTaskScopePorts,
} from '../src/browser-task-scopes.ts'

type Resource = { readonly storage: Map<string, string> }

function fixture(ports: Partial<Omit<BrowserTaskScopePorts<Resource>, 'agents'>> = {}) {
  const ctx = new Context()
  const live = new Map<SessionId, Agent>()
  const activities = new WeakMap<Agent, AgentActivity | null>()
  function beginActivity(owner: Agent) {
    const abort = new AbortController()
    const activity = Object.freeze({ signal: abort.signal })
    setActivity(owner, activity)
    return { activity, abort }
  }
  const cleanup: { failure?: unknown } = {}
  const acquire = vi.fn<BrowserTaskScopePorts<Resource>['acquire']>(ports.acquire ?? (async () => ({ storage: new Map() })))
  const release = vi.fn<BrowserTaskScopePorts<Resource>['release']>(ports.release ?? (async () => {}))
  const runEpoch = randomUUID()
  const registry = new BrowserTaskScopeRegistry(runEpoch, { agents: { get: id => live.get(id) }, acquire, release })
  onTestFinished(async () => {
    try {
      if (cleanup.failure === undefined) await registry.dispose()
      else await expect(registry.dispose()).rejects.toBe(cleanup.failure)
    } finally {
      await ctx.fiber.dispose()
    }
  })
  function agent(id = 'same-session'): Agent {
    const session = Session.create(SessionId(id))
    const result: Agent = {
      id: session.id, session, ctx, options: {}, status: 'idle',
      model: { current: () => undefined, select: () => { throw new Error('unused model') } },
      inbox: {
        nextTurn: [], nextStep: [], clear: () => {}, append: () => {}, prepend: () => {},
        replace: () => false, remove: () => false, splice: () => [],
      },
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
      whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    }
    live.set(result.id, result)
    beginActivity(result)
    return result
  }
  function execution(owner: Agent) { return { agent: owner, signal: new AbortController().signal } }
  function setActivity(owner: Agent, activity: AgentActivity | null | undefined) {
    if (activity === undefined) {
      activities.delete(owner)
      Reflect.deleteProperty(owner, 'activity')
    } else {
      activities.set(owner, activity)
      Object.defineProperty(owner, 'activity', { configurable: true, enumerable: true, get: () => activities.get(owner) ?? null })
    }
  }
  return { ctx, live, runEpoch, registry, acquire, release, agent, execution, cleanup, beginActivity, setActivity }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('Host-private browser task scope admission', () => {
  it('requires the exact live executor Agent rather than caller Session, call, or provider fields', async () => {
    const f = fixture()
    const owner = f.agent()
    const extraFields = { signal: new AbortController().signal, sessionId: owner.id, callId: 'claimed-call', provider: 'claimed-provider' }
    expect(() => f.registry.admit(extraFields)).toThrow(expect.objectContaining({ code: 'AGENT_REQUIRED' }))
    expect(() => f.registry.admit({ ...extraFields, agent: { ...owner } })).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
    expect(f.acquire).not.toHaveBeenCalled()
    const cap = await f.registry.admit({ ...extraFields, agent: owner })
    expect(f.registry.metadata(cap).sessionId).toBe(owner.session.id)
  })

  it('generates only opaque wire epochs and derives the Session internally', async () => {
    const f = fixture()
    const owner = f.agent()
    const cap = await f.registry.admit(f.execution(owner))
    const metadata = f.registry.metadata(cap)
    expect(Object.keys(metadata).sort()).toEqual(['agentEpoch', 'providerEpoch', 'runEpoch', 'sessionId', 'taskEpoch', 'taskId'])
    for (const [key, value] of Object.entries(metadata)) {
      if (key !== 'sessionId') expect(value).toMatch(uuid)
    }
    expect(metadata.runEpoch).toBe(f.runEpoch)
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(Object.isFrozen(cap)).toBe(true)
    expect(Object.keys(cap)).toEqual([])
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata)
    expect(metadata).not.toHaveProperty('agent')
    expect(metadata).not.toHaveProperty('token')
  })

  it('gives two tasks in one Session distinct storage capabilities and task epochs', async () => {
    const hostStorage = new Map<BrowserTaskScopeCapability, Map<string, string>>()
    const f = fixture({ acquire: async (_wire, _signal, storage) => {
      const data = new Map<string, string>()
      hostStorage.set(storage, data)
      return { storage: data }
    } })
    const owner = f.agent()
    const first = await f.registry.admit(f.execution(owner))
    const second = await f.registry.admit(f.execution(owner))
    const a = f.registry.metadata(first)
    const b = f.registry.metadata(second)
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.runEpoch).toBe(b.runEpoch)
    expect(a.providerEpoch).toBe(b.providerEpoch)
    expect(a.agentEpoch).toBe(b.agentEpoch)
    expect(a.taskId).not.toBe(b.taskId)
    expect(a.taskEpoch).not.toBe(b.taskEpoch)
    expect(first).not.toBe(second)
    await f.registry.withScope(first, async (resource) => { resource.storage.set('cookie', 'first-task') })
    expect(hostStorage.get(first)?.get('cookie')).toBe('first-task')
    expect(hostStorage.get(second)?.has('cookie')).toBe(false)
    await f.registry.revokeAndDrain(first)
    expect(f.registry.metadata(second)).toBe(b)
    await f.registry.withScope(second, async (resource) => { expect(resource.storage.size).toBe(0) })
  })

  it('rejects copied capabilities and capabilities belonging to another registry', async () => {
    const f = fixture()
    const other = fixture()
    const cap = await f.registry.admit(f.execution(f.agent()))
    expect(() => f.registry.metadata({ ...cap })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }))
    await expect(f.registry.withScope({ ...cap }, async () => 'forged')).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    expect(() => other.registry.revokeAndDrain(cap)).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }))
    const otherCap = await other.registry.admit(other.execution(other.agent()))
    expect(other.registry.metadata(otherCap).runEpoch).not.toBe(f.registry.metadata(cap).runEpoch)
    expect(other.registry.metadata(otherCap).providerEpoch).not.toBe(f.registry.metadata(cap).providerEpoch)
  })

  it('fails closed for a retired exact Agent and rotates its epoch on same-id replacement', async () => {
    const f = fixture()
    const oldAgent = f.agent()
    const oldCap = await f.registry.admit(f.execution(oldAgent))
    const oldMetadata = f.registry.metadata(oldCap)
    const replacement = f.agent()
    await expect(f.registry.withScope(oldCap, async () => 'stale')).rejects.toMatchObject({ code: 'AGENT_RETIRED' })
    await f.registry.revokeAgentAndDrain(oldAgent)
    expect(f.release).toHaveBeenCalledOnce()
    expect(() => f.registry.admit(f.execution(oldAgent))).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
    const next = await f.registry.admit(f.execution(replacement))
    expect(f.registry.metadata(next).sessionId).toBe(oldMetadata.sessionId)
    expect(f.registry.metadata(next).agentEpoch).not.toBe(oldMetadata.agentEpoch)
  })

  it('does not use a running/idle flag as admission authority', async () => {
    const f = fixture()
    const idle = f.agent('idle')
    const running = { ...f.agent('running'), status: 'running' as const }
    f.live.set(running.id, running)
    await f.registry.admit(f.execution(idle))
    const cap = await f.registry.admit(f.execution(running))
    f.live.delete(running.id)
    expect(() => f.registry.metadata(cap)).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
    await f.registry.revokeAgentAndDrain(running)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('rejects a signal already aborted before acquisition', () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    expect(() => f.registry.admit({ agent: f.agent(), signal: abort.signal })).toThrow(expect.objectContaining({ code: 'ABORTED' }))
    expect(f.acquire).not.toHaveBeenCalled()
  })

  it('reclaims late acquisition after abort before returning any capability', async () => {
    const acquired = Promise.withResolvers<Resource>()
    const releasing = Promise.withResolvers<undefined>()
    const allowRelease = Promise.withResolvers<undefined>()
    const f = fixture({
      acquire: () => acquired.promise,
      release: async () => { releasing.resolve(undefined); await allowRelease.promise },
    })
    const abort = new AbortController()
    const admission = f.registry.admit({ agent: f.agent(), signal: abort.signal })
    const denied = expect(admission).rejects.toMatchObject({ code: 'ABORTED' })
    const storage = f.acquire.mock.calls[0]![2]
    const taskSignal = f.acquire.mock.calls[0]![1]
    abort.abort()
    expect(taskSignal.aborted).toBe(true)
    expect(() => f.registry.metadata(storage)).toThrow(expect.objectContaining({ code: 'ABORTED' }))
    const drain = f.registry.revokeAndDrain(storage)
    expect(f.registry.revokeAndDrain(storage)).toBe(drain)
    let settled = false
    void admission.then(() => { settled = true }, () => { settled = true })
    expect(f.release).not.toHaveBeenCalled()
    acquired.resolve({ storage: new Map() })
    await releasing.promise
    expect(settled).toBe(false)
    allowRelease.resolve(undefined)
    await denied
    await drain
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each(['throw', 'reject'] as const)('contains acquisition %s without a resource or dangling drain', async (mode) => {
    const failure = new Error(`acquisition ${mode}`)
    const f = fixture({ acquire: () => {
      if (mode === 'throw') throw failure
      return Promise.reject(failure)
    } })
    await expect(f.registry.admit(f.execution(f.agent()))).rejects.toBe(failure)
    await f.registry.dispose()
    expect(f.release).not.toHaveBeenCalled()
  })

  it('reserves pending acquisition before an acquire callback can dispose the provider', async () => {
    const pending = Promise.withResolvers<Resource>()
    const releaseEntered = Promise.withResolvers<undefined>()
    let drain: Promise<void> | undefined
    const f = fixture({
      acquire: () => { drain = f.registry.dispose(); return pending.promise },
      release: async () => { releaseEntered.resolve(undefined) },
    })
    const admission = f.registry.admit(f.execution(f.agent()))
    const denied = expect(admission).rejects.toMatchObject({ code: 'DISPOSED' })
    expect(drain).toBe(f.registry.dispose())
    expect(f.release).not.toHaveBeenCalled()
    pending.resolve({ storage: new Map() })
    await releaseEntered.promise
    await denied
    await drain
    expect(f.release).toHaveBeenCalledOnce()
  })
})

describe('browser task scope revocation and drains', () => {
  it('reserves work before callbacks, drains it, and rejects a late success after reclamation', async () => {
    const work = Promise.withResolvers<string>()
    const releasing = Promise.withResolvers<undefined>()
    const allowRelease = Promise.withResolvers<undefined>()
    const f = fixture({ release: async () => { releasing.resolve(undefined); await allowRelease.promise } })
    const cap = await f.registry.admit(f.execution(f.agent()))
    let drain: Promise<void> | undefined
    const result = f.registry.withScope(cap, async (_resource, _scope, signal) => {
      drain = f.registry.revokeAndDrain(cap)
      expect(signal.aborted).toBe(true)
      expect(() => f.registry.metadata(cap)).toThrow(expect.objectContaining({ code: 'SCOPE_REVOKED' }))
      expect(f.release).not.toHaveBeenCalled()
      return work.promise
    })
    const denied = expect(result).rejects.toMatchObject({ code: 'SCOPE_REVOKED' })
    expect(f.registry.revokeAndDrain(cap)).toBe(drain)
    let returned = false
    void result.then(() => { returned = true }, () => { returned = true })
    work.resolve('late resource result')
    await releasing.promise
    expect(returned).toBe(false)
    allowRelease.resolve(undefined)
    await denied
    await drain
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('waits for every admitted operation before release and denies any new work synchronously', async () => {
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const f = fixture()
    const cap = await f.registry.admit(f.execution(f.agent()))
    const a = f.registry.withScope(cap, () => first.promise)
    const b = f.registry.withScope(cap, () => second.promise)
    const deniedA = expect(a).rejects.toMatchObject({ code: 'SCOPE_REVOKED' })
    const deniedB = expect(b).rejects.toMatchObject({ code: 'SCOPE_REVOKED' })
    const drain = f.registry.revokeAndDrain(cap)
    const callback = vi.fn(async () => {})
    await expect(f.registry.withScope(cap, callback)).rejects.toMatchObject({ code: 'SCOPE_REVOKED' })
    expect(callback).not.toHaveBeenCalled()
    first.resolve(undefined)
    // Admission denial settled an independent Promise; pending second work still owns the resource.
    expect(f.release).not.toHaveBeenCalled()
    second.resolve(undefined)
    await Promise.all([deniedA, deniedB, drain])
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('completes reservations when a work callback throws or rejects', async () => {
    const f = fixture()
    const cap = await f.registry.admit(f.execution(f.agent()))
    const failure = new Error('operation failed')
    await expect(f.registry.withScope(cap, () => { throw failure })).rejects.toBe(failure)
    await expect(f.registry.withScope(cap, async () => { throw failure })).rejects.toBe(failure)
    await f.registry.revokeAndDrain(cap)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each([false, true])('drains a revoked rejected operation before returning its failure (cleanup fails: %s)', async (cleanupFails) => {
    const work = Promise.withResolvers<string>()
    const releasing = Promise.withResolvers<undefined>()
    const allowRelease = Promise.withResolvers<undefined>()
    const operationError = new Error('operation failed after revocation')
    const cleanupError = new Error('release failed')
    const f = fixture({ release: async () => {
      releasing.resolve(undefined)
      await allowRelease.promise
      if (cleanupFails) throw cleanupError
    } })
    if (cleanupFails) f.cleanup.failure = cleanupError
    const cap = await f.registry.admit(f.execution(f.agent()))
    const result = f.registry.withScope(cap, () => work.promise)
    const denied = cleanupFails
      ? expect(result).rejects.toMatchObject({ errors: [operationError, cleanupError] })
      : expect(result).rejects.toBe(operationError)
    let returned = false
    void result.then(() => { returned = true }, () => { returned = true })
    const drain = f.registry.revokeAndDrain(cap)
    const drained = cleanupFails ? expect(drain).rejects.toBe(cleanupError) : drain
    try {
      work.reject(operationError)
      await releasing.promise
      expect(returned).toBe(false)
      allowRelease.resolve(undefined)
      await Promise.all([denied, drained])
      expect(f.release).toHaveBeenCalledOnce()
    } finally { work.reject(operationError); allowRelease.resolve(undefined) }
  })

  it('invalidates every task and retires the exact Agent before cancellation callbacks run', async () => {
    const f = fixture()
    const owner = f.agent()
    const a = await f.registry.admit(f.execution(owner))
    const b = await f.registry.admit(f.execution(owner))
    const otherAgent = f.agent('other-session')
    const other = await f.registry.admit(f.execution(otherAgent))
    const callback = vi.fn(() => {
      expect(() => f.registry.metadata(a)).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
      expect(() => f.registry.metadata(b)).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
      expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
    })
    for (const call of f.acquire.mock.calls.slice(0, 2)) call[1].addEventListener('abort', callback)
    const drain = f.registry.revokeAgentAndDrain(owner)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(f.registry.revokeAgentAndDrain(owner)).toBe(drain)
    expect(f.registry.metadata(other).sessionId).toBe(otherAgent.id)
    await drain
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
  })

  it('retires an Agent with no prior scopes without affecting a same-id replacement', async () => {
    const f = fixture()
    const old = f.agent()
    await f.registry.revokeAgentAndDrain(old)
    expect(() => f.registry.admit(f.execution(old))).toThrow(expect.objectContaining({ code: 'AGENT_RETIRED' }))
    await f.registry.admit(f.execution(f.agent()))
    expect(f.acquire).toHaveBeenCalledOnce()
  })

  it('reclaims a pending task whose exact Agent is replaced before admission completes', async () => {
    const pending = Promise.withResolvers<Resource>()
    const f = fixture({ acquire: () => pending.promise })
    const old = f.agent()
    const admission = f.registry.admit(f.execution(old))
    const denied = expect(admission).rejects.toMatchObject({ code: 'AGENT_RETIRED' })
    f.agent()
    pending.resolve({ storage: new Map() })
    await denied
    await f.registry.revokeAgentAndDrain(old)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('reclaims a late operation result when registry liveness changes without an event notification', async () => {
    const pending = Promise.withResolvers<string>()
    const f = fixture()
    const owner = f.agent()
    const cap = await f.registry.admit(f.execution(owner))
    const operation = f.registry.withScope(cap, () => pending.promise)
    const denied = expect(operation).rejects.toMatchObject({ code: 'AGENT_RETIRED' })
    f.live.delete(owner.id)
    pending.resolve('must not escape')
    await denied
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('invalidates the provider before cancellation/release callbacks and joins reentrant disposal', async () => {
    const f = fixture()
    const owner = f.agent()
    const a = await f.registry.admit(f.execution(owner))
    const b = await f.registry.admit(f.execution(owner))
    let reentrant: Promise<void> | undefined
    const onAbort = vi.fn(() => {
      expect(() => f.registry.metadata(a)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
      expect(() => f.registry.metadata(b)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
      expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
      reentrant = f.registry.dispose()
    })
    f.acquire.mock.calls[0]![1].addEventListener('abort', onAbort)
    f.release.mockImplementation(async () => {
      expect(() => f.registry.metadata(a)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
    })
    const disposed = f.registry.dispose()
    expect(disposed).toBe(reentrant)
    expect(f.registry.dispose()).toBe(disposed)
    expect(onAbort).toHaveBeenCalledOnce()
    await disposed
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('retains cleanup failure for task, Agent, and provider joins without retrying release', async () => {
    const failure = new Error('storage cleanup failed; owner must report')
    const f = fixture({ release: async () => { throw failure } })
    f.cleanup.failure = failure
    const owner = f.agent()
    const cap = await f.registry.admit(f.execution(owner))
    const drain = f.registry.revokeAndDrain(cap)
    await expect(drain).rejects.toBe(failure)
    expect(f.registry.revokeAndDrain(cap)).toBe(drain)
    await expect(f.registry.revokeAgentAndDrain(owner)).rejects.toBe(failure)
    await expect(f.registry.dispose()).rejects.toBe(failure)
    expect(f.release).toHaveBeenCalledOnce()
    expect(() => f.registry.metadata(cap)).toThrow(expect.objectContaining({ code: 'SCOPE_REVOKED' }))
  })

  it('retains an abort-driven cleanup failure for later explicit disposal', async () => {
    const failure = new Error('abort cleanup failed')
    const f = fixture({ release: async () => { throw failure } })
    f.cleanup.failure = failure
    const abort = new AbortController()
    const cap = await f.registry.admit({ agent: f.agent(), signal: abort.signal })
    abort.abort()
    await expect(f.registry.revokeAndDrain(cap)).rejects.toBe(failure)
    await expect(f.registry.dispose()).rejects.toBe(failure)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('waits for all cleanup before reporting multiple provider failures', async () => {
    const blocked = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const first = new Error('first cleanup failed')
    const second = new Error('second cleanup failed')
    const f = fixture({ release: async (_resource, scope) => {
      if (scope.sessionId === 'first') throw first
      entered.resolve(undefined)
      await blocked.promise
      throw second
    } })
    await f.registry.admit(f.execution(f.agent('first')))
    await f.registry.admit(f.execution(f.agent('second')))
    const disposal = f.registry.dispose()
    const outcome = disposal.catch((error: unknown) => { f.cleanup.failure = error; return error })
    let finished = false
    void outcome.then(() => { finished = true })
    await entered.promise
    expect(finished).toBe(false)
    blocked.resolve(undefined)
    expect(await outcome).toMatchObject({ errors: [first, second] })
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported, absent and already-draining activities before acquiring resources', () => {
    const f = fixture()
    const owner = f.agent()
    for (const absent of [undefined, null]) {
      f.setActivity(owner, absent)
      expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'ACTIVITY_REQUIRED' }))
    }
    const activity = f.beginActivity(owner)
    activity.abort.abort()
    expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
    expect(f.acquire).not.toHaveBeenCalled()
  })

  it('closes zero-task admission before callbacks while allowing a later activity of the same Agent', async () => {
    const f = fixture()
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const retired = f.registry.revokeActivityAndDrain(owner, first.activity)
    expect(f.registry.revokeActivityAndDrain(owner, first.activity)).toBe(retired)
    expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
    await retired
    f.beginActivity(owner)
    const cap = await f.registry.admit(f.execution(owner))
    expect(f.registry.metadata(cap).sessionId).toBe(owner.id)
  })

  it('joins activity operations before release and admits fresh scopes after successful drainage', async () => {
    const f = fixture()
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const cap = await f.registry.admit(f.execution(owner))
    const metadata = f.registry.metadata(cap)
    const entered = Promise.withResolvers<AbortSignal>()
    const blocked = Promise.withResolvers<undefined>()
    const operation = f.registry.withScope(cap, async (_resource, _scope, signal) => {
      entered.resolve(signal)
      await blocked.promise
    }).catch((error: unknown) => error)
    const signal = await entered.promise
    first.abort.abort()
    expect(signal.aborted).toBe(true)
    expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
    const retired = f.registry.revokeActivityAndDrain(owner, first.activity)
    expect(f.release).not.toHaveBeenCalled()
    blocked.resolve(undefined)
    expect(await operation).toMatchObject({ code: 'ACTIVITY_RETIRED' })
    await retired
    expect(f.release).toHaveBeenCalledOnce()
    f.beginActivity(owner)
    const next = await f.registry.admit(f.execution(owner))
    expect(f.registry.metadata(next).agentEpoch).toBe(metadata.agentEpoch)
    expect(f.registry.metadata(next).taskEpoch).not.toBe(metadata.taskEpoch)
    expect(() => f.registry.metadata(cap)).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
  })

  it('reclaims a late acquisition and awaits native release before an activity drain settles', async () => {
    const acquired = Promise.withResolvers<Resource>()
    const releasing = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const f = fixture({ acquire: () => acquired.promise, release: async () => { releasing.resolve(undefined); await released.promise } })
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const admitted = f.registry.admit(f.execution(owner)).catch((error: unknown) => error)
    first.abort.abort()
    let finished = false
    const retired = f.registry.revokeActivityAndDrain(owner, first.activity)
    void retired.then(() => { finished = true })
    acquired.resolve({ storage: new Map() })
    await releasing.promise
    expect(finished).toBe(false)
    expect(f.release).toHaveBeenCalledOnce()
    released.resolve(undefined)
    expect(await admitted).toMatchObject({ code: 'ACTIVITY_RETIRED' })
    await retired
    expect(finished).toBe(true)
  })

  it('reserves the activity drain before abort reentry and revokes all its tasks first', async () => {
    const f = fixture()
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const a = await f.registry.admit(f.execution(owner))
    const b = await f.registry.admit(f.execution(owner))
    let reentered: Promise<void> | undefined
    await f.registry.withScope(a, async (_resource, _scope, signal) => {
      signal.addEventListener('abort', () => {
        reentered = f.registry.revokeActivityAndDrain(owner, first.activity)
        expect(() => f.registry.metadata(b)).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
        expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
      }, { once: true })
    })
    const retired = f.registry.revokeActivityAndDrain(owner, first.activity)
    expect(reentered).toBe(retired)
    await retired
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('retains cleanup failures that settled before the activity listener joins', async () => {
    const failure = new Error('native activity retirement failed')
    const f = fixture({ release: async () => { throw failure } })
    f.cleanup.failure = failure
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const cap = await f.registry.admit(f.execution(owner))
    first.abort.abort()
    await expect(f.registry.revokeAndDrain(cap)).rejects.toBe(failure)
    const retired = f.registry.revokeActivityAndDrain(owner, first.activity)
    await expect(retired).rejects.toBe(failure)
    expect(f.registry.revokeActivityAndDrain(owner, first.activity)).toBe(retired)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('does not let a foreign or reconstructed activity poison the real activity owner', async () => {
    const f = fixture()
    const owner = f.agent('first-session')
    const foreign = f.agent('other-session')
    const first = f.beginActivity(owner)
    const cap = await f.registry.admit(f.execution(owner))
    expect(() => f.registry.revokeActivityAndDrain(foreign, first.activity)).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }))
    expect(() => f.registry.revokeActivityAndDrain(owner, { signal: first.activity.signal })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }))
    expect(f.registry.metadata(cap).sessionId).toBe(owner.id)
    expect(f.release).not.toHaveBeenCalled()
    await f.registry.revokeActivityAndDrain(owner, first.activity)
  })

  it('drains only the captured activity and rejects a stale scope after identity turnover', async () => {
    const f = fixture()
    const owner = f.agent()
    const first = f.beginActivity(owner)
    const old = await f.registry.admit(f.execution(owner))
    f.beginActivity(owner)
    const current = await f.registry.admit(f.execution(owner))
    expect(() => f.registry.metadata(old)).toThrow(expect.objectContaining({ code: 'ACTIVITY_RETIRED' }))
    await f.registry.revokeActivityAndDrain(owner, first.activity)
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.registry.metadata(current).sessionId).toBe(owner.id)
  })

  it('lets a contributing Cordis effect own awaitable provider teardown', async () => {
    const f = fixture()
    const owner = f.agent()
    const cap = await f.registry.admit(f.execution(owner))
    const releaseOwner = f.ctx.effect(() => () => f.registry.dispose(), 'browser-task-test-lifetime')
    await releaseOwner()
    expect(() => f.registry.metadata(cap)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
    expect(f.release).toHaveBeenCalledOnce()
    expect(() => f.registry.admit(f.execution(owner))).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
  })
})
