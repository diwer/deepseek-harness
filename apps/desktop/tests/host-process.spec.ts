import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, QUIT_INSPECTION_DEADLINE_MS } from '../src/host-process.ts'
import { OperationJournal } from '../src/operation-journal.ts'
import type { DesktopBrowserTaskHandler } from '../src/browser-task-server.ts'
import { readOperationHistory } from '../src/operation-history.ts'
import { renderCrashReport } from '../src/crash-report.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'file-drag-cancel') {
    process.send({ type: 'file-drag-resource', requestId: message.requestId, resource: null })
    return
  }
  if (message.type === 'file-drag-resource') {
    if (message.address === 'pending') return
    if (message.address === 'invalid') {
      process.send({ type: 'file-drag-resource', requestId: message.requestId, resource: { path: '/invalid', sha256: 'bad', size: -1 } })
      return
    }
    process.send({ type: 'file-drag-resource', requestId: message.requestId,
      resource: message.address === 'remote' ? null : { path: '/authorized/report.pdf', sha256: 'a'.repeat(64), size: 42 },
      ...(message.address === 'denied' ? { error: 'File read denied' } : {}) })
    return
  }
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type === 'quit-inspection') {
    // Ids divisible by three never answer; the others report scheduled work for odd ids.
    if (message.requestId % 3 === 0) return
    process.send({ type: 'quit-inspection', requestId: message.requestId, activeTasks: false, scheduledTasks: message.requestId % 2 === 1 })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
  browserTaskHandler?: DesktopBrowserTaskHandler,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, environment, onFailure,
    undefined, undefined, undefined, undefined, browserTaskHandler)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const BROWSER_TASK_HOST = `
import { randomUUID } from 'node:crypto'
const runEpoch = randomUUID()
const scope = { runEpoch, providerEpoch: randomUUID(), agentEpoch: randomUUID(), taskId: randomUUID(), taskEpoch: randomUUID(), sessionId: 'fixture-session' }
process.send({ type: 'starting', runId: runEpoch })
process.on('message', message => {
  if (message.type === 'shutdown') {
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
    return
  }
  if (message.type === 'browser-task/reply') {
    if (message.outcome.kind === 'error') {
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/?unsupported=true' })
      return
    }
    process.send({ type: 'browser-task/cancel', direction: 'host-to-main', requestId: 1, scope })
    return
  }
  if (message.type === 'browser-task/cancelled') {
    process.send({ type: 'ready', url: 'http://127.0.0.1:3080/?drained=' + String(message.error === undefined) })
  }
})
process.send({ type: 'browser-task/request', direction: 'host-to-main', requestId: 1, scope, deadlineAt: Date.now() + 20000, command: { action: 'prepare' } })
`

describe('desktop host process', () => {
  it('routes reverse task IPC privately and acknowledges cancellation only after native drain', async () => {
    const runtime = projectWithHost(BROWSER_TASK_HOST)
    const retirementEntered = Promise.withResolvers<undefined>()
    const nativeDrain = Promise.withResolvers<undefined>()
    const handler: DesktopBrowserTaskHandler = {
      execute: async () => ({ action: 'prepared', lease: 'c254ab28-97c9-4382-95e6-2db9c66f98c8' as import('@deepseek-ai/dsh-client-ui-sidebar-browser/types').DesktopBrowserLeaseId }),
      retire: () => { retirementEntered.resolve(undefined); return nativeDrain.promise },
    }
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure, process.env, handler)
    let published = false
    const ready = host.start().then((value) => { published = true; return value })
    try {
      await retirementEntered.promise
      expect(published).toBe(false)
      nativeDrain.resolve(undefined)
      expect(new URL((await ready).url).searchParams.get('drained')).toBe('true')
      expect(failure).not.toHaveBeenCalled()
      await host.stop(true)
    } finally { nativeDrain.resolve(undefined) }
  })

  it('preserves reverse cancellation acknowledgements while the real child unwinds shutdown', async () => {
    const runtime = projectWithHost(`
import { randomUUID } from 'node:crypto'
const scope = { runEpoch: randomUUID(), providerEpoch: randomUUID(), agentEpoch: randomUUID(), taskId: randomUUID(), taskEpoch: randomUUID(), sessionId: 'shutdown-session' }
process.send({ type: 'starting', runId: scope.runEpoch })
process.on('message', message => {
  if (message.type === 'browser-task/reply') process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
  if (message.type === 'shutdown') process.send({ type: 'browser-task/cancel', direction: 'host-to-main', requestId: 1, scope })
  if (message.type === 'browser-task/cancelled') {
    if (message.error !== undefined) throw new Error(message.error)
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  }
})
process.send({ type: 'browser-task/request', direction: 'host-to-main', requestId: 1, scope, deadlineAt: Date.now() + 20000, command: { action: 'prepare' } })
`)
    const native = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const failure = vi.fn()
    const handler: DesktopBrowserTaskHandler = {
      execute: async () => ({ action: 'prepared', lease: 'c254ab28-97c9-4382-95e6-2db9c66f98c8' as import('@deepseek-ai/dsh-client-ui-sidebar-browser/types').DesktopBrowserLeaseId }),
      retire: () => { entered.resolve(undefined); return native.promise },
    }
    const host = hostProcess(runtime, runtime, failure, process.env, handler)
    try {
      await host.start()
      const stopping = host.stop(true)
      await entered.promise
      native.resolve(undefined)
      await stopping
      await host.stop(true)
      expect(failure).not.toHaveBeenCalled()
    } finally { native.resolve(undefined) }
  })

  it.each([false, true])('reports an IPC-orphaned live child independently of exit (ready=%s)', async (ready) => {
    const runtime = projectWithHost(`
setInterval(() => {}, 1000)
${ready ? "process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' }, () => process.disconnect())" : 'process.disconnect()'}
`)
    const observed = Promise.withResolvers<Error>()
    const failure = vi.fn((error: Error) => { observed.resolve(error) })
    const host = hostProcess(runtime, runtime, failure)
    try {
      if (ready) await host.start()
      else await expect(host.start()).rejects.toThrow('disconnected without exiting')
      expect((await observed.promise).message).toContain('disconnected without exiting')
      await host.stop()
      expect(failure).toHaveBeenCalledOnce()
    } finally { await host.stop() }
  })

  it('severs actual task IPC when asynchronous retirement fails after cancellation was queued', async () => {
    const runtime = projectWithHost(`
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const scope = { runEpoch: randomUUID(), providerEpoch: randomUUID(), agentEpoch: randomUUID(), taskId: randomUUID(), taskEpoch: randomUUID(), sessionId: 'expired-session' }
process.on('SIGTERM', () => {})
process.once('disconnect', () => {
  writeFileSync(join(process.argv[3], 'transport-disconnected'), '')
  process.exit(0)
})
process.on('message', message => {
  if (message.type === 'shutdown') process.send({ type: 'shutdown-complete' }, () => process.disconnect())
})
process.send({ type: 'starting', runId: scope.runEpoch })
process.send({ type: 'browser-task/request', direction: 'host-to-main', requestId: 1, scope, deadlineAt: Date.now() - 1, command: { action: 'prepare' } })
process.send({ type: 'browser-task/cancel', direction: 'host-to-main', requestId: 1, scope })
// Ordered IPC makes readiness a barrier after Main has consumed the cancellation.
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
`)
    const native = Promise.withResolvers<undefined>()
    const observed = Promise.withResolvers<Error>()
    const failure = vi.fn((error: Error) => { observed.resolve(error) })
    const execute = vi.fn<DesktopBrowserTaskHandler['execute']>()
    const host = hostProcess(runtime, runtime, failure, process.env, {
      execute,
      retire: () => native.promise,
    })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await host.start()
      expect(execute).not.toHaveBeenCalled()
      native.reject(new Error('native retirement failed'))
      expect((await observed.promise).message).toContain('native task retirement failed')
      // The live child ignores SIGTERM: closing only the server or signalling alone cannot pass.
      await expect.poll(() => existsSync(join(runtime, 'transport-disconnected')), { timeout: 1000 }).toBe(true)
      expect(failure).toHaveBeenCalledOnce()
    } finally {
      native.reject(new Error('test cleanup'))
      const index = hosts.indexOf(host)
      if (index >= 0) hosts.splice(index, 1)
      try { await expect(host.stop()).rejects.toBeInstanceOf(AggregateError) }
      finally { diagnostic.mockRestore() }
    }
  })

  it('returns unsupported on reverse task IPC when no native provider is installed', async () => {
    const runtime = projectWithHost(BROWSER_TASK_HOST)
    const host = hostProcess(runtime)
    expect(new URL((await host.start()).url).searchParams.get('unsupported')).toBe('true')
    await host.stop(true)
  })

  it('retains the announced run identity when startup fails before readiness', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'starting', runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8' })
process.send({ type: 'fatal', message: 'profile startup failed', diagnostic: 'required plugin failed' }, () => process.disconnect())
`)
    const host = hostProcess(runtime)
    const failure: unknown = await host.start().catch((error: unknown) => error)
    await host.stop()
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect(failure).toHaveProperty('hostRunId', 'c254ab28-97c9-4382-95e6-2db9c66f98c8')
  })

  it.each([
    ['exception', 'queueMicrotask(() => { throw new Error("qualification-exception", { cause: new Error("qualification-runtime-cause") }) })'],
    ['rejection', 'Promise.reject(new Error("qualification-rejection"))'],
    ['exit', 'process.stderr.write("qualification-exit", () => process.exit(7))'],
  ])('retains real child %s evidence in the final report after readiness', async (kind, trigger) => {
    const failed = Promise.withResolvers<Error>()
    const runtime = projectWithHost(`
process.send({ type: 'starting', runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8' })
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' }, () => { ${trigger} })
`)
    const host = hostProcess(runtime, runtime, failed.resolve)
    await host.start()
    const failure = await failed.promise
    await host.stop()
    const report = renderCrashReport({ source: 'host', phase: 'running', error: failure,
      rendererConsole: [], operationHistoryPlanned: true, time: new Date('2026-10-19T00:00:00Z'),
      app: { name: 'qualification', version: 'test', platform: process.platform, arch: process.arch,
        electron: 'not-running', node: process.version, locale: 'zh-CN' },
    })
    expect(report).toContain(`qualification-${kind}`)
    expect(report).toContain('phase: running')
    expect(report).toContain("hostRunId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8'")
    if (kind === 'exception') expect(report).toContain('qualification-runtime-cause')
    if (kind === 'exit') expect(report).toContain('7')
  })

  it('persists validated operation IPC across Host lifetimes and isolates a failing diagnostic sink', async () => {
    const record = {
      runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
      operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-19T00:00:00.000Z',
        reason: 'bundle', phase: 'started', target: 'test-bundle', stage: 'enable' },
      secret: 'not-persisted',
    }
    const runtime = projectWithHost(`
process.send({ type: 'starting', runId: ${JSON.stringify(record.runId)} })
process.send({ type: 'plugin-operation', record: { invalid: true } })
process.send({ type: 'plugin-operation', record: { ...${JSON.stringify(record)}, runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c0' } })
process.send({ type: 'plugin-operation', record: ${JSON.stringify(record)} })
${HTTP_HOST}`)
    const directory = join(runtime, 'operation-history')
    const journal = new OperationJournal(directory, { recordBytes: 4096, segmentBytes: 8192, queuedBytes: 8192 })
    onTestFinished(async () => { await journal.close() })
    const sink = vi.fn(value => journal.enqueue(JSON.stringify(value)))
    const first = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, sink)
    hosts.push(first)
    await first.start()
    await first.stop()
    await journal.close()
    expect(sink).toHaveBeenCalledTimes(1)
    const saved = await readOperationHistory(directory, { bytes: 8192, recordBytes: 4096, records: 10 }, new AbortController().signal)
    expect(saved.records).toEqual([{ runId: record.runId, transportDropped: 0, operation: record.operation }])

    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failure = vi.fn()
      const second = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
        failure, undefined, undefined, undefined, () => { throw new Error('sink unavailable') })
      hosts.push(second)
      await second.start()
      expect(await second.updateTasks('inspect')).toBe(false)
      await second.stop()
      expect(failure).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledWith('desktop plugin operation diagnostic sink failed')
    } finally { warning.mockRestore() }
  })

  it('correlates authorized file resources and rejects Host denial over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await host.start()
    expect(await Promise.all([host.resolveDragResource('local'), host.resolveDragResource('remote')]))
      .toEqual([{ path: '/authorized/report.pdf', sha256: 'a'.repeat(64), size: 42 }, null])
    await expect(host.resolveDragResource('denied')).rejects.toThrow('File read denied')
    await host.stop(true)
    await expect(host.resolveDragResource('local')).rejects.toThrow('file drag: Host is unavailable')
  })

  it('cancels a pending resource request without invalidating later Host requests', async () => {
    const host = hostProcess(projectWithHost())
    await host.start()
    const abort = new AbortController()
    const pending = host.resolveDragResource('pending', abort.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    abort.abort(new Error('cancelled'))
    await rejected
    await expect(host.resolveDragResource('local')).resolves.toMatchObject({ path: '/authorized/report.pdf' })
  })

  it('rejects malformed file authorization responses and terminates the Host', async () => {
    const host = hostProcess(projectWithHost())
    await host.start()
    await expect(host.resolveDragResource('invalid')).rejects.toThrow('invalid IPC event')
  })
  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it('correlates quit inspections with task requests and fails an unanswered one at its own deadline', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: Host is unavailable')
    await host.start()
    // Request ids 1 and 2: the fixture answers by id parity, so both control kinds share one id space.
    expect(await Promise.all([host.inspectQuit(), host.updateTasks('inspect')]))
      .toEqual([{ activeTasks: false, scheduledTasks: true }, false])
    const started = Date.now()
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: inspection timed out')
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUIT_INSPECTION_DEADLINE_MS - 50)
    expect(await host.inspectQuit()).toEqual({ activeTasks: false, scheduledTasks: false })
  }, 15_000)

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })
})

it.each([null, 'stable-account'])('carries Platform identity %s over private IPC and clears credentials on shutdown', async (userId) => {
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'", "process.send({ type: 'platform-session', session: { origin: 'https://platform.deepseek.com', userId: " + JSON.stringify(userId) + ", token: 'fixture-secret', embeddedPageDist: 'feat/test' } }); process.send({ type: 'ready'"))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await host.start()
  expect(changed).toHaveBeenCalledWith({ origin: 'https://platform.deepseek.com', userId, token: 'fixture-secret', embeddedPageDist: 'feat/test' })
  await host.stop()
  expect(changed).toHaveBeenLastCalledWith(null)
})

it.each([undefined, '', 7])('rejects malformed Platform account identity %s on private IPC', async (userId) => {
  const session = { origin: 'https://platform.deepseek.com', token: 'fixture-secret', userId }
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'",
    `process.send({ type: 'platform-session', session: ${JSON.stringify(session)} }); process.send({ type: 'ready'`))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await expect(host.start()).rejects.toThrow('invalid IPC event')
  expect(changed.mock.calls).toEqual([[null]])
  await host.stop()
})
