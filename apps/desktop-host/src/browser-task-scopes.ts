/**
 * Host-private browser task admission and storage capabilities. Wire epochs are
 * correlation metadata, never authority; only this registry's exact objects admit work.
 *
 * The activity owner must revokeAndDrain every owned task before publishing idle.
 * revokeAgentAndDrain permanently retires the Agent: use it only for actual Agent
 * destruction, not ordinary idle, since the same Agent can run another activity.
 * This is not integrated: turn-stopping skips cancellation/error paths, Agent scope
 * disposal follows idle, and agent/disposed is emitted rather than awaited.
 */
import { randomUUID } from 'node:crypto'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { DesktopBrowserTaskScope } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Generated wire metadata with Session identity derived from the authenticated Agent. */
export interface BrowserTaskScope extends Omit<DesktopBrowserTaskScope, 'sessionId'> {
  readonly sessionId: Agent['id']
}

declare const capabilityBrand: unique symbol

/** Task-specific Host storage identity. Never serialize or key storage by Session id. */
export interface BrowserTaskScopeCapability {
  readonly [capabilityBrand]: true
}

/** The authority-bearing members of the current ToolRunContext. */
export interface BrowserTaskExecution {
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** Expected admission failures; cleanup failures retain their original rejection. */
export type BrowserTaskScopeErrorCode =
  | 'AGENT_REQUIRED' | 'AGENT_RETIRED' | 'ABORTED' | 'SCOPE_REVOKED' | 'INVALID_SCOPE' | 'DISPOSED'

/** Admission failure with a stable discriminator for the owning transport. */
export class BrowserTaskScopeError extends Error {
  constructor(readonly code: BrowserTaskScopeErrorCode) {
    super(`Browser task scope rejected: ${code}`)
    this.name = 'BrowserTaskScopeError'
  }
}

/** Explicit Host ports; the owner must surface rejected cleanup to its lifecycle caller. */
export interface BrowserTaskScopePorts<Resource> {
  readonly agents: Pick<AgentRegistry, 'get'>
  /**
   * Acquire exclusive task resources/storage. Failure must leave no owned resources.
   * A successful late acquisition is released even if cancellation was ignored.
   * @param scope - generated correlation metadata, not authorization.
   * @param signal - task cancellation, also aborted on provider or Agent retirement.
   * @param storage - unique Host-only storage capability; must never cross IPC.
   * @returns resources owned exclusively by this task until release settles.
   */
  acquire(scope: BrowserTaskScope, signal: AbortSignal, storage: BrowserTaskScopeCapability): Promise<Resource>
  /**
   * Close task resources and storage after all admitted callbacks settle.
   * @param resource - successfully acquired task resources.
   * @param scope - matching generated metadata for private transport cleanup.
   * @returns completion of resource reclamation; rejection is retained without retry.
   */
  release(resource: Resource, scope: BrowserTaskScope): Promise<void>
}

interface AgentLifetime {
  readonly agent: Agent
  readonly epoch: string
  retired: boolean
  drain?: Promise<void>
}

interface Task<Resource> {
  readonly capability: BrowserTaskScopeCapability
  readonly owner: AgentLifetime
  readonly metadata: BrowserTaskScope
  readonly callerSignal: AbortSignal
  readonly abort: AbortController
  readonly pending: Set<Promise<void>>
  readonly onAbort: () => void
  state: 'pending' | 'admitted' | 'revoked' | 'disposed'
  resource: { kind: 'absent' } | { kind: 'acquired'; value: Resource }
  rejection?: BrowserTaskScopeError
  cleanup?: Promise<void>
}

/**
 * One private Host run/provider lifetime. The composition root supplies its
 * already-announced run epoch; all subordinate epochs are generated here.
 * No caller id, provider name, ambient initiator, or activity flag grants access.
 * Keep this module off the package entrypoint and model-facing tool registry.
 */
export class BrowserTaskScopeRegistry<Resource> {
  readonly #providerEpoch = randomUUID()
  readonly #agents = new Map<Agent, AgentLifetime>()
  readonly #tasks = new Map<BrowserTaskScopeCapability, Task<Resource>>()
  #disposed = false
  #disposal: Promise<void> | undefined

  /**
   * @param runEpoch - existing Host run UUID from the owning composition, never tool input.
   * @param ports - exact Agent lookup and task-owned acquisition/release operations.
   */
  constructor(private readonly runEpoch: BrowserTaskScope['runEpoch'], private readonly ports: BrowserTaskScopePorts<Resource>) {}

  /**
   * Reserve a pending task before invoking acquisition. Only the exact live Agent
   * carried by the executor is accepted; its Session id is derived internally.
   * @param exec - current executor Agent and caller-owned cancellation signal.
   * @returns a unique Host-only capability after acquisition and liveness recheck.
   * @throws BrowserTaskScopeError on denied admission; acquisition/release failures propagate.
   */
  admit(exec: BrowserTaskExecution): Promise<BrowserTaskScopeCapability> {
    if (this.#disposed) throw new BrowserTaskScopeError('DISPOSED')
    const agent = exec.agent
    if (agent === undefined) throw new BrowserTaskScopeError('AGENT_REQUIRED')
    if (this.ports.agents.get(agent.id) !== agent) throw new BrowserTaskScopeError('AGENT_RETIRED')
    if (exec.signal.aborted) throw new BrowserTaskScopeError('ABORTED')
    let owner = this.#agents.get(agent)
    if (owner?.retired) throw new BrowserTaskScopeError('AGENT_RETIRED')
    if (owner === undefined) {
      owner = { agent, epoch: randomUUID(), retired: false }
      this.#agents.set(agent, owner)
    }
    const capability = Object.freeze({}) as BrowserTaskScopeCapability
    const task: Task<Resource> = {
      capability, owner,
      metadata: Object.freeze({
        runEpoch: this.runEpoch, providerEpoch: this.#providerEpoch,
        agentEpoch: owner.epoch, taskId: randomUUID(), taskEpoch: randomUUID(), sessionId: agent.session.id,
      }),
      callerSignal: exec.signal, abort: new AbortController(), pending: new Set(),
      onAbort: () => { this.#revoke([task], new BrowserTaskScopeError('ABORTED')) },
      state: 'pending', resource: { kind: 'absent' },
    }
    this.#tasks.set(capability, task)
    const complete = this.#reserve(task)
    exec.signal.addEventListener('abort', task.onAbort, { once: true })
    return this.#acquire(task, complete)
  }

  /**
   * Read only generated wire metadata, after checking exact capability and liveness.
   * @param capability - the exact object returned by this registry's admission.
   * @returns frozen serializable metadata, never a Host storage capability.
   * @throws BrowserTaskScopeError for unknown, revoked, aborted, or retired ownership.
   */
  metadata(capability: BrowserTaskScopeCapability): BrowserTaskScope {
    const task = this.#task(capability)
    this.#assertAdmitted(task)
    return task.metadata
  }

  /**
   * Reserve work before invoking a task callback. After revocation, both results
   * and failures wait for cleanup; late success is rejected. The callback must
   * await all its work; detached work is not admitted.
   * @param capability - exact admitted task storage capability.
   * @param operation - task operation; resources must not escape its returned lifetime.
   * @returns the operation result only while task ownership remains valid.
   */
  async withScope<T>(
    capability: BrowserTaskScopeCapability,
    operation: (resource: Resource, scope: BrowserTaskScope, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const task = this.#task(capability)
    this.#assertAdmitted(task)
    if (task.resource.kind !== 'acquired') throw new BrowserTaskScopeError('SCOPE_REVOKED')
    const complete = this.#reserve(task)
    let result: PromiseSettledResult<T>
    try {
      result = { status: 'fulfilled', value: await operation(task.resource.value, task.metadata, task.abort.signal) }
    } catch (reason: unknown) {
      result = { status: 'rejected', reason }
    } finally {
      complete()
    }
    try {
      this.#assertAdmitted(task)
    } catch (error: unknown) {
      try { await task.cleanup }
      catch (cleanupError: unknown) {
        if (result.status === 'rejected') {
          throw new AggregateError([result.reason, cleanupError], 'Browser task operation and cleanup failed')
        }
        throw cleanupError
      }
      if (result.status === 'fulfilled') throw error
    }
    if (result.status === 'rejected') throw result.reason
    return result.value
  }

  /**
   * Invalidate synchronously, then drain acquisition/work and reclaim resources.
   * Repeated calls join the same Promise, including the original cleanup failure.
   * @param capability - exact task capability, including an already-revoked one.
   * @returns shared cleanup completion; the lifecycle owner must await and report rejection.
   */
  revokeAndDrain(capability: BrowserTaskScopeCapability): Promise<void> {
    const task = this.#task(capability)
    this.#revoke([task], new BrowserTaskScopeError('SCOPE_REVOKED'))
    return this.#cleanup(task)
  }

  /**
   * Permanently retire one exact Agent before invoking cancellation callbacks.
   * Must be awaited by the Agent lifecycle owner before idle/disposal publication;
   * no existing complete lifecycle hook currently invokes it.
   * @param agent - exact Agent owned by the retiring lifetime, not a Session id.
   * @returns joined drain of all its tasks, retaining all cleanup failures.
   */
  revokeAgentAndDrain(agent: Agent): Promise<void> {
    let owner = this.#agents.get(agent)
    if (owner === undefined) {
      owner = { agent, epoch: randomUUID(), retired: true }
      this.#agents.set(agent, owner)
    }
    if (owner.drain !== undefined) return owner.drain
    owner.retired = true
    const done = Promise.withResolvers<void>()
    owner.drain = done.promise
    this.#observeCleanup(done.promise)
    const tasks = [...this.#tasks.values()].filter(task => task.owner === owner)
    this.#revoke(tasks, new BrowserTaskScopeError('AGENT_RETIRED'))
    this.#join(tasks.map(task => this.#cleanup(task))).then(done.resolve, done.reject)
    return done.promise
  }

  /**
   * Invalidate the provider synchronously before any callback, then drain every
   * task, including previously failed cleanup. No automatic retry is attempted.
   * @returns shared provider cleanup completion; caller owns reporting rejection.
   */
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal
    this.#disposed = true
    const done = Promise.withResolvers<void>()
    this.#disposal = done.promise
    this.#observeCleanup(done.promise)
    const tasks = [...this.#tasks.values()]
    this.#revoke(tasks, new BrowserTaskScopeError('DISPOSED'))
    this.#join(tasks.map(task => this.#cleanup(task))).then(done.resolve, done.reject)
    return done.promise
  }

  #task(capability: BrowserTaskScopeCapability): Task<Resource> {
    const task = this.#tasks.get(capability)
    if (task === undefined) throw new BrowserTaskScopeError('INVALID_SCOPE')
    return task
  }

  #cleanup(task: Task<Resource>): Promise<void> {
    if (task.cleanup === undefined) throw new Error('Browser task cleanup was not reserved')
    return task.cleanup
  }

  #assertLive(task: Task<Resource>): void {
    if (task.rejection !== undefined) throw task.rejection
    if (this.#disposed) throw new BrowserTaskScopeError('DISPOSED')
    if (task.owner.retired || this.ports.agents.get(task.owner.agent.id) !== task.owner.agent) {
      void this.revokeAgentAndDrain(task.owner.agent)
      throw new BrowserTaskScopeError('AGENT_RETIRED')
    }
    if (task.callerSignal.aborted) {
      const rejection = new BrowserTaskScopeError('ABORTED')
      this.#revoke([task], rejection)
      throw rejection
    }
  }

  #assertAdmitted(task: Task<Resource>): void {
    this.#assertLive(task)
    if (task.state !== 'admitted') throw new BrowserTaskScopeError('SCOPE_REVOKED')
  }

  #reserve(task: Task<Resource>): () => void {
    const pending = Promise.withResolvers<void>()
    task.pending.add(pending.promise)
    return () => { task.pending.delete(pending.promise); pending.resolve() }
  }

  async #acquire(task: Task<Resource>, complete: () => void): Promise<BrowserTaskScopeCapability> {
    try {
      task.resource = { kind: 'acquired', value: await this.ports.acquire(task.metadata, task.abort.signal, task.capability) }
    } catch (error: unknown) {
      this.#revoke([task], new BrowserTaskScopeError('SCOPE_REVOKED'))
      throw error
    } finally {
      complete()
    }
    try {
      this.#assertLive(task)
      task.state = 'admitted'
      return task.capability
    } catch (error: unknown) {
      await task.cleanup
      throw error
    }
  }

  #revoke(tasks: readonly Task<Resource>[], rejection: BrowserTaskScopeError): void {
    const started: { task: Task<Resource>; done: ReturnType<typeof Promise.withResolvers<void>> }[] = []
    // Every task loses authority before abort listeners or resource ports can reenter.
    for (const task of tasks) {
      if (task.cleanup !== undefined) continue
      task.state = 'revoked'
      task.rejection = rejection
      const done = Promise.withResolvers<void>()
      task.cleanup = done.promise
      this.#observeCleanup(done.promise)
      started.push({ task, done })
    }
    for (const { task, done } of started) {
      task.callerSignal.removeEventListener('abort', task.onAbort)
      task.abort.abort(rejection)
      this.#release(task).then(done.resolve, done.reject)
    }
  }

  async #release(task: Task<Resource>): Promise<void> {
    try {
      await Promise.all(task.pending)
      if (task.resource.kind === 'acquired') await this.ports.release(task.resource.value, task.metadata)
    } finally {
      task.resource = { kind: 'absent' }
      task.state = 'disposed'
    }
  }

  #observeCleanup(promise: Promise<void>): void {
    void promise.catch((_error: unknown) => {
      // Abort-driven cleanup retains rejection for explicit task/Agent/provider drains.
    })
  }

  async #join(promises: readonly Promise<void>[]): Promise<void> {
    const settled = await Promise.allSettled(promises)
    const failures = settled.filter(result => result.status === 'rejected').map<unknown>(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Browser task cleanup failed')
  }
}
