/** Qualifies rebuilt native attachment with checkout Electron and an owned loopback page. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const electronVersion = require('electron/package.json').version
const electronDirectory = dirname(require.resolve('electron/package.json'))
const binary = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim()
assert.equal(electron, join(electronDirectory, 'dist', binary), 'only checkout Electron may run')
assert.equal(electronVersion, '44.7.0')
assert.notEqual(process.platform, 'win32', 'owned process-group shutdown requires POSIX')
const ts = require('typescript')
const sourceSha256 = {}
const artifactSha256 = {}
for (const name of ['browser-guests', 'ipc']) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
  const artifact = await readFile(new URL(`../lib/types/${name}.js`, import.meta.url), 'utf8')
  const emitted = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
  } }).outputText
  const withoutMap = text => text.replace(/^\/\/# sourceMappingURL=.*$/mu, '').trim()
  assert.equal(withoutMap(artifact), withoutMap(emitted), `${name}: rebuild the actual production artifact; qualification never copies or substitutes source`)
  sourceSha256[name] = createHash('sha256').update(source).digest('hex')
  artifactSha256[name] = createHash('sha256').update(artifact).digest('hex')
}
const directory = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
await mkdir(directory, { recursive: true })
const root = await mkdtemp(join(directory, 'browser-attachment-'))
const fixture = fileURLToPath(new URL('../tests/fixtures/browser-attachment.mjs', import.meta.url))
const requests = []
const server = createServer((request, response) => {
  requests.push({ url: request.url, userAgent: request.headers['user-agent'] ?? null })
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Content-Security-Policy', "default-src 'none'")
  response.end('<!doctype html><title>Owned attachment page</title>')
})
let child
let childClosed
let deadline
let timedOut = false
let outputExceeded = false
let stdout = ''
let stderr = ''
let result
function terminateOwnedProcessGroup() {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, DSH_BROWSER_ATTACHMENT_TEST_ROOT: root, DSH_BROWSER_ATTACHMENT_TEST_ORIGIN: origin }
  for (const key of Object.keys(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/u.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key]
  }
  child = spawn(electron, [fixture], { env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  childClosed = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, spawnError: String(error) }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  for (const [stream, append] of [[child.stdout, text => { stdout += text }], [child.stderr, text => { stderr += text }]]) {
    stream.setEncoding('utf8')
    stream.on('data', text => {
      append(text)
      if (stdout.length + stderr.length > 1024 * 1024) { outputExceeded = true; terminateOwnedProcessGroup() }
    })
  }
  deadline = setTimeout(() => { timedOut = true; terminateOwnedProcessGroup() }, 60000)
  const outcome = await childClosed
  clearTimeout(deadline)
  await writeFile(join(root, 'child-stdout.txt'), stdout)
  await writeFile(join(root, 'child-stderr.txt'), stderr)
  await writeFile(join(root, 'process.json'), JSON.stringify({ ...outcome, timedOut, outputExceeded, pid: child.pid, electron, electronVersion }, null, 2) + '\n')
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  assert.equal(timedOut, false, `owned Electron exceeded its deadline; evidence: ${root}`)
  assert.equal(outputExceeded, false, `owned Electron exceeded its output bound; evidence: ${root}`)
  assert.equal(outcome.spawnError, undefined)
  assert.equal(outcome.signal, null, `owned Electron was signalled; evidence: ${root}`)
  assert.equal(outcome.code, 0, `native attachment qualification failed; evidence: ${root}`)
  const observation = JSON.parse(await readFile(join(root, 'observations.json'), 'utf8'))
  assert.equal(observation.cleanup, true)
  assert.equal(observation.samePartition, true)
  assert.equal(observation.attachments.length, 2)
  assert.equal(observation.samePartitionSurvivorRemainsReady, true)
  assert.equal(observation.releaseBeforeFirstDom.exactGuestDestroyed, true)
  assert.equal(observation.throwingLateInputCleanup.exactGuestDestroyed, true)
  assert.equal(observation.throwingLateInputCleanup.joinedReleases.length, 2)
  assert.ok(observation.throwingLateInputCleanup.joinedReleases.every(release => release.state === 'rejected'))
  assert.deepEqual(observation.windowEvents, [])
  const remoteRequests = requests.filter(request => new URL(request.url, origin).searchParams.has('lease'))
  assert.equal(remoteRequests.length, 2, 'only two ready guests may navigate remotely')
  for (const attachment of observation.attachments) {
    const matching = remoteRequests.filter(request => new URL(request.url, origin).searchParams.get('lease') === attachment.lease)
    assert.equal(matching.length, 1)
    assert.equal(matching[0].userAgent, attachment.defaultUserAgent, 'the first HTTP request must use the restored default user agent')
  }
  assert.ok(requests.every(request => !String(request.userAgent).includes('DSH-BrowserBootstrap/')), 'no request may leak a lease marker')
  result = { ...observation, requests, firstHTTPUsesDefaultUserAgent: true, sourceSha256, artifactSha256,
    productionArtifactsMatchCurrentSource: true, childOutcome: outcome, directChildExited: true, timedOut, outputExceeded }
} finally {
  clearTimeout(deadline)
  terminateOwnedProcessGroup()
  if (childClosed) await childClosed
  if (server.listening) {
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  if (result) await writeFile(join(root, 'result.json'), JSON.stringify({ ...result, ownedProcessGroupTerminated: true, serverClosed: true }, null, 2) + '\n')
  console.log(`Native browser attachment evidence: ${root}; owned loopback closed`)
}
