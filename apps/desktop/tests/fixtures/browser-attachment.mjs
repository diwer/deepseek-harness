/** Exercises native readiness and retirement through the rebuilt production guest manager. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { DesktopBrowserGuests } from '../../lib/types/browser-guests.js'

const root = process.env.DSH_BROWSER_ATTACHMENT_TEST_ROOT
const origin = process.env.DSH_BROWSER_ATTACHMENT_TEST_ORIGIN
assert.ok(root, 'the isolated runner must supply its private directory')
assert.ok(origin && new URL(origin).hostname === '127.0.0.1' && new URL(origin).protocol === 'http:', 'an owned loopback fixture is required')
assert.equal(process.versions.electron, '44.7.0')
assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false)
assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false)
await mkdir(join(root, 'profile'), { recursive: true })
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')

async function bounded(label, operation) {
  let timer
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), 8000)
    })])
  } finally { clearTimeout(timer) }
}

function track(operation, atFulfillment = () => undefined, atRejection = () => undefined) {
  const record = { state: 'pending' }
  record.done = operation.then(() => {
    record.state = 'fulfilled'
    record.atFulfillment = atFulfillment()
  }, error => {
    record.state = 'rejected'
    record.error = String(error)
    record.atRejection = atRejection()
  })
  return record
}

async function main() {
  const watchdog = setTimeout(() => { console.error('Native browser attachment deadline exceeded'); app.exit(1) }, 45000)
  const manager = new DesktopBrowserGuests(() => undefined)
  const owners = []
  const reservations = []
  const physical = new Map()
  const waits = new Map()
  const activeInput = new Set()
  const report = {
    electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch,
    productionOwner: 'rebuilt DesktopBrowserGuests.acquire/bind/waitForAttachment/release artifact',
    remoteDebuggingPort: false, osInputCalls: false, showOrFocusCalls: false,
    windowEvents: [], attachments: [], samePartition: false, reversedAppendOrder: true, cleanup: false,
  }
  let retireDuringInput
  let cleanupFailureLease
  let foreignOwner
  try {
    await app.whenReady()
    for (let index = 0; index < 2; index++) {
      const owner = new BrowserWindow({ show: false, webPreferences: {
        webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      } })
      owners.push(owner)
      owner.on('show', () => report.windowEvents.push('show'))
      owner.on('focus', () => report.windowEvents.push('focus'))
      await owner.loadURL('data:text/html,<!doctype html><title>Private attachment qualification</title>')
    }
    const [owner, foreign] = owners
    foreignOwner = foreign.webContents
    manager.bind(owner, (guest, lease) => {
      const record = {
        lease, guest, urlAtInputSetup: guest.getURL(), defaultUserAgent: guest.session.getUserAgent(),
        userAgentAtInputSetup: guest.getUserAgent(), firstDomObserved: false, destroyed: false, inputDisposals: 0,
        waitAtInputSetup: waits.get(lease)?.state,
      }
      physical.set(lease, record)
      activeInput.add(lease)
      const input = () => {}
      guest.on('before-input-event', input)
      guest.once('dom-ready', () => {
        record.firstDomObserved = true
        record.firstDomURL = guest.getURL()
        record.firstDomUserAgent = guest.getUserAgent()
      })
      guest.once('destroyed', () => { record.destroyed = true })
      if (lease === retireDuringInput) {
        record.releaseStartedBeforeFirstDom = !record.firstDomObserved
        const atReleaseSettlement = () => ({ guestDestroyed: guest.isDestroyed(), destroyedObserved: record.destroyed,
          inputDisposals: record.inputDisposals })
        record.releases = [track(manager.release(owner.webContents, lease), atReleaseSettlement, atReleaseSettlement),
          track(manager.release(owner.webContents, lease), atReleaseSettlement, atReleaseSettlement)]
        record.foreignReleaseDuringRetirement = track(manager.release(foreignOwner, lease))
      }
      return () => {
        record.inputDisposals++
        guest.removeListener('before-input-event', input)
        activeInput.delete(lease)
        if (lease === cleanupFailureLease) throw new Error('native late input cleanup')
      }
    })
    const reserve = () => {
      const reservation = manager.acquire(owner.webContents, 'native-attachment-shared-workspace')
      reservations.push({ owner: owner.webContents, ...reservation })
      const wait = track(manager.waitForAttachment(owner.webContents, reservation.lease), () => {
        const record = physical.get(reservation.lease)
        return { firstDomObserved: record?.firstDomObserved, inputInstalled: activeInput.has(reservation.lease), url: record?.guest.getURL() }
      })
      waits.set(reservation.lease, wait)
      return reservation
    }
    const pair = [reserve(), reserve()]
    assert.equal(pair[0].partition, pair[1].partition)
    report.samePartition = true
    await assert.rejects(manager.waitForAttachment(foreignOwner, pair[0].lease), /another window/u)
    await assert.rejects(manager.release(foreignOwner, pair[0].lease), /another window/u)
    report.foreignActiveWaitAndReleaseRejected = true
    await bounded('append two reverse-order physical guests', owner.webContents.executeJavaScript(`(() => {
      for (const reservation of ${JSON.stringify(pair.toReversed())}) {
        const view = document.createElement('webview');
        view.setAttribute('partition', reservation.partition);
        view.setAttribute('src', 'about:blank#' + reservation.lease);
        document.body.append(view);
      }
    })()`))
    await bounded('both exact native readiness promises', Promise.all(pair.map(item => waits.get(item.lease).done)))
    assert.deepEqual([...physical.keys()], pair.toReversed().map(item => item.lease))
    for (const reservation of pair) {
      const record = physical.get(reservation.lease)
      const wait = waits.get(reservation.lease)
      assert.ok(record)
      assert.equal(record.urlAtInputSetup, '')
      assert.equal(record.waitAtInputSetup, 'pending')
      assert.equal(wait.state, 'fulfilled', wait.error)
      assert.deepEqual(wait.atFulfillment, { firstDomObserved: true, inputInstalled: true, url: `about:blank#${reservation.lease}` })
      assert.equal(record.firstDomURL, `about:blank#${reservation.lease}`)
      assert.equal(record.userAgentAtInputSetup, record.defaultUserAgent)
      assert.equal(record.firstDomUserAgent, record.defaultUserAgent)
      const preferences = record.guest.getLastWebPreferences()
      assert.equal(preferences.additionalArguments, undefined)
      assert.equal(preferences.partition, undefined)
      const bootstrapNavigator = await bounded('bootstrap navigator user agent', record.guest.executeJavaScript('navigator.userAgent'))
      assert.equal(bootstrapNavigator, record.defaultUserAgent)
      await bounded('first remote navigation', record.guest.loadURL(`${origin}/?lease=${reservation.lease}`))
      const remoteNavigator = await bounded('remote navigator user agent', record.guest.executeJavaScript('navigator.userAgent'))
      assert.equal(remoteNavigator, record.defaultUserAgent)
      await bounded('late readiness waiter', manager.waitForAttachment(owner.webContents, reservation.lease))
      report.attachments.push({ lease: reservation.lease, urlAtInputSetup: record.urlAtInputSetup,
        defaultUserAgent: record.defaultUserAgent, userAgentAtInputSetup: record.userAgentAtInputSetup,
        firstDomURL: record.firstDomURL, firstDomUserAgent: record.firstDomUserAgent,
        bootstrapNavigator, remoteNavigator, ready: wait.atFulfillment })
    }
    await bounded('release first exact guest', manager.release(owner.webContents, pair[0].lease))
    assert.equal(physical.get(pair[0].lease).guest.isDestroyed(), true)
    assert.equal(physical.get(pair[0].lease).inputDisposals, 1)
    assert.equal(physical.get(pair[1].lease).guest.isDestroyed(), false)
    await bounded('unrelated guest remains ready', manager.waitForAttachment(owner.webContents, pair[1].lease))
    report.samePartitionSurvivorRemainsReady = true

    const early = reserve()
    retireDuringInput = early.lease
    await bounded('append guest retired before first DOM', owner.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(early.partition)});
      view.setAttribute('src', ${JSON.stringify(`about:blank#${early.lease}`)});
      document.body.append(view);
    })()`))
    await bounded('early readiness rejection', waits.get(early.lease).done)
    const retired = physical.get(early.lease)
    assert.ok(retired, 'the released physical guest must have reached production input setup')
    await bounded('joined native retirement', Promise.all(retired.releases.map(item => item.done)))
    await bounded('foreign retirement release', retired.foreignReleaseDuringRetirement.done)
    assert.equal(retired.releaseStartedBeforeFirstDom, true)
    assert.equal(waits.get(early.lease).state, 'rejected')
    assert.match(waits.get(early.lease).error, /guest lease released/u)
    for (const release of retired.releases) {
      assert.equal(release.state, 'fulfilled', release.error)
      assert.deepEqual(release.atFulfillment, { guestDestroyed: true, destroyedObserved: true, inputDisposals: 1 })
    }
    assert.equal(retired.foreignReleaseDuringRetirement.state, 'rejected')
    assert.match(retired.foreignReleaseDuringRetirement.error, /another window/u)
    assert.equal(retired.guest.isDestroyed(), true)
    assert.equal(retired.destroyed, true)
    assert.equal(retired.inputDisposals, 1)
    await assert.rejects(manager.waitForAttachment(owner.webContents, early.lease), /no longer active/u)
    report.releaseBeforeFirstDom = { lease: early.lease, startedBeforeFirstDom: true, readinessRejected: true,
      concurrentReleasesJoined: true, releaseFulfillment: retired.releases.map(item => item.atFulfillment),
      foreignRetirementReleaseRejected: true, exactGuestDestroyed: true, inputDisposals: retired.inputDisposals }
    const failing = reserve()
    retireDuringInput = failing.lease
    cleanupFailureLease = failing.lease
    await bounded('append guest with throwing late input disposer', owner.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(failing.partition)});
      view.setAttribute('src', ${JSON.stringify(`about:blank#${failing.lease}`)});
      document.body.append(view);
    })()`))
    await bounded('throwing cleanup readiness rejection', waits.get(failing.lease).done)
    const failed = physical.get(failing.lease)
    assert.ok(failed)
    await bounded('throwing late input cleanup joins destruction', Promise.all(failed.releases.map(item => item.done)))
    await bounded('foreign throwing-cleanup retirement release', failed.foreignReleaseDuringRetirement.done)
    assert.equal(failed.releaseStartedBeforeFirstDom, true)
    assert.equal(waits.get(failing.lease).state, 'rejected')
    assert.match(waits.get(failing.lease).error, /guest lease released/u)
    for (const release of failed.releases) {
      assert.equal(release.state, 'rejected')
      assert.match(release.error, /native late input cleanup/u)
      assert.deepEqual(release.atRejection, { guestDestroyed: true, destroyedObserved: true, inputDisposals: 1 })
    }
    assert.equal(failed.foreignReleaseDuringRetirement.state, 'rejected')
    assert.match(failed.foreignReleaseDuringRetirement.error, /another window/u)
    assert.equal(failed.guest.isDestroyed(), true)
    report.throwingLateInputCleanup = { lease: failing.lease, startedBeforeFirstDom: true,
      joinedReleases: failed.releases.map(item => ({ state: item.state, error: item.error, atRejection: item.atRejection })),
      exactGuestDestroyed: true, inputDisposals: failed.inputDisposals }
    for (const window of owners) {
      assert.equal(window.isVisible(), false)
      assert.equal(window.isFocused(), false)
    }
    assert.deepEqual(report.windowEvents, [])
  } finally {
    try {
      for (const reservation of reservations) await bounded('cleanup guest release', manager.release(reservation.owner, reservation.lease))
      for (const owner of owners) {
        if (!owner.isDestroyed()) {
          const closed = once(owner, 'closed')
          owner.destroy()
          await bounded('cleanup owner destruction', closed)
        }
      }
      assert.equal(activeInput.size, 0)
      assert.ok([...physical.values()].every(record => record.guest.isDestroyed() && record.inputDisposals === 1))
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      report.cleanup = true
      await writeFile(join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
    } finally { clearTimeout(watchdog) }
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
