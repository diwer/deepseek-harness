/** Qualifies guest-private debugger input and hidden capture through the production guest owner. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, session } from 'electron'
import { DesktopBrowserGuests } from '../../lib/types/browser-guests.js'

const root = process.env.DSH_BROWSER_PROTOCOL_TEST_ROOT
const origin = process.env.DSH_BROWSER_PROTOCOL_TEST_ORIGIN
assert.ok(root, 'the isolated runner must supply its private directory')
assert.ok(origin && new URL(origin).hostname === '127.0.0.1' && new URL(origin).protocol === 'http:', 'an owned loopback fixture is required')
assert.equal(process.versions.electron, '44.7.0', 'this qualification is specific to Electron 44.7.0')
assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false)
assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false)
await mkdir(join(root, 'profile'), { recursive: true })
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')

async function bounded(label, operation, ms = 5000) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const watchdog = setTimeout(() => { console.error('Native browser protocol qualification deadline exceeded'); app.exit(1) }, 90000)
  const manager = new DesktopBrowserGuests(() => undefined)
  const owners = []
  const records = []
  const activeInput = new Set()
  const report = {
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch, activationPolicy: process.platform === 'darwin' ? 'prohibited' : 'not applicable',
    productionOwner: 'DesktopBrowserGuests.acquire/bind/release from existing lib/types artifact',
    remoteDebuggingPort: false, osInputCalls: false, showOrFocusCalls: false,
    scenarios: [], cleanup: false,
  }
  try {
    await app.whenReady()
    await qualifyIdentity()
    for (const scenario of process.env.DSH_BROWSER_PROTOCOL_IDENTITY_ONLY === '1' ? [] : [
      { name: 'hidden-window-default', paintWhenInitiallyHidden: true, cssHidden: false, captures: 'both' },
      { name: 'hidden-window-no-initial-paint-cdp', paintWhenInitiallyHidden: false, cssHidden: false, captures: 'cdp' },
      { name: 'hidden-window-no-initial-paint-native', paintWhenInitiallyHidden: false, cssHidden: false, captures: 'native' },
      { name: 'hidden-window-css-hidden-guest-cdp', paintWhenInitiallyHidden: true, cssHidden: true, captures: 'cdp' },
      { name: 'hidden-window-css-hidden-guest-native', paintWhenInitiallyHidden: true, cssHidden: true, captures: 'native' },
    ]) {
      const owner = new BrowserWindow({
        show: false, width: 700, height: 440, paintWhenInitiallyHidden: scenario.paintWhenInitiallyHidden,
        webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      owners.push(owner)
      const native = []
      const windowEvents = []
      let prevent = false
      let phase = 'bootstrap'
      owner.on('show', () => windowEvents.push('show'))
      owner.on('focus', () => windowEvents.push('focus'))
      manager.bind(owner, (guest, lease) => {
        activeInput.add(lease)
        const key = (event, input) => {
          if (prevent) event.preventDefault()
          native.push({ phase, source: 'before-input-event', prevented: event.defaultPrevented,
            type: input.type, key: input.key, code: input.code, modifiers: input.modifiers,
            isAutoRepeat: input.isAutoRepeat, isComposing: input.isComposing })
        }
        const mouse = (event, input) => {
          if (prevent) event.preventDefault()
          native.push({ phase, source: 'before-mouse-event', prevented: event.defaultPrevented,
            type: input.type, x: input.x, y: input.y, button: input.button, clickCount: input.clickCount,
            modifiers: input.modifiers })
        }
        guest.on('before-input-event', key)
        guest.on('before-mouse-event', mouse)
        return () => {
          guest.off('before-input-event', key)
          guest.off('before-mouse-event', mouse)
          activeInput.delete(lease)
        }
      })
      await owner.loadURL('data:text/html,<!doctype html><style>html,body{margin:0}webview{display:flex;width:640px;height:360px}</style><main>Private protocol owner</main>')
      const reservation = manager.acquire(owner.webContents, scenario.name)
      const record = { owner: owner.webContents, ...reservation }
      records.push(record)
      const attached = new Promise(resolve => {
        owner.webContents.once('did-attach-webview', (_event, guest) => {
          record.guest = guest
          record.attachment = { urlAtDidAttach: guest.getURL(), expectedBootstrap: `about:blank#${reservation.lease}`,
            additionalArguments: guest.getLastWebPreferences().additionalArguments }
          guest.once('dom-ready', () => resolve(guest))
        })
      })
      await owner.webContents.executeJavaScript(`(() => {
        const view = document.createElement('webview');
        view.id = 'probe';
        view.setAttribute('partition', ${JSON.stringify(reservation.partition)});
        view.setAttribute('src', ${JSON.stringify(`about:blank#${reservation.lease}`)});
        document.body.append(view);
      })()`)
      const guest = await bounded('production guest attachment', attached)
      await bounded('production native attachment readiness', manager.waitForAttachment(owner.webContents, reservation.lease))
      assert.ok(activeInput.has(reservation.lease), 'production guest owner must have installed input listeners')
      await bounded('loopback guest load', guest.loadURL(origin))
      const preferences = guest.getLastWebPreferences()
      assert.deepEqual([preferences.nodeIntegration, preferences.contextIsolation, preferences.sandbox, preferences.webSecurity], [false, true, true, true])
      if (scenario.cssHidden) {
        await owner.webContents.executeJavaScript('document.querySelector("#probe").style.display = "none"')
      }
      guest.debugger.attach('1.3')
      const protocol = (method, params = {}) => bounded(method, guest.debugger.sendCommand(method, params))
      const evaluate = script => bounded('guest DOM observation', guest.executeJavaScript(script))
      const state = async () => ({
        windowVisible: owner.isVisible(), windowFocused: owner.isFocused(),
        ownerFocused: owner.webContents.isFocused(), guestFocused: guest.isFocused(),
        ownerDOM: await owner.webContents.executeJavaScript('({visibility:document.visibilityState,focused:document.hasFocus(),display:getComputedStyle(document.querySelector("#probe")).display})'),
        guestDOM: await evaluate('({visibility:document.visibilityState,focused:document.hasFocus(),width:innerWidth,height:innerHeight,active:document.activeElement.id,visibilityEvents:window.probe.visibilityEvents})'),
      })
      const result = { ...scenario, captureMode: scenario.captures, attachment: record.attachment, initial: await state(), inputs: [], captures: [], native, windowEvents }
      report.scenarios.push(result)
      assert.equal(result.initial.windowVisible, false)
      assert.equal(result.initial.windowFocused, false)
      async function click(x, y) {
        await protocol('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await protocol('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      }
      async function key(text, variant = 'keyDown-with-text') {
        const upper = text.toUpperCase()
        const identity = { key: text, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), nativeVirtualKeyCode: upper.charCodeAt(0) }
        await protocol('Input.dispatchKeyEvent', { ...identity,
          type: variant.startsWith('raw') ? 'rawKeyDown' : 'keyDown',
          ...(variant === 'keyDown-with-text' ? { text, unmodifiedText: text } : {}) })
        if (variant === 'rawKeyDown-plus-char') await protocol('Input.dispatchKeyEvent', { ...identity, type: 'char', text, unmodifiedText: text })
        await protocol('Input.dispatchKeyEvent', { ...identity, type: 'keyUp' })
      }
      async function closedGateAlternatives(prefix) {
        prevent = true
        const observations = []
        for (const alternative of ['Input.insertText', ...(scenario.captures === 'both' ? ['Input.synthesizeTapGesture-touch', 'Input.synthesizeTapGesture-mouse'] : [])]) {
          phase = `${prefix}:${alternative}`
          await evaluate('window.probe.reset(); document.querySelector("#entry").focus()')
          const start = native.length
          try {
            await (alternative === 'Input.insertText'
              ? protocol(alternative, { text: 'insert' })
              : protocol('Input.synthesizeTapGesture', { x: 80, y: 64, duration: 50, gestureSourceType: alternative.endsWith('touch') ? 'touch' : 'mouse' }))
            observations.push({ method: alternative, ok: true, dom: await evaluate('window.probe.read()'), native: native.slice(start), state: await state() })
          } catch (error) {
            observations.push({ method: alternative, ok: false, error: String(error), native: native.slice(start), state: await state() })
          }
        }
        return observations
      }
      phase = 'initial-key-without-focus-emulation'
      await evaluate('document.querySelector("#entry").focus()')
      await key('z')
      result.initialKey = { dom: await evaluate('window.probe.read()'), state: await state() }
      result.closedGateWithoutFocusEmulation = await closedGateAlternatives('without-focus-emulation')
      // CDP focus emulation changes renderer state only; the native window stays hidden/unfocused.
      await protocol('Emulation.setFocusEmulationEnabled', { enabled: true })
      result.focusEmulation = await state()
      for (const step of [
        { phase: 'gate-open-initial', prevent: false, text: 'a' },
        { phase: 'gate-closed', prevent: true, text: 'b' },
        { phase: 'gate-open-control', prevent: false, text: 'c' },
        { phase: 'gate-reclosed', prevent: true, text: 'd' },
      ]) {
        phase = step.phase
        prevent = step.prevent
        const start = native.length
        await evaluate('window.probe.reset()')
        const before = await state()
        await click(80, 64)
        const afterMouse = await evaluate('window.probe.read()')
        const keys = []
        for (const variant of ['keyDown-with-text', 'rawKeyDown-only', 'rawKeyDown-plus-char', 'keyDown-without-text']) {
          phase = `${step.phase}:${variant}`
          await evaluate('window.probe.reset(); document.querySelector("#entry").focus()')
          const keyStart = native.length
          await key(step.text, variant)
          keys.push({ variant, dom: await evaluate('window.probe.read()'), native: native.slice(keyStart) })
        }
        const events = native.slice(start)
        result.inputs.push({ phase: step.phase, prevent, text: step.text, before, afterMouse, keys,
          nativeMouse: events.filter(event => event.source === 'before-mouse-event').length,
          after: await state() })
      }
      // This native synthetic control checks that preventDefault listeners actually intercept input.
      phase = 'sendInputEvent-gate-closed-control'
      prevent = true
      await evaluate('window.probe.reset(); document.querySelector("#entry").focus()')
      const nativeStart = native.length
      guest.sendInputEvent({ type: 'mouseDown', x: 80, y: 64, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseUp', x: 80, y: 64, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
      guest.sendInputEvent({ type: 'char', keyCode: 'x' })
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
      result.nativeControl = { dom: await evaluate('window.probe.read()'), events: native.slice(nativeStart) }
      result.closedGateAlternatives = await closedGateAlternatives('with-focus-emulation')
      await protocol('Emulation.setFocusEmulationEnabled', { enabled: false })
      result.afterFocusEmulationDisabled = await state()
      const captures = scenario.captures === 'both' ? [
        { name: 'Page.captureScreenshot', color: '#e11d48', rgb: [225, 29, 72] },
        { name: 'capturePage-stayHidden', color: '#16a34a', rgb: [22, 163, 74] },
        { name: 'Page.captureScreenshot-updated', color: '#2563eb', rgb: [37, 99, 235] },
        { name: 'capturePage-after-cdp-frame', color: '#2563eb', rgb: [37, 99, 235] },
      ] : scenario.captures === 'cdp' ? [
        { name: 'Page.captureScreenshot', color: '#e11d48', rgb: [225, 29, 72] },
      ] : [{ name: 'capturePage-stayHidden', color: '#16a34a', rgb: [22, 163, 74] }]
      for (const capture of captures) {
        phase = capture.name
        await evaluate(`document.querySelector('#marker').style.background = ${JSON.stringify(capture.color)}`)
        const before = await state()
        const start = Date.now()
        try {
          const image = capture.name.startsWith('Page.')
            ? nativeImage.createFromBuffer(Buffer.from((await protocol('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64'))
            : await bounded('capturePage stayHidden', guest.capturePage(undefined, { stayHidden: true, stayAwake: false }))
          const png = image.toPNG()
          const size = image.getSize()
          const bitmap = image.toBitmap({ scaleFactor: 1 })
          const pixel = size.width > 8 && size.height > 8 ? [...bitmap.subarray((8 * size.width + 8) * 4, (8 * size.width + 8) * 4 + 4)] : []
          const observedRGB = [pixel[2], pixel[1], pixel[0]]
          const file = `${scenario.name}-${capture.name.replaceAll('.', '-')}.png`
          await writeFile(join(root, file), png)
          result.captures.push({ method: capture.name, ok: true, ms: Date.now() - start, size, bytes: png.length,
            sha256: createHash('sha256').update(png).digest('hex'), expectedRGB: capture.rgb, observedRGB,
            freshMarker: capture.rgb.every((value, index) => Math.abs(value - observedRGB[index]) <= 2), file, before, after: await state() })
        } catch (error) {
          result.captures.push({ method: capture.name, ok: false, ms: Date.now() - start, error: String(error), before, after: await state() })
        }
      }
      result.final = await state()
      assert.equal(owner.isVisible(), false, 'qualification must never show the owner')
      assert.equal(owner.isFocused(), false, 'qualification must never focus the owner')
      assert.deepEqual(windowEvents, [], 'no show or native focus transition is allowed')
      guest.debugger.detach()
      await bounded('production guest release', manager.release(record.owner, record.lease))
      assert.equal(guest.isDestroyed(), true)
      assert.equal(activeInput.has(reservation.lease), false)
      const closed = once(owner, 'closed')
      owner.destroy()
      await closed
      console.log(`Native browser protocol observed: ${scenario.name}`)
    }
    async function qualifyIdentity() {
      const owner = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      owners.push(owner)
      const identityEvents = []
      owner.on('show', () => identityEvents.push('show'))
      owner.on('focus', () => identityEvents.push('focus'))
      const inputAttachments = new Map()
      manager.bind(owner, (guest, lease) => {
        inputAttachments.set(guest, { lease, userAgent: guest.getUserAgent() })
        activeInput.add(lease)
        return () => { activeInput.delete(lease) }
      })
      await owner.loadURL('data:text/html,<!doctype html><title>Concurrent private identity probe</title>')
      const pair = [manager.acquire(owner.webContents, 'identity-shared-workspace'), manager.acquire(owner.webContents, 'identity-shared-workspace')]
      for (const reservation of pair) records.push({ owner: owner.webContents, ...reservation })
      assert.equal(pair[0].partition, pair[1].partition, 'the identity probe must not distinguish guests by partition')
      const identityGuests = []
      const identity = { samePartition: true, reversedAppendOrder: true, expectedPartition: pair[0].partition, expectedLeases: pair.map(item => item.lease), stamps: [], attachments: [], windowEvents: identityEvents }
      report.concurrentAttachmentIdentity = identity
      owner.webContents.on('will-attach-webview', (_event, preferences, params) => {
        identity.stamps.push({ params: { ...params }, preferences: { ...preferences } })
      })
      const beforeMain = new Map()
      // Read-only capture precedes production's synchronous marker consumption and restoration.
      owner.webContents.prependListener('did-attach-webview', (_event, guest) => {
        beforeMain.set(guest, { userAgent: guest.getUserAgent(), url: guest.getURL() })
      })
      const ready = new Promise((resolve, reject) => {
        let count = 0
        owner.webContents.on('did-attach-webview', (_event, guest) => {
          const before = beforeMain.get(guest)
          assert.ok(before, 'the read-only observer must precede production attachment handling')
          const userAgentAtDidAttach = before.userAgent
          const defaultUserAgent = guest.session.getUserAgent()
          const restoredUserAgentAtDidAttach = guest.getUserAgent()
          const nativeInput = inputAttachments.get(guest)
          assert.ok(nativeInput, 'production must bind the exact guest before later attachment observers')
          const preferences = guest.getLastWebPreferences()
          const argumentsAtDidAttach = preferences.additionalArguments ?? null
          const attachment = {
            lease: nativeInput.lease, leaseViaUserAgent: userAgentAtDidAttach.startsWith('DSH-BrowserBootstrap/') ? userAgentAtDidAttach.slice('DSH-BrowserBootstrap/'.length) : null,
            userAgentAtDidAttach, defaultUserAgent, restoredUserAgentAtDidAttach, userAgentAtInputAttachment: nativeInput.userAgent,
            urlAtDidAttach: before.url, argumentsAtDidAttach,
            partitionAtDidAttach: preferences.partition ?? null,
            sessionMatchesExpectedPartition: guest.session === session.fromPartition(pair[0].partition),
            frameNameAtDidAttach: guest.mainFrame.name, preferences,
          }
          identity.attachments.push(attachment)
          identityGuests.push({ guest, attachment })
          guest.once('dom-ready', () => {
            attachment.atDomReady = { url: guest.getURL(), frameName: guest.mainFrame.name, preferences: guest.getLastWebPreferences(), userAgent: guest.getUserAgent() }
            void guest.executeJavaScript('navigator.userAgent').then(navigatorUserAgent => {
              attachment.atDomReady.navigatorUserAgent = navigatorUserAgent
              if (++count === 2) resolve()
            }, reject)
          })
        })
      })
      const readyBounded = bounded('concurrent stamped guest identity', ready)
      await Promise.all([readyBounded, owner.webContents.executeJavaScript(`(() => {
        for (const lease of ${JSON.stringify(pair.toReversed())}) {
          const view = document.createElement('webview');
          view.setAttribute('partition', lease.partition);
          view.setAttribute('name', 'renderer-' + lease.lease);
          view.setAttribute('src', 'about:blank#' + lease.lease);
          document.body.append(view);
        }
      })()`)])
      await Promise.all(pair.map(reservation => bounded('concurrent production readiness', manager.waitForAttachment(owner.webContents, reservation.lease))))
      for (const [index, { guest, attachment }] of identityGuests.entries()) {
        await bounded('first HTTP navigation after identity restoration', guest.loadURL(`${origin}/?ua_probe=${index}`))
        attachment.firstHTTPNavigation = {
          userAgent: guest.getUserAgent(), navigatorUserAgent: await bounded('first HTTP navigator UA', guest.executeJavaScript('navigator.userAgent')),
          markerAbsent: !guest.getUserAgent().includes('DSH-BrowserBootstrap/'),
        }
      }
      identity.userAgentIdentitySupported = identity.attachments.every(item => item.lease === item.leaseViaUserAgent && pair.some(reservation => reservation.lease === item.leaseViaUserAgent))
        && new Set(identity.attachments.map(item => item.leaseViaUserAgent)).size === 2
      identity.userAgentRestorationSupported = identity.attachments.every(item => item.restoredUserAgentAtDidAttach === item.defaultUserAgent
        && item.userAgentAtInputAttachment === item.defaultUserAgent && item.atDomReady.userAgent === item.defaultUserAgent && item.atDomReady.navigatorUserAgent === item.defaultUserAgent
        && item.firstHTTPNavigation.userAgent === item.defaultUserAgent && item.firstHTTPNavigation.navigatorUserAgent === item.defaultUserAgent)
      assert.equal(identity.attachments.length, 2)
      assert.equal(owner.isVisible(), false)
      assert.equal(owner.isFocused(), false)
      assert.deepEqual(identityEvents, [])
      console.log(`Native browser attachment identity observed: ${JSON.stringify(identity)}`)
      for (const reservation of pair) await bounded('identity guest release', manager.release(owner.webContents, reservation.lease))
      const closed = once(owner, 'closed')
      owner.destroy()
      await closed
    }
  } finally {
    try {
      for (const record of records) {
        if (record.guest && !record.guest.isDestroyed() && record.guest.debugger.isAttached()) record.guest.debugger.detach()
        await bounded('cleanup guest release', manager.release(record.owner, record.lease))
      }
      for (const owner of owners) {
        if (!owner.isDestroyed()) {
          const closed = once(owner, 'closed')
          owner.destroy()
          await closed
        }
      }
      assert.equal(activeInput.size, 0)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      report.cleanup = true
      await writeFile(join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
    } finally {
      clearTimeout(watchdog)
    }
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
