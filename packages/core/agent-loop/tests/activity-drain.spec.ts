import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry, { type Agent, type AgentActivity } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: 5 }, () => textResponse('ok')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('activity-drain'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, handle, agent: handle.agent }
}

function activityOf(agent: Agent): AgentActivity {
  const activity = agent.activity
  if (activity == null) throw new Error('expected an active resource owner')
  return activity
}

function errorLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error]
}

function observe<T>(promise: Promise<T>) {
  const state = { settled: false }
  const result = promise.then(
    (value) => { state.settled = true; return { ok: true as const, value } },
    (error: unknown) => { state.settled = true; return { ok: false as const, error } },
  )
  return { state, result }
}

describe('per-activity resource drainage', () => {
  it.each(['completed', 'empty', 'rejected', 'aborted', 'error'] as const)('joins drainage on the %s driver exit before idle', async (exit) => {
    const { ctx, agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const statuses: string[] = []
    const operationFailure = new Error('pre-step failed')
    let operationSignal: AbortSignal | undefined
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    ctx.on('agent/pre-step', async ({ signal }, next) => {
      operationSignal = signal
      if (exit === 'rejected') return { kind: 'reject' }
      if (exit === 'aborted') { agent.cancel({ kind: 'user' }); signal.throwIfAborted() }
      if (exit === 'error') throw operationFailure
      const decision = await next()
      return exit === 'empty' ? { kind: 'enter', messages: [] } : decision
    })
    const activities: AgentActivity[] = []
    agent.ctx.on('agent/activity-draining', async ({ agent: subject, activity }) => {
      expect(subject).toBe(agent)
      expect(activity).toBe(agent.activity)
      expect(activity.signal.aborted).toBe(true)
      expect(operationSignal?.aborted).toBe(exit === 'aborted')
      activities.push(activity)
      entered.resolve(undefined)
      await release.promise
    })
    agent.followup(message('first'))
    const idle = observe(agent.whenIdle())
    await entered.promise
    expect(agent.status).toBe('running')
    expect(statuses).toEqual(['running'])
    expect(idle.state.settled).toBe(false)
    expect(() => agent.runMaintenance(async () => {})).toThrow('already has active work')
    expect(adapter.requests).toHaveLength(exit === 'completed' ? 1 : 0)
    release.resolve(undefined)
    expect(await idle.result).toEqual({ ok: true, value: undefined })
    expect(statuses).toEqual(['running', 'idle'])
    expect(activities).toHaveLength(1)
    expect(agent.activity).toBeNull()
  })

  it('keeps work started by an idle cancellation discard listener outside that cancellation', async () => {
    const { agent, adapter } = await harness()
    const pending = message('discard while idle')
    const replacement = message('reentrant replacement')
    const following = message('additional followup')
    const operationSignals: AbortSignal[] = []
    agent.ctx.on('agent/pre-step', ({ signal }, next) => {
      operationSignals.push(signal)
      return next()
    })
    agent.ctx.on('agent/inbox/discarded', ({ message: discarded }) => {
      if (discarded.id === pending.id) agent.followup(replacement)
    })
    agent.inject(pending)
    expect(agent.activity).toBeNull()
    agent.cancel({ kind: 'user' })
    expect(activityOf(agent).signal.aborted).toBe(false)
    agent.followup(following)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(operationSignals).toHaveLength(2)
    expect(operationSignals.every(signal => !signal.aborted)).toBe(true)
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.activity).toBeNull()
  })

  it('routes scoped listeners and waits for every parallel listener after a synchronous throw', async () => {
    const { ctx, agent, handle } = await harness()
    const other = await ctx.agents.create({ sessionId: SessionId('other-activity') })
    const unrelated = vi.fn()
    other.agent.ctx.on('agent/activity-draining', unrelated)
    const failure = new Error('first owner failed')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const finished: string[] = []
    agent.ctx.on('agent/activity-draining', () => { finished.push('first'); throw failure })
    agent.ctx.on('agent/activity-draining', async () => {
      entered.resolve(undefined)
      await release.promise
      finished.push('second')
    })
    agent.followup(message('first'))
    const idle = observe(agent.whenIdle())
    await entered.promise
    expect(finished).toEqual(['first'])
    expect(unrelated).not.toHaveBeenCalled()
    expect(idle.state.settled).toBe(false)
    release.resolve(undefined)
    const result = await idle.result
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a drainage failure')
    expect(errorLeaves(result.error)).toEqual([failure])
    expect(finished).toEqual(['first', 'second'])
    await expect(handle.dispose()).rejects.toBe(result.error)
  })

  it('keeps one closed identity through held drainage and replays followup plus steer in one replacement', async () => {
    const { agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const activities: AgentActivity[] = []
    let first: AgentActivity | undefined
    agent.ctx.on('agent/activity-draining', async ({ activity }) => {
      activities.push(activity)
      if (activities.length !== 1) return
      first = activity
      entered.resolve(undefined)
      await release.promise
      expect(agent.activity).toBe(activity)
      expect(activity.signal.aborted).toBe(true)
    })
    expect(agent.activity).toBeNull()
    agent.followup(message('first'))
    const opened = activityOf(agent)
    const idle = observe(agent.whenIdle())
    await entered.promise
    expect(first).toBe(opened)
    agent.followup(message('followup'))
    agent.steer(message('steer'))
    expect(agent.inbox.nextStep).toEqual([])
    expect(adapter.requests).toHaveLength(1)
    expect(idle.state.settled).toBe(false)
    release.resolve(undefined)
    await idle.result
    expect(adapter.requests).toHaveLength(3)
    expect(activities).toHaveLength(2)
    expect(activities[1]).not.toBe(opened)
    expect(activities.every(activity => activity.signal.aborted)).toBe(true)
    expect(agent.activity).toBeNull()
  })

  it.each(['fulfilled', 'rejected', 'aborted'] as const)('joins %s maintenance drainage while public status stays idle', async (exit) => {
    const { agent, adapter } = await harness()
    const jobRelease = Promise.withResolvers<undefined>()
    const drainEntered = Promise.withResolvers<undefined>()
    const drainRelease = Promise.withResolvers<undefined>()
    const jobFailure = new Error('maintenance rejected')
    let signal: AbortSignal | undefined
    const activityTokens: AgentActivity[] = []
    agent.ctx.on('agent/activity-draining', async ({ activity }) => {
      activityTokens.push(activity)
      if (activityTokens.length > 1) return
      expect(activity.signal.aborted).toBe(true)
      drainEntered.resolve(undefined)
      await drainRelease.promise
    })
    const maintenance = observe(agent.runMaintenance(async (operationSignal) => {
      signal = operationSignal
      await jobRelease.promise
      operationSignal.throwIfAborted()
      if (exit === 'rejected') throw jobFailure
      return 7
    }))
    const opened = activityOf(agent)
    expect(opened.signal.aborted).toBe(false)
    const idle = observe(agent.whenIdle())
    if (exit === 'aborted') agent.cancel({ kind: 'user' }, { keepInbox: true })
    jobRelease.resolve(undefined)
    await drainEntered.promise
    expect(agent.status).toBe('idle')
    expect(agent.activity).toBe(opened)
    expect(signal?.aborted).toBe(exit === 'aborted')
    expect(maintenance.state.settled).toBe(false)
    expect(idle.state.settled).toBe(false)
    expect(() => agent.runMaintenance(async () => {})).toThrow('already has active work')
    agent.followup(message('after maintenance'))
    expect(adapter.requests).toEqual([])
    drainRelease.resolve(undefined)
    const result = await maintenance.result
    if (exit === 'fulfilled') expect(result).toEqual({ ok: true, value: 7 })
    else expect(result).toMatchObject({ ok: false, error: exit === 'rejected' ? jobFailure : { kind: 'user' } })
    expect(await idle.result).toEqual({ ok: true, value: undefined })
    expect(adapter.requests).toHaveLength(1)
    expect(activityTokens).toHaveLength(2)
    expect(activityTokens[1]).not.toBe(opened)
  })

  it.each([
    { kind: 'driver', undefinedFailure: false },
    { kind: 'driver', undefinedFailure: true },
    { kind: 'maintenance', undefinedFailure: false },
    { kind: 'maintenance', undefinedFailure: true },
  ] as const)('retains $kind operation and cleanup failures with undefinedFailure=$undefinedFailure without reopening', async ({ kind, undefinedFailure }) => {
    const { ctx, agent, handle, adapter } = await harness()
    const operationFailure = undefinedFailure ? undefined : new Error('operation failed')
    const cleanupFailure = new Error('cleanup failed')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const statuses: string[] = []
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    agent.ctx.on('agent/activity-draining', async () => {
      entered.resolve(undefined)
      await release.promise
      throw cleanupFailure
    })
    let operation: ReturnType<typeof observe<unknown>> | undefined
    if (kind === 'driver') {
      ctx.on('agent/pre-step', () => { throw operationFailure })
      agent.followup(message('first'))
    } else {
      operation = observe(agent.runMaintenance(async () => { throw operationFailure }))
    }
    const idle = observe(agent.whenIdle())
    await entered.promise
    agent.followup(message('must not reopen'))
    release.resolve(undefined)
    const result = await idle.result
    if (result.ok) throw new Error('expected failed quiescence')
    expect(errorLeaves(result.error)).toEqual([operationFailure, cleanupFailure])
    if (operation !== undefined) expect(await operation.result).toEqual(result)
    expect(statuses).toEqual(kind === 'driver' ? ['running'] : [])
    expect(activityOf(agent).signal.aborted).toBe(true)
    expect(() => agent.runMaintenance(async () => {})).toThrow(AggregateError)
    agent.steer(message('also must not reopen'))
    expect(adapter.requests).toEqual([])
    await expect(agent.whenIdle()).rejects.toBe(result.error)
    const scopeDisposed = vi.fn()
    agent.ctx.effect(() => scopeDisposed)
    const disposing = handle.dispose()
    expect(handle.dispose()).toBe(disposing)
    await expect(disposing).rejects.toBe(result.error)
    expect(scopeDisposed).toHaveBeenCalledTimes(1)
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(ctx.sessions.get(agent.id)).toBeUndefined()
  })

  it('closes admission before cancellation callbacks and preserves the first cause through reentry', async () => {
    const { agent, adapter } = await harness()
    const finish = Promise.withResolvers<undefined>()
    const cause = { kind: 'user' } as const
    let operationSignal: AbortSignal | undefined
    const maintenance = observe(agent.runMaintenance(async (signal) => {
      operationSignal = signal
      signal.addEventListener('abort', () => {
        expect(activityOf(agent).signal.aborted).toBe(true)
        agent.followup(message('from operation abort'))
      }, { once: true })
      await finish.promise
      signal.throwIfAborted()
    }))
    const activity = activityOf(agent)
    activity.signal.addEventListener('abort', () => {
      expect(agent.activity).toBe(activity)
      agent.cancel({ kind: 'hook', reason: 'reentrant' }, { keepInbox: true })
    }, { once: true })
    agent.cancel(cause, { keepInbox: true })
    expect(operationSignal?.reason).toBe(cause)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    finish.resolve(undefined)
    expect(await maintenance.result).toEqual({ ok: false, error: cause })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it.each([false, true])('clears the drainage replay only when keepInbox is false (%s)', async (keepInbox) => {
    const { agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let drains = 0
    agent.ctx.on('agent/activity-draining', async () => {
      if (++drains !== 1) return
      entered.resolve(undefined)
      await release.promise
    })
    agent.followup(message('first'))
    await entered.promise
    agent.steer(message('latched'))
    agent.cancel({ kind: 'user' }, { keepInbox })
    release.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(keepInbox ? 2 : 1)
    expect(drains).toBe(keepInbox ? 2 : 1)
  })

  it('reserves maintenance quiescence before its synchronous job callback', async () => {
    const { agent } = await harness()
    const releaseJob = Promise.withResolvers<undefined>()
    const releaseDrain = Promise.withResolvers<undefined>()
    const enteredDrain = Promise.withResolvers<undefined>()
    let callbackIdle: ReturnType<typeof observe> | undefined
    let token: AgentActivity | undefined
    agent.ctx.on('agent/activity-draining', async ({ activity }) => {
      expect(activity).toBe(token)
      enteredDrain.resolve(undefined)
      await releaseDrain.promise
    })
    const maintenance = agent.runMaintenance(async () => {
      token = activityOf(agent)
      callbackIdle = observe(agent.whenIdle())
      await releaseJob.promise
    })
    expect(callbackIdle?.state.settled).toBe(false)
    releaseJob.resolve(undefined)
    await enteredDrain.promise
    expect(callbackIdle?.state.settled).toBe(false)
    releaseDrain.resolve(undefined)
    await maintenance
    expect(await callbackIdle?.result).toEqual({ ok: true, value: undefined })
  })

  it('reserves driver quiescence before a status callback reenters disposal', async () => {
    const { ctx, agent, handle, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let disposal: ReturnType<typeof observe> | undefined
    let idle: ReturnType<typeof observe> | undefined
    ctx.on('agent/status', ({ status }) => {
      if (status !== 'running') return
      idle = observe(agent.whenIdle())
      disposal = observe(handle.dispose())
    })
    agent.ctx.on('agent/activity-draining', async () => {
      entered.resolve(undefined)
      await release.promise
    })
    agent.followup(message('cancel before first step'))
    await entered.promise
    expect(idle?.state.settled).toBe(false)
    expect(disposal?.state.settled).toBe(false)
    expect(adapter.requests).toEqual([])
    release.resolve(undefined)
    expect(await disposal?.result).toEqual({ ok: true, value: undefined })
    expect(await idle?.result).toEqual({ ok: true, value: undefined })
  })

  it('observes failed driver bookkeeping without an early whenIdle waiter', async () => {
    const { agent, handle } = await harness()
    const failure = new Error('unobserved cleanup failed')
    const draining = Promise.withResolvers<undefined>()
    agent.ctx.on('agent/activity-draining', () => {
      draining.resolve(undefined)
      throw failure
    })
    agent.followup(message('first'))
    await draining.promise
    // Cross a scheduler turn so rejected bookkeeping would reach Vitest's
    // unhandled-rejection observer before installing a late quiescence waiter.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const idle = await observe(agent.whenIdle()).result
    if (idle.ok) throw new Error('expected failed quiescence')
    expect(errorLeaves(idle.error)).toEqual([failure])
    await expect(handle.dispose()).rejects.toBe(idle.error)
  })

  it('rejects fulfilled maintenance on cleanup failure and still retains its original failed quiescence', async () => {
    const { agent, handle } = await harness()
    const failure = new Error('maintenance cleanup failed')
    agent.ctx.on('agent/activity-draining', () => { throw failure })
    const maintenance = await observe(agent.runMaintenance(async () => 3)).result
    if (maintenance.ok) throw new Error('expected cleanup failure')
    expect(errorLeaves(maintenance.error)).toEqual([failure])
    await expect(agent.whenIdle()).rejects.toBe(maintenance.error)
    await expect(handle.dispose()).rejects.toBe(maintenance.error)
  })

  it('suppresses disposed-cancel idle reentry but permits a later explicit wake', async () => {
    const { ctx, agent, adapter } = await harness()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const activities: AgentActivity[] = []
    agent.ctx.on('agent/activity-draining', async ({ activity }) => {
      activities.push(activity)
      if (activities.length !== 1) return
      agent.followup(message('queued while retiring'))
      entered.resolve(undefined)
      await release.promise
    })
    let attemptedReentry = false
    ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle' || agent.activity !== null || attemptedReentry) return
      attemptedReentry = true
      agent.followup(message('idle callback must not reopen'))
      expect(() => agent.runMaintenance(async () => {})).toThrow('disposing')
    })
    agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
      if (activities.length === 0) {
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        signal.throwIfAborted()
      }
      return next()
    })
    agent.followup(message('cancel before requesting'))
    await entered.promise
    release.resolve(undefined)
    await agent.whenIdle()
    expect(attemptedReentry).toBe(true)
    expect(adapter.requests).toEqual([])
    expect(activities).toHaveLength(1)
    agent.followup(message('later explicit wake'))
    await agent.whenIdle()
    expect(activities).toHaveLength(2)
    expect(adapter.requests).toHaveLength(3)
  })

  it('permanently rejects maintenance and prevents callback or microtask wakes during actual teardown', async () => {
    const { ctx, agent, handle, adapter } = await harness()
    const activities: AgentActivity[] = []
    const queued = Promise.withResolvers<undefined>()
    agent.ctx.on('agent/activity-draining', ({ activity }) => { activities.push(activity) })
    ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return
      agent.followup(message('synchronous teardown wake'))
      expect(() => agent.runMaintenance(async () => {})).toThrow('disposing')
      queueMicrotask(() => {
        agent.followup(message('queued teardown wake'))
        expect(() => agent.runMaintenance(async () => {})).toThrow('disposing')
        queued.resolve(undefined)
      })
    })
    agent.followup(message('first'))
    const disposal = handle.dispose()
    await queued.promise
    await disposal
    expect(activities).toHaveLength(1)
    expect(adapter.requests).toEqual([])
    expect(() => { agent.followup(message('after disposal')) }).toThrow('outside a SessionStore')
    expect(() => agent.runMaintenance(async () => {})).toThrow('disposing')
    await agent.whenIdle()
    expect(activities).toHaveLength(1)
  })

  it('joins initialization drainage and rejects creation only after rolling back its scope and registries', async () => {
    const { ctx } = await harness()
    const failure = new Error('initialization cleanup failed')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const scopeDisposed = vi.fn()
    let created: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== 'initialization-drain') return
      created = agent
      agent.ctx.effect(() => scopeDisposed)
      agent.ctx.on('agent/activity-draining', async () => {
        entered.resolve(undefined)
        await release.promise
        throw failure
      })
    })
    const creation = observe(ctx.agents.create({ sessionId: SessionId('initialization-drain') }))
    await entered.promise
    expect(creation.state.settled).toBe(false)
    expect(created?.activity?.signal.aborted).toBe(true)
    expect(scopeDisposed).not.toHaveBeenCalled()
    expect(ctx.agents.get(SessionId('initialization-drain'))).toBe(created)
    release.resolve(undefined)
    const result = await creation.result
    if (result.ok) throw new Error('expected initialization failure')
    expect(errorLeaves(result.error)).toEqual([failure])
    expect(scopeDisposed).toHaveBeenCalledTimes(1)
    expect(ctx.agents.get(SessionId('initialization-drain'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('initialization-drain'))).toBeUndefined()
  })

  it('retains the primary initialization error while joining failed resource drainage without reopening', async () => {
    const { ctx, adapter } = await harness()
    const primary = new Error('setup failed')
    const cleanup = new Error('rollback drainage failed')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const scopeDisposed = vi.fn()
    let created: Agent | undefined
    const creation = observe(ctx.agents.create({
      sessionId: SessionId('setup-drain-failure'),
      setup: async (_ctx, agent) => {
        created = agent
        agent.ctx.effect(() => scopeDisposed)
        agent.ctx.on('agent/activity-draining', async () => {
          entered.resolve(undefined)
          await release.promise
          throw cleanup
        })
        agent.followup(message('must remain parked'))
        throw primary
      },
    }))
    await entered.promise
    expect(creation.state.settled).toBe(false)
    expect(created?.activity?.signal.aborted).toBe(true)
    expect(scopeDisposed).not.toHaveBeenCalled()
    release.resolve(undefined)
    const result = await creation.result
    if (result.ok) throw new Error('expected initialization failure')
    expect(result.error).toBe(primary)
    const provisional = created
    if (provisional === undefined) throw new Error('expected provisional Agent')
    const idle = await observe(provisional.whenIdle()).result
    if (idle.ok) throw new Error('expected failed drainage')
    expect(errorLeaves(idle.error)).toEqual([primary, cleanup])
    expect(provisional.activity?.signal.aborted).toBe(true)
    expect(() => provisional.runMaintenance(async () => {})).toThrow('disposing')
    expect(adapter.requests).toEqual([])
    expect(scopeDisposed).toHaveBeenCalledTimes(1)
    expect(ctx.sessions.get(SessionId('setup-drain-failure'))).toBeUndefined()
  })

  it('reserves disposal before synchronous abort reentry and joins held drainage before detaching', async () => {
    const { ctx, agent, handle, adapter } = await harness()
    const jobRelease = Promise.withResolvers<undefined>()
    const drainEntered = Promise.withResolvers<undefined>()
    const drainRelease = Promise.withResolvers<undefined>()
    const scopeDisposed = vi.fn()
    agent.ctx.effect(() => scopeDisposed)
    let reentrant: Promise<void> | undefined
    let operationSignal: AbortSignal | undefined
    const maintenance = observe(agent.runMaintenance(async (signal) => {
      operationSignal = signal
      signal.addEventListener('abort', () => {
        expect(activityOf(agent).signal.aborted).toBe(true)
        reentrant = handle.dispose()
        agent.followup(message('must not replay'))
      }, { once: true })
      await jobRelease.promise
    }))
    agent.ctx.on('agent/activity-draining', async () => {
      drainEntered.resolve(undefined)
      await drainRelease.promise
    })
    // Disposal must suppress replay even when another cancellation cause won first.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    const disposing = handle.dispose()
    const disposal = observe(disposing)
    expect(reentrant).toBe(disposing)
    expect(operationSignal?.reason).toEqual({ kind: 'user' })
    jobRelease.resolve(undefined)
    await drainEntered.promise
    expect(disposal.state.settled).toBe(false)
    expect(maintenance.state.settled).toBe(false)
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(ctx.sessions.get(agent.id)).toBe(agent.session)
    expect(scopeDisposed).not.toHaveBeenCalled()
    drainRelease.resolve(undefined)
    expect(await disposal.result).toEqual({ ok: true, value: undefined })
    await maintenance.result
    expect(scopeDisposed).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toEqual([])
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(ctx.sessions.get(agent.id)).toBeUndefined()
  })
})
