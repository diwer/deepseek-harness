/** Private reverse Host IPC; a cancellation answer proves task-wide quiescence, not receipt. */
import { z } from 'zod'
import type {
  DesktopBrowserTaskCancelled, DesktopBrowserTaskCommand, DesktopBrowserTaskReply,
  DesktopBrowserTaskRequest, DesktopBrowserTaskResult, DesktopBrowserTaskScope,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const scopeSchema = z.strictObject({
  runEpoch: z.uuid(), providerEpoch: z.uuid(), agentEpoch: z.uuid(), taskId: z.uuid(), taskEpoch: z.uuid(),
  sessionId: z.string().min(1).max(4096),
})
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare') }),
  z.strictObject({ action: z.literal('navigate'), lease: z.uuid(), url: z.string().min(1).max(8192) }),
  z.strictObject({ action: z.literal('screenshot'), lease: z.uuid() }),
  z.strictObject({ action: z.literal('release'), lease: z.uuid() }),
])
const identity = { direction: z.literal('host-to-main'), requestId: z.number().int().positive(), scope: scopeSchema }
const requestSchema = z.strictObject({
  type: z.literal('browser-task/request'), ...identity,
  deadlineAt: z.number().int().positive(), command: commandSchema,
})
const cancelSchema = z.strictObject({ type: z.literal('browser-task/cancel'), ...identity })

/** Main owns native task resources; renderer responses may never substitute another guest lease. */
export interface DesktopBrowserTaskHandler {
  /** @param request - validated Host request. @param signal - task cancellation/deadline. @returns owned result. */
  execute(request: DesktopBrowserTaskRequest, signal: AbortSignal): Promise<DesktopBrowserTaskResult>
  /** Stop admission synchronously before awaiting. @param scope - exact task. @returns after every native resource drains. */
  retire(scope: DesktopBrowserTaskScope): Promise<void>
}

interface Task {
  readonly scope: DesktopBrowserTaskScope
  readonly requests: Map<number, Request>
  retirement?: Promise<void>
}
interface Request {
  readonly request: DesktopBrowserTaskRequest
  readonly abort: AbortController
  readonly done: PromiseWithResolvers<void>
  timer?: ReturnType<typeof setTimeout>
}

/** Reserved namespaces keep these requests separate from numeric Main-to-Host shell control ids. */
export class DesktopBrowserTaskServer {
  private readonly tasks = new Map<string, Task>()
  private readonly accepted = new Map<number, Task>()
  private readonly outgoing = new Set<Promise<void>>()
  private readonly workFailures: unknown[] = []
  private lastRequestId = 0
  private closed = false
  private draining: Promise<void> | undefined
  private closing: Promise<void> | undefined

  /**
   * @param runEpoch - exact child's announced run UUID.
   * @param send - rejects disconnected sends; acknowledgement must reach that same child.
   * @param handler - Main-owned native task implementation; absent means unsupported, never manual fallback.
   * @param onFailure - observes asynchronous send failures and failed deadline cleanup.
   */
  constructor(private readonly runEpoch: string,
    private readonly send: (reply: DesktopBrowserTaskReply | DesktopBrowserTaskCancelled) => Promise<void>,
    private readonly handler: DesktopBrowserTaskHandler | undefined,
    private readonly onFailure: (error: Error) => void) {}

  /**
   * Consume only this private namespace. Invalid, replayed or wrong-run messages throw before callbacks.
   * @param message - raw child IPC event.
   * @returns whether this server consumed the event.
   */
  receive(message: unknown): boolean {
    if (typeof message !== 'object' || message === null || !('type' in message)
      || typeof message.type !== 'string' || !message.type.startsWith('browser-task/')) return false
    if (this.closed) throw new Error('desktop browser: task channel is closed')
    if (message.type === 'browser-task/cancel') {
      const cancel = cancelSchema.parse(message)
      const task = this.accepted.get(cancel.requestId)
      if (task === undefined || !this.sameScope(task.scope, cancel.scope)) {
        throw new Error('desktop browser: unknown task cancellation')
      }
      this.track(this.cancel(task, cancel.requestId))
      return true
    }
    const parsed = requestSchema.parse(message)
    if (parsed.scope.runEpoch !== this.runEpoch || parsed.requestId <= this.lastRequestId) {
      throw new Error('desktop browser: stale task request')
    }
    // Ordered process IPC gives each Host request one strictly increasing id. Never evict replay protection.
    if (this.accepted.size >= 65_536) throw new Error('desktop browser: task channel request limit reached')
    if (parsed.deadlineAt > Date.now() + 30_000) {
      throw new Error('desktop browser: invalid task deadline')
    }
    const existing = this.tasks.get(parsed.scope.taskId)
    if (existing !== undefined && !this.sameScope(existing.scope, parsed.scope)) {
      throw new Error('desktop browser: task identity changed')
    }
    const task: Task = existing ?? { scope: parsed.scope, requests: new Map() }
    const request: DesktopBrowserTaskRequest = {
      ...parsed, command: parsed.command as DesktopBrowserTaskCommand,
    }
    const pending: Request = { request, abort: new AbortController(), done: Promise.withResolvers<void>() }
    this.lastRequestId = request.requestId
    this.tasks.set(task.scope.taskId, task)
    this.accepted.set(request.requestId, task)
    task.requests.set(request.requestId, pending)
    // All reservations precede handler calls, timers, abort listeners and synchronous reentry.
    if (this.draining !== undefined || task.retirement !== undefined || request.deadlineAt <= Date.now()) {
      // In-flight shutdown work and deadlines that expired in IPC are ordinary task failures, not Host corruption.
      this.track(this.retire(task))
      pending.abort.abort(new Error('desktop browser: task retired'))
    } else {
      pending.timer = setTimeout(() => { this.track(this.retire(task)) }, request.deadlineAt - Date.now())
    }
    this.track(this.execute(task, pending))
    return true
  }

  /** Close native admission before callbacks, retaining cancellation IPC for graceful Host teardown. @returns joined native drain. */
  drain(): Promise<void> {
    if (this.draining !== undefined) return this.draining
    const completion = Promise.withResolvers<void>()
    this.draining = completion.promise
    void (async () => {
      const cleanup = await Promise.allSettled([...this.tasks.values()].map(task => this.retire(task)))
      const failures = cleanup.filter(result => result.status === 'rejected').map<unknown>(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'desktop browser: task channel cleanup failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  /** Stop disconnected transport. @returns joined cleanup, retaining native/send failures for every owner. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    void (async () => {
      const cleanup = await Promise.allSettled([this.drain()])
      await Promise.allSettled([...this.outgoing])
      const failures = new Set([...cleanup.filter(result => result.status === 'rejected').map<unknown>(result => result.reason), ...this.workFailures])
      if (failures.size > 0) throw new AggregateError(failures, 'desktop browser: task channel cleanup failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async execute(task: Task, pending: Request): Promise<void> {
    const { request, abort } = pending
    let outcome: DesktopBrowserTaskReply['outcome']
    try {
      abort.signal.throwIfAborted()
      if (this.handler === undefined) throw new Error('desktop browser: native task provider is unavailable')
      const value = await this.handler.execute(request, abort.signal)
      abort.signal.throwIfAborted()
      outcome = { kind: 'result', value }
    } catch (error: unknown) {
      outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (pending.timer !== undefined) { clearTimeout(pending.timer); delete pending.timer }
      task.requests.delete(request.requestId)
      // A retiring task waits for actual execution, including late native results, before releasing resources.
      pending.done.resolve()
    }
    // A deadline must not publish an acquisition failure before its late native resource has drained.
    if (abort.signal.aborted && task.retirement !== undefined) {
      try { await task.retirement }
      catch (error: unknown) { outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) } }
    }
    if (!this.closed) await this.send({
      type: 'browser-task/reply', direction: 'main-to-host', requestId: request.requestId, scope: task.scope, outcome,
    })
  }

  private retire(task: Task): Promise<void> {
    if (task.retirement !== undefined) return task.retirement
    const completion = Promise.withResolvers<void>()
    task.retirement = completion.promise
    const pending = [...task.requests.values()]
    // The native owner closes admission now, before any abort callback can reenter it.
    let native: Promise<void>
    try { native = this.handler?.retire(task.scope) ?? Promise.resolve() }
    catch (error: unknown) { native = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    // The joined retirement was reserved before either native cleanup or these callbacks.
    for (const request of pending) request.abort.abort(new Error('desktop browser: task retired'))
    void (async () => {
      const results = await Promise.allSettled([native, ...pending.map(request => request.done.promise)])
      const failures = results.filter(result => result.status === 'rejected').map<unknown>(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'desktop browser: native task retirement failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async cancel(task: Task, requestId: number): Promise<void> {
    let error: string | undefined
    try { await this.retire(task) }
    catch (failure: unknown) { error = failure instanceof Error ? failure.message : String(failure) }
    if (!this.closed) await this.send({
      type: 'browser-task/cancelled', direction: 'main-to-host', requestId, scope: task.scope,
      ...(error === undefined ? {} : { error }),
    })
  }

  private track(work: Promise<void>): void {
    this.outgoing.add(work)
    void work.then(() => { this.outgoing.delete(work) }, (error: unknown) => {
      this.workFailures.push(error)
      this.outgoing.delete(work)
      try { this.onFailure(error instanceof Error ? error : new Error(String(error))) }
      catch (failure: unknown) { console.error('desktop browser task failure reporter failed', failure) }
    })
  }

  private sameScope(left: DesktopBrowserTaskScope, right: DesktopBrowserTaskScope): boolean {
    return left.runEpoch === right.runEpoch && left.providerEpoch === right.providerEpoch
      && left.agentEpoch === right.agentEpoch && left.taskId === right.taskId
      && left.taskEpoch === right.taskEpoch && left.sessionId === right.sessionId
  }
}
