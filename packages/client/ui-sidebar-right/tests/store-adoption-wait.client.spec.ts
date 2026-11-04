// @vitest-environment jsdom
/** Exact-generation publication waits on real Session scopes, without renderer-created readiness shortcuts. */
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarStoreAdoptions, type SidebarStoreAdoption } from '../src/client/store-adoptions.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 'adoption-wait' as SessionId
const runtimes: SlotTestRuntime[] = []
const owners: SidebarStoreAdoptions[] = []
const gates: Array<() => void> = []
const store = () => createSidebarRightStore(() => ({ kind: 'test', title: 'Test' })).create()
const signal = () => new AbortController().signal
const waiting = (binding: SessionBinding) => binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Store adoption wait')
const adopting = (binding: SessionBinding) => binding.ctx.fiber.getEffects().filter(effect => effect.label === 'ui-sidebar-right: Session Store adoption')

function owner(adopt: ConstructorParameters<typeof SidebarStoreAdoptions>[0] = () => () => {}) {
  const result = new SidebarStoreAdoptions(adopt)
  owners.push(result)
  return result
}

async function fixture() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.sessions.add({ id: SESSION })
  const reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'testFixture' })
  await reference.ready
  return { runtime, reference, binding: reference.binding }
}

/** Hold only the owner's cleanup; other real scope effects and generation replacement still run. */
function delayCleanup(binding: SessionBinding, label: string) {
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  gates.push(() => { finish.resolve(undefined) })
  const effect = binding.ctx.effect.bind(binding.ctx)
  vi.spyOn(binding.ctx, 'effect').mockImplementation((execute, name) => {
    if (name !== label) return effect(execute, name)
    return effect((): ReturnType<typeof execute> => {
      const cleanup = execute()
      return async () => {
        entered.resolve(undefined)
        await finish.promise
        if (typeof cleanup === 'function') await cleanup()
      }
    }, name)
  })
  return { entered: entered.promise, finish: () => { finish.resolve(undefined) } }
}

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  for (const instance of owners.splice(0)) instance.dispose()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
})

it('waits for actual adoption and removes caller/scope callbacks only after setup returns', async () => {
  const { binding, runtime } = await fixture()
  const instance = store()
  const caller = new AbortController()
  const removed = vi.spyOn(caller.signal, 'removeEventListener')
  const adopted = vi.fn(() => {
    expect(removed).not.toHaveBeenCalled()
    expect(waiting(binding)).toHaveLength(1)
    return () => {}
  })
  const subject = owner(adopted)
  const before = runtime.sessions.retainInfo(SESSION).getSnapshot()
  const promise = subject.wait(binding, caller.signal)
  expect(adopted).not.toHaveBeenCalled()
  expect(waiting(binding)).toHaveLength(1)
  subject.adopt(binding, instance)
  expect(waiting(binding)).toEqual([])
  expect(removed).toHaveBeenCalledOnce()
  const lease = await promise
  expect(lease.binding).toBe(binding)
  expect(lease.store).toBe(instance)
  expect(lease.signal.aborted).toBe(false)
  lease.assertCurrent()
  expect(runtime.sessions.retainInfo(SESSION).getSnapshot()).toBe(before)
  const immediate = await subject.wait(binding, signal())
  expect(immediate).toBe(lease)
  expect(waiting(binding)).toEqual([])
  caller.abort()
  lease.assertCurrent()
})

it('cancels independent waits without adopting or retaining anything and rejects pre-aborted calls', async () => {
  const { binding, runtime } = await fixture()
  const subject = owner()
  const first = new AbortController()
  const reason = new Error('caller stopped')
  first.abort(reason)
  await expect(subject.wait(binding, first.signal)).rejects.toBe(reason)
  expect(waiting(binding)).toEqual([])
  const cancelled = new AbortController()
  const remove = vi.spyOn(cancelled.signal, 'removeEventListener')
  const rejected = expect(subject.wait(binding, cancelled.signal)).rejects.toBe(reason)
  const survivor = subject.wait(binding, signal())
  expect(waiting(binding)).toHaveLength(2)
  cancelled.abort(reason)
  expect(waiting(binding)).toHaveLength(1)
  expect(remove).toHaveBeenCalledOnce()
  subject.adopt(binding, store())
  await rejected
  const lease = await survivor
  lease.assertCurrent()
  expect(runtime.sessions.retainInfo(SESSION).getSnapshot().referenceCount).toBe(1)
})

it('unregisters a caller callback installed after synchronous cancellation during registration', async () => {
  const { binding } = await fixture()
  const subject = owner()
  const caller = new AbortController()
  const reason = new Error('cancel during listener registration')
  const add = caller.signal.addEventListener.bind(caller.signal)
  const remove = vi.spyOn(caller.signal, 'removeEventListener')
  vi.spyOn(caller.signal, 'addEventListener').mockImplementation((...args) => {
    add(...args)
    caller.abort(reason)
    add(...args)
  })
  await expect(subject.wait(binding, caller.signal)).rejects.toBe(reason)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(waiting(binding)).toEqual([])
  subject.adopt(binding, store())
})

it('honors cancellation inside setup and during publication without starving another waiter', async () => {
  const { binding } = await fixture()
  const duringSetup = new AbortController()
  const duringPublication = new AbortController()
  const first = new AbortController()
  const reason = new Error('cancel during publication')
  const subject = owner(() => {
    duringSetup.abort(reason)
    return () => {}
  })
  const setupRejected = expect(subject.wait(binding, duringSetup.signal)).rejects.toBe(reason)
  const firstWait = subject.wait(binding, first.signal)
  const publicationRejected = expect(subject.wait(binding, duringPublication.signal)).rejects.toBe(reason)
  const remove = first.signal.removeEventListener.bind(first.signal)
  vi.spyOn(first.signal, 'removeEventListener').mockImplementation((...args) => {
    remove(...args)
    duringPublication.abort(reason)
  })
  const survivor = subject.wait(binding, signal())
  subject.adopt(binding, store())
  await setupRejected
  await publicationRejected
  expect(await survivor).toBe(await firstWait)
  expect(waiting(binding)).toEqual([])
})

it('does not publish an adoption superseded inside its setup and withdraws the late return once', async () => {
  const { binding } = await fixture()
  const stale = store()
  const replacement = store()
  const withdrawStale = vi.fn()
  const withdrawReplacement = vi.fn()
  const subject = owner((_id, instance) => {
    if (instance === stale) {
      subject.adopt(binding, replacement)
      return withdrawStale
    }
    return withdrawReplacement
  })
  const promise = subject.wait(binding, signal())
  subject.adopt(binding, stale)
  const lease = await promise
  expect(lease.store).toBe(replacement)
  lease.assertCurrent()
  expect(withdrawStale).toHaveBeenCalledOnce()
  expect(withdrawReplacement).not.toHaveBeenCalled()
  expect(adopting(binding)).toHaveLength(1)
  subject.dispose()
  expect(withdrawStale).toHaveBeenCalledOnce()
  expect(withdrawReplacement).toHaveBeenCalledOnce()
})

it('revokes fulfilled leases even for same-binding replacement before the await continuation', async () => {
  const { binding } = await fixture()
  const subject = owner()
  const promise = subject.wait(binding, signal())
  subject.adopt(binding, store())
  const replacement = store()
  subject.adopt(binding, replacement)
  const stale = await promise
  expect(stale.signal.aborted).toBe(true)
  expect(() => { stale.assertCurrent() }).toThrow('replaced')
  const current = await subject.wait(binding, signal())
  expect(current.store).toBe(replacement)
  current.assertCurrent()
})

it('lets the newest adoption win synchronous reentry from revocation and previous withdrawal', async () => {
  const { binding } = await fixture()
  const first = store()
  const skipped = store()
  const fromAbort = store()
  const newest = store()
  const adopted = vi.fn<ConstructorParameters<typeof SidebarStoreAdoptions>[0]>((_id, instance) => {
    return instance === first ? () => { subject.adopt(binding, newest) } : () => {}
  })
  const subject = owner(adopted)
  subject.adopt(binding, first)
  const lease = await subject.wait(binding, signal())
  lease.signal.addEventListener('abort', () => { subject.adopt(binding, fromAbort) }, { once: true })
  subject.adopt(binding, skipped)
  expect(adopted.mock.calls.map(call => call[1])).toEqual([first, fromAbort, newest])
  expect((await subject.wait(binding, signal())).store).toBe(newest)
  expect(adopting(binding)).toHaveLength(1)
})

it('rejects an old-generation pending wait as soon as a new same-id adoption arrives despite delayed old teardown', async () => {
  const { binding, reference, runtime } = await fixture()
  const subject = owner()
  const delayed = delayCleanup(binding, 'ui-sidebar-right: Store adoption wait')
  const rejected = expect(subject.wait(binding, signal())).rejects.toThrow('generation was replaced')
  reference.release()
  await delayed.entered
  const next = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'testFixture' })
  await next.ready
  expect(next.binding).not.toBe(binding)
  const replacement = store()
  subject.adopt(next.binding, replacement)
  await rejected
  const lease = await subject.wait(next.binding, signal())
  // An unloading real scope refuses new effects, even while its cleanup is held.
  await expect(subject.wait(binding, signal())).rejects.toThrow()
  delayed.finish()
  await runtime.flush()
  expect(lease.store).toBe(replacement)
  lease.assertCurrent()
  expect(adopting(next.binding)).toHaveLength(1)
})

it('revokes an old-generation lease before its delayed scope cleanup and never rejects the successor', async () => {
  const { binding, reference, runtime } = await fixture()
  const subject = owner()
  const delayed = delayCleanup(binding, 'ui-sidebar-right: Session Store adoption')
  subject.adopt(binding, store())
  const old = await subject.wait(binding, signal())
  reference.release()
  await delayed.entered
  expect(old.signal.aborted).toBe(false)
  const next = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'testFixture' })
  await next.ready
  const pending = subject.wait(next.binding, signal())
  subject.adopt(next.binding, store())
  expect(old.signal.aborted).toBe(true)
  expect(() => { old.assertCurrent() }).toThrow('replaced')
  const current = await pending
  delayed.finish()
  await runtime.flush()
  current.assertCurrent()
})

it.each(['scope disposal', 'reference release'] as const)(
  'rejects a retired scope immediately and in ordinary sibling cleanup before adoption abort: %s',
  async (retirement) => {
    const { binding, reference, runtime } = await fixture()
    const subject = owner()
    subject.adopt(binding, store())
    const lease = await subject.wait(binding, signal())
    const observe = () => {
      let current = true
      try { lease.assertCurrent() } catch { current = false }
      return { aborted: lease.signal.aborted, current }
    }
    const sibling = vi.fn(observe)
    binding.ctx.effect(() => () => { sibling() }, 'test: ordinary sibling checks retired adoption')
    const disposal = retirement === 'scope disposal' ? binding.ctx.fiber.dispose() : undefined
    if (retirement === 'reference release') reference.release()
    const immediate = observe()
    await disposal
    await runtime.flush()
    expect(immediate).toEqual({ aborted: false, current: false })
    expect(sibling).toHaveReturnedWith({ aborted: false, current: false })
    expect(sibling).toHaveBeenCalledOnce()
    expect(lease.signal.aborted).toBe(true)
    expect(() => { lease.assertCurrent() }).toThrow('generation stopped')
  },
)

it('rejects a lease inside real retention publication before the retired scope fiber begins disposal', async () => {
  const { binding, reference, runtime } = await fixture()
  const subject = owner()
  subject.adopt(binding, store())
  const lease = await subject.wait(binding, signal())
  let pending: Promise<string> | undefined
  const observer = vi.fn(() => {
    binding.ctx.fiber.assertActive()
    pending = subject.wait(binding, signal()).then(() => 'fulfilled', () => 'rejected')
    let current = true
    try { lease.assertCurrent() } catch { current = false }
    return { binding: binding.ctx.sessions.binding(SESSION), aborted: lease.signal.aborted, current }
  })
  const unsubscribe = runtime.sessions.retainInfo(SESSION).subscribe(observer)
  reference.release()
  unsubscribe()
  await runtime.flush()
  expect(observer).toHaveReturnedWith({ binding: undefined, aborted: false, current: false })
  expect(observer).toHaveBeenCalledOnce()
  expect(await pending).toBe('rejected')
  expect(lease.signal.aborted).toBe(true)
  expect(() => { lease.assertCurrent() }).toThrow('generation stopped')
})

it('rejects a late retired-binding adoption before touching its reentrant same-id successor', async () => {
  const { binding, reference, runtime } = await fixture()
  const adopted = vi.fn<ConstructorParameters<typeof SidebarStoreAdoptions>[0]>(() => () => {})
  const subject = owner(adopted)
  const first = store()
  const replacement = store()
  const stale = store()
  subject.adopt(binding, first)
  const successor = Promise.withResolvers<SidebarStoreAdoption>()
  let replacing = false
  let staleError: unknown
  const observer = vi.fn(() => {
    if (replacing) return
    replacing = true
    const next = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'testFixture' })
    subject.adopt(next.binding, replacement)
    void subject.wait(next.binding, signal()).then(successor.resolve, successor.reject)
    binding.ctx.fiber.assertActive()
    try { subject.adopt(binding, stale) } catch (error) { staleError = error }
  })
  const unsubscribe = runtime.sessions.retainInfo(SESSION).subscribe(observer)
  reference.release()
  unsubscribe()
  const lease = await successor.promise
  await runtime.flush()
  expect(staleError).toBeInstanceOf(Error)
  expect(adopted.mock.calls.map(call => call[1])).toEqual([first, replacement])
  expect(lease.store).toBe(replacement)
  expect(lease.signal.aborted).toBe(false)
  lease.assertCurrent()
  expect(adopting(lease.binding)).toHaveLength(1)
})

it('rejects pending publication when adoption setup retires its real Session generation', async () => {
  const { binding, reference, runtime } = await fixture()
  const withdraw = vi.fn()
  const subject = owner(() => {
    reference.release()
    return withdraw
  })
  const publication = subject.wait(binding, signal()).then(() => 'fulfilled', () => 'rejected')
  let failed = false
  try { subject.adopt(binding, store()) } catch { failed = true }
  await runtime.flush()
  expect(await publication).toBe('rejected')
  expect(failed).toBe(true)
  expect(withdraw).toHaveBeenCalledOnce()
  expect(waiting(binding)).toEqual([])
  expect(adopting(binding)).toEqual([])
})

it('rejects pending waits and revokes leases on generation teardown', async () => {
  const { binding, reference, runtime } = await fixture()
  const pendingOwner = owner()
  const rejected = expect(pendingOwner.wait(binding, signal())).rejects.toThrow('generation stopped')
  const adoptedOwner = owner()
  const withdraw = vi.fn()
  const adopted = owner(() => withdraw)
  adopted.adopt(binding, store())
  const lease = await adopted.wait(binding, signal())
  reference.release()
  await runtime.flush()
  await rejected
  expect(lease.signal.aborted).toBe(true)
  expect(() => { lease.assertCurrent() }).toThrow('generation stopped')
  expect(withdraw).toHaveBeenCalledOnce()
  expect(waiting(binding)).toEqual([])
  expect(adopting(binding)).toEqual([])
  await expect(adoptedOwner.wait(binding, signal())).rejects.toThrow()
})

it('rejects pending waits and unregisters every callback synchronously on feature shutdown', async () => {
  const { binding } = await fixture()
  const subject = owner()
  const rejected = expect(subject.wait(binding, signal())).rejects.toThrow('owner is disposed')
  subject.dispose()
  expect(waiting(binding)).toEqual([])
  await rejected
  await expect(subject.wait(binding, signal())).rejects.toThrow('owner is disposed')
  expect(() => { subject.adopt(binding, store()) }).toThrow('owner is disposed')
  const withdraw = vi.fn()
  const adopted = owner(() => withdraw)
  adopted.adopt(binding, store())
  const lease = await adopted.wait(binding, signal())
  adopted.dispose()
  adopted.dispose()
  expect(lease.signal.aborted).toBe(true)
  expect(() => { lease.assertCurrent() }).toThrow('owner is disposed')
  expect(withdraw).toHaveBeenCalledOnce()
  expect(adopting(binding)).toEqual([])
})

it('rejects current setup failure and permits a later successful retry', async () => {
  const { binding } = await fixture()
  const failure = new Error('setup failed')
  const adopt = vi.fn(() => () => {}).mockImplementationOnce(() => { throw failure })
  const subject = owner(adopt)
  const rejected = expect(subject.wait(binding, signal())).rejects.toBe(failure)
  expect(() => { subject.adopt(binding, store()) }).toThrow(failure)
  expect(waiting(binding)).toEqual([])
  expect(adopting(binding)).toEqual([])
  await rejected
  const retry = subject.wait(binding, signal())
  subject.adopt(binding, store())
  const lease = await retry
  lease.assertCurrent()
})

it('does not let stale setup failure reject a successful reentrant successor', async () => {
  const { binding } = await fixture()
  const stale = store()
  const replacement = store()
  const failure = new Error('stale setup failed')
  const withdraw = vi.fn()
  const subject = owner((_id, instance) => {
    if (instance === stale) {
      subject.adopt(binding, replacement)
      throw failure
    }
    return withdraw
  })
  const promise = subject.wait(binding, signal())
  expect(() => { subject.adopt(binding, stale) }).toThrow(failure)
  const lease = await promise
  expect(lease.store).toBe(replacement)
  lease.assertCurrent()
  expect(waiting(binding)).toEqual([])
  expect(adopting(binding)).toHaveLength(1)
  expect(withdraw).not.toHaveBeenCalled()
})

it('rejects waits created inside setup when shutdown precedes its late withdrawal return', async () => {
  const { binding } = await fixture()
  const withdraw = vi.fn()
  let nested: Promise<SidebarStoreAdoption> | undefined
  const subject = owner(() => {
    nested = subject.wait(binding, signal())
    void nested.catch(() => {})
    subject.dispose()
    expect(waiting(binding)).toEqual([])
    expect(adopting(binding)).toEqual([])
    return withdraw
  })
  const rejected = expect(subject.wait(binding, signal())).rejects.toThrow('owner is disposed')
  subject.adopt(binding, store())
  await rejected
  await expect(nested).rejects.toThrow('owner is disposed')
  expect(withdraw).toHaveBeenCalledOnce()
  subject.dispose()
  expect(withdraw).toHaveBeenCalledOnce()
})
