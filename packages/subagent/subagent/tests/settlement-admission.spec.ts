/** Settlement observation distinguishes transient contention from closed resource ownership. */
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentActivityBusyError, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startTestActivation } from './local-activation.ts'
import { managerState } from './manager-internals.ts'

async function harness() {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('child answer')]))
  ctx.subagents.registerProvider({
    name: 'local',
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('settlement-admission-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const entered = Promise.withResolvers<Agent>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent !== parent) {
      entered.resolve(agent)
      await release.promise
    }
    return next()
  })
  const activation = await startTestActivation(ctx, 'local', {
    parent, prompt: [{ type: 'text', text: 'child task' }],
  })
  const child = await entered.promise
  const local = managerState(ctx).resident.get(child.id)
  if (local?.kind !== 'local') throw new Error('expected resident local activation')
  return { ctx, parent, activation, child, local, release }
}

function errorLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error]
}

function observeReports(ctx: Context) {
  const reported = Promise.withResolvers<string>()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => {
    if (typeof message === 'string' && message.includes(' teardown failed:')) reported.resolve(message)
  })
  return { reported, warn }
}

describe('local settlement admission', () => {
  it('retries only typed transient contention and joins the competing activity', async () => {
    const { ctx, activation, child, local, release } = await harness()
    const { warn } = observeReports(ctx)
    const enteredBusy = Promise.withResolvers<undefined>()
    const releaseBusy = Promise.withResolvers<undefined>()
    onTestFinished(() => { releaseBusy.resolve(undefined) })
    const maintain = child.runMaintenance.bind(child)
    let competing: Promise<unknown> | undefined
    const runMaintenance = vi.spyOn(child, 'runMaintenance').mockImplementationOnce((job) => {
      competing = maintain(async () => {
        enteredBusy.resolve(undefined)
        await releaseBusy.promise
      })
      expect(() => maintain(async () => {})).toThrow(AgentActivityBusyError)
      return maintain(job)
    })
    const dispose = vi.spyOn(local.handle, 'dispose')
    let settled = false
    const result = activation.result.then((value) => { settled = true; return value })
    release.resolve(undefined)
    await enteredBusy.promise
    await setImmediate()
    expect(runMaintenance).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    expect(dispose).not.toHaveBeenCalled()
    releaseBusy.resolve(undefined)
    await competing
    expect(await result).toMatchObject({ stopReason: 'completed' })
    await activation.dispose()
    await setImmediate()
    expect(runMaintenance).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(managerState(ctx).resident.has(child.id)).toBe(false)
    expect(ctx.agents.get(child.id)).toBeUndefined()
  })

  it.each(['retired', 'unexpected'] as const)('closes rather than retrying %s maintenance admission and reports once', async (failureKind) => {
    const { ctx, activation, child, local, release } = await harness()
    const { reported, warn } = observeReports(ctx)
    const unexpected = new Error('maintenance admission failed')
    const maintain = child.runMaintenance.bind(child)
    let retiring: Promise<void> | undefined
    const runMaintenance = vi.spyOn(child, 'runMaintenance').mockImplementationOnce((job) => {
      if (failureKind === 'unexpected') throw unexpected
      retiring = local.handle.dispose()
      return maintain(job)
    })
    const dispose = vi.spyOn(local.handle, 'dispose')
    release.resolve(undefined)
    expect(await activation.result).toMatchObject({ stopReason: 'aborted' })
    const report = await reported.promise
    expect(report).toContain(failureKind === 'retired' ? 'is disposing' : unexpected.message)
    await activation.dispose()
    await retiring
    await setImmediate()
    expect(runMaintenance).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(failureKind === 'retired' ? 2 : 1)
    expect(warn.mock.calls.filter(([message]) => typeof message === 'string' && message.includes(' teardown failed:'))).toHaveLength(1)
    expect(managerState(ctx).resident.has(child.id)).toBe(false)
    expect(ctx.agents.get(child.id)).toBeUndefined()
  })

  it.each(['maintenance-drain', 'handle-cleanup'] as const)('rejects a naturally settled receipt on %s failure after joining cleanup', async (failureKind) => {
    const { ctx, activation, child, local, release } = await harness()
    const { reported, warn } = observeReports(ctx)
    const failure = new Error(`${failureKind} failed`)
    const scopeDisposed = vi.fn()
    child.ctx.effect(() => scopeDisposed)
    const disposeHandle = local.handle.dispose.bind(local.handle)
    const dispose = vi.spyOn(local.handle, 'dispose')
    if (failureKind === 'maintenance-drain') {
      child.ctx.on('agent/activity-draining', () => {
        if (child.status === 'idle') throw failure
      })
    } else {
      dispose.mockImplementation(async () => {
        await disposeHandle()
        throw failure
      })
    }
    const runMaintenance = vi.spyOn(child, 'runMaintenance')
    const result = activation.result.then(
      () => { throw new Error('expected rejected activation result') },
      (error: unknown) => error,
    )
    release.resolve(undefined)
    const outcome = await result
    expect(outcome).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(scopeDisposed).toHaveBeenCalledTimes(1)
    expect(await reported.promise).toContain(failure.message)
    await expect(activation.dispose()).rejects.toBe(outcome)
    await setImmediate()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(runMaintenance).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(managerState(ctx).resident.has(child.id)).toBe(false)
    expect(ctx.agents.get(child.id)).toBeUndefined()
    expect(ctx.sessions.get(child.id)).toBeUndefined()
  })

  it('observes rejected quiescence immediately while descendant drainage remains held', async () => {
    const { ctx, parent, activation, child, local, release } = await harness()
    const { reported, warn } = observeReports(ctx)
    const failure = new Error('parent activity drainage failed')
    const descendantEntered = Promise.withResolvers<undefined>()
    const descendantAbort = Promise.withResolvers<undefined>()
    const cleanupEntered = Promise.withResolvers<undefined>()
    const cleanupRelease = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (agent !== parent && agent !== child) {
        signal.addEventListener('abort', () => { descendantAbort.resolve(undefined) }, { once: true })
        descendantEntered.resolve(undefined)
        await descendantAbort.promise
      }
      return next()
    })
    ctx.on('agent/activity-draining', async ({ agent }) => {
      if (agent !== parent && agent !== child && agent.status === 'running') {
        cleanupEntered.resolve(undefined)
        await cleanupRelease.promise
      }
    })
    const descendant = await startTestActivation(ctx, 'local', {
      parent: child, prompt: [{ type: 'text', text: 'descendant task' }],
    })
    child.ctx.on('agent/activity-draining', async () => {
      await descendantEntered.promise
      throw failure
    })
    const unhandled: unknown[] = []
    const observeUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', observeUnhandled)
    onTestFinished(() => { process.off('unhandledRejection', observeUnhandled) })
    const idle = child.whenIdle().then(
      () => { throw new Error('expected failed quiescence') },
      (error: unknown) => error,
    )
    let settled = false
    const result = activation.result.then(
      () => { settled = true; throw new Error('expected rejected activation result') },
      (error: unknown) => { settled = true; return error },
    )
    const dispose = vi.spyOn(local.handle, 'dispose')
    try {
      release.resolve(undefined)
      await cleanupEntered.promise
      // Node publishes unhandled rejections at this turn boundary, before held cleanup can finish.
      await setImmediate()
      expect(unhandled).toEqual([])
      expect(settled).toBe(false)
      expect(dispose).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      descendantAbort.resolve(undefined)
      cleanupRelease.resolve(undefined)
    }
    const idleFailure = await idle
    expect(errorLeaves(idleFailure)).toEqual([failure])
    expect(await result).toBe(idleFailure)
    expect(await reported.promise).toContain(failure.message)
    await expect(activation.dispose()).rejects.toThrow('activation teardown failed')
    expect(await descendant.result).toMatchObject({ stopReason: 'aborted' })
    await descendant.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ctx.agents.get(child.id)).toBeUndefined()
    expect(ctx.agents.get(descendant.childId)).toBeUndefined()
    expect(ctx.sessions.get(child.id)).toBeUndefined()
    expect(ctx.sessions.get(descendant.childId)).toBeUndefined()
  })

  it('observes failed whenIdle drainage, rejects the receipt, and releases activation ownership once', async () => {
    const { ctx, activation, child, local, release } = await harness()
    const { reported, warn } = observeReports(ctx)
    const failure = new Error('child resource drainage failed')
    child.ctx.on('agent/activity-draining', () => { throw failure })
    const dispose = vi.spyOn(local.handle, 'dispose')
    const runMaintenance = vi.spyOn(child, 'runMaintenance')
    const idle = child.whenIdle().catch((error: unknown) => error)
    const result = activation.result.then(
      () => { throw new Error('expected rejected activation result') },
      (error: unknown) => error,
    )
    release.resolve(undefined)
    const idleFailure = await idle
    expect(errorLeaves(idleFailure)).toEqual([failure])
    expect(await result).toBe(idleFailure)
    expect(await reported.promise).toContain(failure.message)
    const closing = activation.dispose()
    expect(activation.dispose()).toBe(closing)
    await expect(closing).rejects.toThrow('activation teardown failed')
    await setImmediate()
    expect(runMaintenance).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(managerState(ctx).resident.has(child.id)).toBe(false)
    expect(ctx.agents.get(child.id)).toBeUndefined()
    expect(ctx.sessions.get(child.id)).toBeUndefined()
  })
})
