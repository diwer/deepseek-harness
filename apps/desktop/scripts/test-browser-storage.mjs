/** Qualifies real Electron storage in private profiles without launching the DSH application. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const electron = require('electron')
const electronVersion = require('electron/package.json').version
const electronDirectory = dirname(require.resolve('electron/package.json'))
const relativeBinary = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim()
assert.equal(electron, join(electronDirectory, 'dist', relativeBinary), 'only the checkout Electron binary may run')
const directory = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
await mkdir(directory, { recursive: true })
const root = await mkdtemp(join(directory, 'browser-storage-'))
const fixture = fileURLToPath(new URL('../tests/fixtures/browser-storage.mjs', import.meta.url))
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Isolated storage probe</title><h1>Storage probe</h1>')
})
const reports = []
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  // The origin stays identical across process restarts, including its allocated port.
  const origin = `http://127.0.0.1:${server.address().port}`
  async function run(mode) {
    const env = { ...process.env, DSH_BROWSER_STORAGE_TEST_ROOT: root, DSH_BROWSER_STORAGE_TEST_MODE: mode, DSH_BROWSER_STORAGE_TEST_ORIGIN: origin }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    return promisify(execFile)(electron, [fixture], { env, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true })
  }
  for (const mode of ['initial', 'restart']) {
    const result = await run(mode)
    const report = JSON.parse(await readFile(join(root, `${mode}.json`), 'utf8'))
    assert.equal(report.electron, electronVersion)
    assert.equal(report.mode, mode)
    assert.equal(report.cleanup, true)
    assert.equal(report.cases.length, 8)
    reports.push(report)
    process.stdout.write(result.stdout)
  }
  // Reproduce Workspace-wide account sharing; the real cookie/storage assertion must reject it.
  await assert.rejects(run('shared-negative'), error => error.code === 1 && String(error.stderr).includes('cross-session storage leak'))
} finally {
  if (server.listening) {
    server.closeIdleConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
const result = { electron: electronVersion, phases: reports, sharedStorageNegativeControl: true, childrenExited: true, serverClosed: true }
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(`Native browser qualification passed: ${root}`)
