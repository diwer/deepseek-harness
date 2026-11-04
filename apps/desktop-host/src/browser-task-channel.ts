/** Correlates private Host/Main Browser work; only cancellation acknowledgements establish task drainage. */
import type {
  DesktopBrowserLeaseId,
  DesktopBrowserTaskCancel,
  DesktopBrowserTaskCommand,
  DesktopBrowserTaskRequest,
  DesktopBrowserTaskResult,
  DesktopBrowserTaskScope,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const MAX_DEADLINE_MS = 30_000
const uuid = /^(?:[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}|0{8}(-0{4}){3}-0{12}|f{8}(-f{4}){3}-f{12})$/i
const scopeFields = ['runEpoch', 'providerEpoch', 'agentEpoch', 'taskId', 'taskEpoch', 'sessionId'] as const
const resultActions = { prepare: 'prepared', navigate: 'navigated', screenshot: 'screenshot', release: 'released' } as const

type FailureCode = 'INVALID_SCOPE' | 'INVALID_DEADLINE' | 'CLOSED' | 'RETIRED' | 'ABORTED' | 'DEADLINE'
  | 'REMOTE_ERROR' | 'SEND_FAILED' | 'DISCONNECTED' | 'CANCEL_FAILED' | 'PROTOCOL_ERROR'

/** Private transport failure; disconnect and failed cancellation leave native quiescence unknown. */
export class BrowserTaskChannelError extends Error {
  constructor(readonly code: FailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserTaskChannelError'
  }
}

interface Ports {
  readonly send: (message: DesktopBrowserTaskRequest | DesktopBrowserTaskCancel) => Promise<void>
  readonly onFailure: (error: BrowserTaskChannelError) => void
}

interface Request {
  readonly id: number
  readonly task: Task
  readonly command: DesktopBrowserTaskCommand
  readonly result: PromiseWithResolvers<DesktopBrowserTaskResult>
  readonly signal: AbortSignal
  readonly abort: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
  failure?: BrowserTaskChannelError
}

interface Task {
  readonly scope: DesktopBrowserTaskScope
  readonly pending: Set<Request>
  lastId: number | undefined
  retirement?: PromiseWithResolvers<void>
  failure?: BrowserTaskChannelError
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function scopeKey(scope: DesktopBrowserTaskScope): string {
  return JSON.stringify(scopeFields.map(field => scope[field]))
}

function sameScope(value: unknown, scope: DesktopBrowserTaskScope): boolean {
  return object(value) && scopeFields.every(field => value[field] === scope[field])
}

function result(value: unknown, action: DesktopBrowserTaskCommand['action']): DesktopBrowserTaskResult | undefined {
  if (!object(value) || value.action !== resultActions[action]) return undefined
  if (value.action === 'prepared' && typeof value.lease === 'string' && uuid.test(value.lease)) {
    return { action: 'prepared', lease: value.lease as DesktopBrowserLeaseId }
  }
  if (value.action === 'navigated' && typeof value.url === 'string') return { action: 'navigated', url: value.url }
  if (value.action === 'screenshot' && typeof value.png === 'string') return { action: 'screenshot', png: value.png }
  if (value.action === 'released') return { action: 'released' }
  return undefined
}

/**
 * One run's private process channel. Successful request metadata remains until retirement so revoked results can be reclaimed.
 * The owner routes messages to receive, reports actual IPC loss through disconnect, and awaits close before releasing dependencies.
 */
export class BrowserTaskChannel {
  private readonly tasks = new Map<string, Task>()
  private readonly pending = new Map<number, Request>()
  private readonly cancellations = new Map<number, Task>()
  private readonly outgoing = new Set<Promise<void>>()
  private readonly failures = new Set<unknown>()
  private nextId = 0
  private accepting = true
  private disconnected: BrowserTaskChannelError | undefined
  private closing: Promise<void> | undefined

  /**
   * @param runEpoch - authenticated local Host run.
   * @param ports - rejecting IPC delivery and visible diagnostics; reporter throws fall back to stderr without changing outcomes.
   */
  constructor(private readonly runEpoch: string, private readonly ports: Ports) {}

  /**
   * Admit one command, reserving correlation before IPC delivery can synchronously reenter.
   * @param scope - registry-issued metadata for this run; metadata alone grants no task authority.
   * @param command - allowlisted Main operation.
   * @param options - caller cancellation and an absolute deadline no more than thirty seconds away.
   * @returns the matching result; abort/deadline rejection waits for task cancellation acknowledgement.
   */
  request(scope: DesktopBrowserTaskScope, command: DesktopBrowserTaskCommand,
    options: { readonly signal: AbortSignal; readonly deadlineAt: number }): Promise<DesktopBrowserTaskResult> {
    if (!this.accepting) return Promise.reject(this.disconnected ?? new BrowserTaskChannelError('CLOSED', 'Browser task channel is closed'))
    if (scope.runEpoch !== this.runEpoch) return Promise.reject(new BrowserTaskChannelError('INVALID_SCOPE', 'Browser task belongs to another Host run'))
    const remaining = options.deadlineAt - Date.now()
    if (!Number.isSafeInteger(options.deadlineAt) || remaining <= 0 || remaining > MAX_DEADLINE_MS) {
      return Promise.reject(new BrowserTaskChannelError('INVALID_DEADLINE', 'Browser task deadline must be within the next thirty seconds'))
    }
    if (options.signal.aborted) return Promise.reject(new BrowserTaskChannelError('ABORTED', 'Browser task was aborted before admission', { cause: options.signal.reason }))
    const key = scopeKey(scope)
    let task = this.tasks.get(key)
    if (task?.retirement !== undefined) return Promise.reject(task.failure ?? new BrowserTaskChannelError('RETIRED', 'Browser task is retired'))
    if (task === undefined) {
      task = { scope: Object.freeze({ ...scope }), pending: new Set(), lastId: undefined }
      this.tasks.set(key, task)
    }
    const request: Request = {
      id: ++this.nextId, task, command: { ...command }, result: Promise.withResolvers(), signal: options.signal,
      abort: () => {
        request.failure = new BrowserTaskChannelError('ABORTED', 'Browser task was aborted; awaiting native cleanup', { cause: options.signal.reason })
        void this.beginRetirement(request.task, request.failure)
      },
      timer: undefined, settled: false,
    }
    task.lastId = request.id
    task.pending.add(request)
    this.pending.set(request.id, request)
    options.signal.addEventListener('abort', request.abort, { once: true })
    request.timer = setTimeout(() => {
      request.failure = new BrowserTaskChannelError('DEADLINE', 'Browser task exceeded its deadline; awaiting native cleanup')
      void this.beginRetirement(request.task, request.failure)
    }, remaining)
    this.send({ type: 'browser-task/request', direction: 'host-to-main', requestId: request.id,
      scope: task.scope, deadlineAt: options.deadlineAt, command: request.command })
    return request.result.promise
  }

  /**
   * Consume a correlated Main message; stale, foreign and replayed messages never settle another request.
   * @param message - untrusted process message.
   * @returns whether this channel consumed a matching Browser reply or cancellation acknowledgement.
   */
  receive(message: unknown): boolean {
    if (this.disconnected !== undefined || !object(message) || message.direction !== 'main-to-host'
      || !Number.isSafeInteger(message.requestId) || typeof message.requestId !== 'number' || message.requestId <= 0) return false
    if (message.type === 'browser-task/cancelled') {
      const task = this.cancellations.get(message.requestId)
      if (task === undefined || !sameScope(message.scope, task.scope) || (message.error !== undefined && typeof message.error !== 'string')) return false
      this.cancellations.delete(message.requestId)
      if (typeof message.error === 'string') {
        const error = new BrowserTaskChannelError('CANCEL_FAILED', `Browser task cleanup failed: ${message.error}`)
        this.failures.add(error)
        task.failure = error
        for (const request of [...task.pending]) this.settle(request, error)
        task.retirement?.reject(error)
        this.report(error)
      } else {
        for (const request of [...task.pending]) this.settle(request, request.failure ?? task.failure)
        task.retirement?.resolve()
      }
      return true
    }
    if (message.type !== 'browser-task/reply') return false
    const request = this.pending.get(message.requestId)
    if (request === undefined || !sameScope(message.scope, request.task.scope)) return false
    if (request.task.retirement !== undefined) return true
    if (!object(message.outcome)) return this.invalidReply(request)
    if (message.outcome.kind === 'error' && typeof message.outcome.message === 'string') {
      this.settle(request, new BrowserTaskChannelError('REMOTE_ERROR', message.outcome.message))
      return true
    }
    const value = message.outcome.kind === 'result' ? result(message.outcome.value, request.command.action) : undefined
    if (value === undefined) return this.invalidReply(request)
    this.settle(request, undefined, value)
    return true
  }

  /**
   * Retire the entire task, including after successful replies; normal replies are never cleanup acknowledgements.
   * @param scope - exact metadata previously admitted on this channel.
   * @returns only after Main acknowledges drained work and native resources; failure leaves quiescence unknown.
   */
  retire(scope: DesktopBrowserTaskScope): Promise<void> {
    if (this.disconnected !== undefined) return Promise.reject(this.disconnected)
    const task = this.tasks.get(scopeKey(scope))
    if (task === undefined) return Promise.reject(new BrowserTaskChannelError('INVALID_SCOPE', 'Browser task was not admitted on this channel'))
    return this.beginRetirement(task, new BrowserTaskChannelError('RETIRED', 'Browser task was retired'))
  }

  /** @returns joined task cleanup and IPC deliveries; retains every native and transport failure, including after disconnect. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.accepting = false
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    void (async () => {
      const tasks = await Promise.allSettled([...this.tasks.values()].map(task => this.beginRetirement(task,
        new BrowserTaskChannelError('RETIRED', 'Browser task channel is closing'))))
      while (this.outgoing.size > 0) await Promise.all([...this.outgoing])
      for (const task of tasks) if (task.status === 'rejected') this.failures.add(task.reason)
      const failures = [...this.failures]
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Browser task channel cleanup failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  /**
   * Stop immediately on actual IPC loss; native effects remain unknown and no cancellation acknowledgement is fabricated.
   * @param cause - transport disconnection reason, reported once through onFailure.
   */
  disconnect(cause: unknown): void {
    this.fail(new BrowserTaskChannelError('DISCONNECTED', 'Browser task channel disconnected; native cleanup is unknown', { cause }))
  }

  private invalidReply(request: Request): true {
    const error = new BrowserTaskChannelError('PROTOCOL_ERROR', 'Browser task received an invalid result; retiring its native resources')
    void this.beginRetirement(request.task, error)
    this.report(error)
    return true
  }

  private beginRetirement(task: Task, error: BrowserTaskChannelError): Promise<void> {
    if (task.retirement !== undefined) return task.retirement.promise
    if (this.disconnected !== undefined) return Promise.reject(this.disconnected)
    task.failure = error
    task.retirement = Promise.withResolvers<void>()
    void task.retirement.promise.catch((_error: unknown) => {
      // Abort callbacks cannot await; public request/retire promises and onFailure retain failure ownership.
    })
    for (const request of task.pending) this.detach(request)
    const lastId = task.lastId
    if (lastId === undefined) throw new Error('Browser task has no admitted request')
    this.cancellations.set(lastId, task)
    this.send({ type: 'browser-task/cancel', direction: 'host-to-main', requestId: lastId, scope: task.scope })
    return task.retirement.promise
  }

  private detach(request: Request): void {
    if (request.timer !== undefined) clearTimeout(request.timer)
    request.timer = undefined
    request.signal.removeEventListener('abort', request.abort)
  }

  private settle(request: Request, error?: BrowserTaskChannelError, value?: DesktopBrowserTaskResult): void {
    if (request.settled) return
    request.settled = true
    this.detach(request)
    this.pending.delete(request.id)
    request.task.pending.delete(request)
    if (error !== undefined) request.result.reject(error)
    else if (value !== undefined) request.result.resolve(value)
    else request.result.reject(new Error('Browser task completed without a result or failure'))
  }

  private send(message: DesktopBrowserTaskRequest | DesktopBrowserTaskCancel): void {
    const delivered = Promise.withResolvers<void>()
    const tracked = delivered.promise.catch((cause: unknown) => {
      this.fail(new BrowserTaskChannelError('SEND_FAILED', 'Browser task IPC delivery failed; native cleanup is unknown', { cause }))
    }).finally(() => { this.outgoing.delete(tracked) })
    this.outgoing.add(tracked)
    try { delivered.resolve(this.ports.send(message)) }
    catch (cause: unknown) { delivered.reject(cause) }
  }

  private report(error: BrowserTaskChannelError): void {
    try { this.ports.onFailure(error) }
    catch (cause: unknown) { console.error('Browser task diagnostic callback failed; cleanup outcome is unchanged', error, cause) }
  }

  private fail(error: BrowserTaskChannelError): void {
    this.failures.add(error)
    if (this.disconnected !== undefined) return
    this.disconnected = error
    this.accepting = false
    for (const request of [...this.pending.values()]) this.settle(request, error)
    for (const task of this.tasks.values()) task.retirement?.reject(error)
    this.cancellations.clear()
    this.report(error)
  }
}
