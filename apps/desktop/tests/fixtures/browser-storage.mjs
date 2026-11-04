/** Real webview storage and lease qualification; launched only by the isolated runner. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { DesktopBrowserGuests } from '../../lib/types/browser-guests.js'
import { browserSessionStorage } from '../../../../packages/client/ui-sidebar-browser/lib/types/client/electron/storage.js'

const root = process.env.DSH_BROWSER_STORAGE_TEST_ROOT
const mode = process.env.DSH_BROWSER_STORAGE_TEST_MODE
const origin = process.env.DSH_BROWSER_STORAGE_TEST_ORIGIN
assert.ok(root, 'the isolated runner must supply its private directory')
assert.ok(origin && new URL(origin).hostname === '127.0.0.1' && new URL(origin).protocol === 'http:', 'a private loopback fixture is required')
assert.ok(['initial', 'restart', 'shared-negative'].includes(mode), 'unknown qualification mode')
await mkdir(join(root, 'profile'), { recursive: true })
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')

async function main() {
  const deadline = setTimeout(() => { console.error('Native browser qualification deadline exceeded'); app.exit(1) }, 30000)
  const windows = []
  const opened = []
  const activeInput = new Set()
  const guests = new DesktopBrowserGuests(() => undefined)
  const cases = []
  try {
    await app.whenReady()
    async function window() {
      const owner = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      windows.push(owner)
      guests.bind(owner, (_guest, lease) => {
        activeInput.add(lease)
        return () => { activeInput.delete(lease) }
      })
      await owner.loadURL('data:text/html,<main>Isolated webview owner</main>')
      return owner
    }
    const owner = await window()
    const foreign = await window()
    const script = reservation => `(() => {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(reservation.partition)});
      view.setAttribute('src', ${JSON.stringify(`about:blank#${reservation.lease}`)});
      document.body.append(view);
    })()`
    async function open(sessionId) {
      const identity = await browserSessionStorage(mode === 'shared-negative' ? 'first' : sessionId, new AbortController().signal)
      const reservation = guests.acquire(owner.webContents, identity)
      const record = { ...reservation, owner: owner.webContents }
      opened.push(record)
      const ready = new Promise(resolve => {
        owner.webContents.once('did-attach-webview', (_event, guest) => {
          guest.once('dom-ready', () => resolve(guest))
        })
      })
      await owner.webContents.executeJavaScript(script(reservation))
      record.guest = await ready
      await record.guest.loadURL(origin)
      return record
    }
    const read = record => record.guest.executeJavaScript('({ cookie: document.cookie, local: localStorage.getItem("probe") })')
    const first = await open('first')
    const sibling = await open('first')
    const second = await open('second')
    assert.deepEqual(await read(first), { cookie: '', local: null }, 'new process starts without previous storage')
    cases.push('fresh process storage')
    await first.guest.executeJavaScript('document.cookie = "probe=first; SameSite=Lax; path=/"; localStorage.setItem("probe", "first")')
    assert.deepEqual(await read(sibling), { cookie: 'probe=first', local: 'first' })
    assert.deepEqual(await read(second), { cookie: '', local: null }, 'cross-session storage leak')
    assert.equal(first.partition, sibling.partition)
    assert.notEqual(first.partition, second.partition)
    assert.equal(first.partition.startsWith('persist:'), false)
    await second.guest.executeJavaScript('document.cookie = "probe=second; SameSite=Lax; path=/"; localStorage.setItem("probe", "second")')
    assert.deepEqual(await read(first), { cookie: 'probe=first', local: 'first' })
    cases.push('same-session sharing', 'bidirectional cross-session isolation')

    await assert.rejects(guests.release(foreign.webContents, first.lease), /another window/)
    assert.equal(first.guest.isDestroyed(), false)
    const rejectedAttachment = new Promise(resolve => {
      foreign.webContents.once('will-attach-webview', event => resolve(event.defaultPrevented))
    })
    await foreign.webContents.executeJavaScript(script(first))
    assert.equal(await rejectedAttachment, true)
    cases.push('foreign-window release and attachment rejection')
    const preferences = first.guest.getLastWebPreferences()
    assert.deepEqual([preferences.nodeIntegration, preferences.contextIsolation, preferences.sandbox, preferences.webSecurity], [false, true, true, true])
    cases.push('native isolation preferences')

    await guests.release(first.owner, first.lease)
    assert.equal(first.guest.isDestroyed(), true)
    assert.equal(sibling.guest.isDestroyed(), false)
    const replacement = await open('first')
    assert.equal(replacement.partition, sibling.partition)
    assert.deepEqual(await read(replacement), { cookie: 'probe=first', local: 'first' })
    cases.push('guest replacement retains storage')
    await guests.release(sibling.owner, sibling.lease)
    await guests.release(replacement.owner, replacement.lease)
    const reopened = await open('first')
    assert.equal(reopened.partition, first.partition)
    assert.deepEqual(await read(reopened), { cookie: 'probe=first', local: 'first' })
    assert.deepEqual(await read(second), { cookie: 'probe=second', local: 'second' })
    cases.push('zero-tab storage lifetime')
    const destroyed = [reopened, second].map(record => once(record.guest, 'destroyed'))
    owner.destroy()
    await Promise.all(destroyed)
    assert.equal(activeInput.size, 0)
    cases.push('owner destruction releases guests and input')
  } finally {
    // Keep the watchdog armed until every owned guest, window and listener has stopped.
    try {
      for (const record of opened) await guests.release(record.owner, record.lease)
      for (const owner of windows) {
        if (!owner.isDestroyed()) {
          const closed = once(owner, 'closed')
          owner.destroy()
          await closed
        }
      }
      assert.equal(activeInput.size, 0)
    } finally {
      clearTimeout(deadline)
    }
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  const report = { mode, electron: process.versions.electron, origin: 'private loopback', cases, cleanup: true }
  await writeFile(join(root, `${mode}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(`Native browser ${mode}: ${cases.length} cases passed; resources released`)
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
