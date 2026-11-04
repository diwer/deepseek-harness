/** Runs only checkout Electron, an owned loopback page, and a private qualification profile. */
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
const relativeBinary = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim()
assert.equal(electron, join(electronDirectory, 'dist', relativeBinary), 'only checkout Electron may run')
assert.equal(electronVersion, '44.7.0', 'this qualification requires Electron 44.7.0')
assert.notEqual(process.platform, 'win32', 'bounded owned process-group shutdown requires POSIX')
const sourcePath = fileURLToPath(new URL('../src/browser-guests.ts', import.meta.url))
const artifactPath = fileURLToPath(new URL('../lib/types/browser-guests.js', import.meta.url))
assert.equal(process.env.DSH_BROWSER_PROTOCOL_BASELINE_REVISION, undefined, 'baseline overrides are unsupported; this qualification requires current source and artifacts')
const source = await readFile(sourcePath, 'utf8')
const artifact = await readFile(artifactPath, 'utf8')
const ts = require('typescript')
const emitted = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText
const withoutMap = text => text.replace(/^\/\/# sourceMappingURL=.*$/mu, '').trim()
assert.ok(withoutMap(artifact) === withoutMap(emitted), 'the existing production guest artifact must match current source; rebuild it before qualification')
const productionInputArtifacts = []
for (const name of ['keyboard', 'keybindings', 'ipc']) {
  const sourcePath = fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url))
  const artifactPath = fileURLToPath(new URL(`../lib/types/${name}.js`, import.meta.url))
  const source = await readFile(sourcePath, 'utf8')
  const artifact = await readFile(artifactPath, 'utf8')
  const emitted = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
  } }).outputText
  assert.equal(withoutMap(artifact), withoutMap(emitted), `existing ${name}.js is stale; stop qualification without rebuilding or syncing`)
  productionInputArtifacts.push({ name, sourcePath, artifactPath, matchesCurrentSource: true,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    artifactSha256: createHash('sha256').update(artifact).digest('hex') })
}
const directory = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
await mkdir(directory, { recursive: true })
const root = await mkdtemp(join(directory, 'browser-protocol-'))
const fixture = fileURLToPath(new URL('../tests/fixtures/browser-protocol.mjs', import.meta.url))
const requestObservations = []
const server = createServer((request, response) => {
  requestObservations.push({ url: request.url, userAgent: request.headers['user-agent'] ?? null })
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
  if (new URL(request.url, 'http://127.0.0.1').pathname !== '/') { response.writeHead(404); response.end(); return }
  response.end(`<!doctype html><title>Private guest protocol qualification</title>
<style>html,body{margin:0;width:100%;height:100%;background:#fff}#marker{position:absolute;left:0;top:0;width:32px;height:32px;background:#000}#button{position:absolute;left:40px;top:44px;width:140px;height:40px}#entry{position:absolute;left:40px;top:110px;width:200px;height:30px}</style>
<div id="marker"></div><button id="button">Protocol target</button><input id="entry" aria-label="Protocol entry">
<script>
const entry=document.querySelector('#entry');
window.probe={clicks:0,events:[],visibilityEvents:[],reset(){this.clicks=0;this.events=[];entry.value=''},read(){return{clicks:this.clicks,value:entry.value,active:document.activeElement.id,events:this.events}}};
document.querySelector('#button').addEventListener('click',()=>window.probe.clicks++);
for(const type of ['mousedown','mouseup','click','keydown','keyup','beforeinput','input'])document.addEventListener(type,event=>window.probe.events.push({type,target:event.target.id,trusted:event.isTrusted,key:event.key,data:event.data}));
document.addEventListener('visibilitychange',()=>window.probe.visibilityEvents.push(document.visibilityState));
</script>`)
})
let child
let childClosed
let closed = false
let timedOut = false
let deadline
let stdout = ''
let stderr = ''
let result
function terminateOwnedChild() {
  if (!child?.pid || closed) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, DSH_BROWSER_PROTOCOL_TEST_ROOT: root, DSH_BROWSER_PROTOCOL_TEST_ORIGIN: origin }
  for (const key of Object.keys(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/u.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key]
  }
  child = spawn(electron, [fixture], { env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  childClosed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', text => { stdout += text; if (stdout.length + stderr.length > 1024 * 1024) terminateOwnedChild() })
  child.stderr.on('data', text => { stderr += text; if (stdout.length + stderr.length > 1024 * 1024) terminateOwnedChild() })
  deadline = setTimeout(() => { timedOut = true; terminateOwnedChild() }, 110000)
  const outcome = await childClosed
  clearTimeout(deadline)
  await writeFile(join(root, 'child-stdout.txt'), stdout)
  await writeFile(join(root, 'child-stderr.txt'), stderr)
  await writeFile(join(root, 'process.json'), JSON.stringify({ ...outcome, timedOut, pid: child.pid, electron, electronVersion }, null, 2) + '\n')
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  assert.equal(timedOut, false, `owned Electron child exceeded its deadline; evidence: ${root}`)
  assert.equal(outcome.signal, null, `owned Electron child was signalled; evidence: ${root}`)
  assert.equal(outcome.code, 0, `owned Electron child failed; evidence: ${root}`)
  const observation = JSON.parse(await readFile(join(root, 'observations.json'), 'utf8'))
  assert.equal(observation.electron, electronVersion)
  assert.equal(observation.cleanup, true)
  assert.equal(observation.scenarios.length, process.env.DSH_BROWSER_PROTOCOL_IDENTITY_ONLY === '1' ? 0 : 5)
  for (const scenario of observation.scenarios) {
    assert.deepEqual(scenario.windowEvents, [])
    assert.equal(scenario.final.windowVisible, false)
    assert.equal(scenario.final.windowFocused, false)
    assert.equal(scenario.inputs.length, 4)
    assert.equal(scenario.captures.length, scenario.captureMode === 'both' ? 4 : 1)
    console.log(JSON.stringify({ scenario: scenario.name, attachment: scenario.attachment, initial: scenario.initial,
      initialKey: scenario.initialKey, focusEmulation: scenario.focusEmulation,
      inputs: scenario.inputs.map(input => ({ phase: input.phase, clicks: input.afterMouse.clicks,
        nativeMouse: input.nativeMouse, keys: input.keys.map(key => ({ variant: key.variant, value: key.dom.value,
          domEvents: key.dom.events.map(event => event.type), native: key.native.map(event => ({ type: event.type, prevented: event.prevented })) })) })),
      alternativesWithoutFocusEmulation: scenario.closedGateWithoutFocusEmulation,
      alternatives: scenario.closedGateAlternatives,
      captures: scenario.captures.map(capture => ({ method: capture.method, ok: capture.ok,
        freshMarker: capture.freshMarker, size: capture.size, ms: capture.ms, error: capture.error })) }))
  }
  const baseline = observation.scenarios[0]
  if (baseline) {
    assert.deepEqual(baseline.inputs.map(input => input.afterMouse.clicks), [1, 0, 1, 0])
    for (const input of baseline.inputs) {
      const textKey = input.keys.find(key => key.variant === 'keyDown-with-text')
      assert.equal(textKey.dom.value, input.text)
      const rawKey = input.keys.find(key => key.variant === 'rawKeyDown-plus-char')
      assert.equal(rawKey.dom.value, input.prevent ? '' : input.text)
    }
    const touch = baseline.closedGateAlternatives.find(item => item.method === 'Input.synthesizeTapGesture-touch')
    assert.equal(touch.ok, true)
    assert.equal(touch.dom.clicks, 1)
    assert.ok(touch.dom.events.every(event => event.trusted))
    assert.deepEqual(touch.native, [])
    const inserted = baseline.closedGateAlternatives.find(item => item.method === 'Input.insertText')
    assert.equal(inserted.dom.value, 'insert')
    assert.ok(inserted.dom.events.every(event => event.trusted))
    assert.deepEqual(inserted.native, [])
    assert.ok(baseline.captures.filter(capture => capture.method.startsWith('Page.')).every(capture => capture.ok && capture.freshMarker))
    assert.equal(baseline.captures.find(capture => capture.method === 'capturePage-after-cdp-frame').freshMarker, true)
    const ignoredInput = baseline.ignoreInputEvents
    assert.equal(ignoredInput.artificialGateOpen, true)
    assert.deepEqual(ignoredInput.steps.map(step => step.ignore), [false, true, false])
    assert.equal(ignoredInput.restored.ignore, false)
    assert.equal(ignoredInput.restored.prevent, true)
    const fullKeyDelivered = key => key.fullKeyEventCounts.keydown === 1 && key.fullKeyEventCounts.keyup === 1
      && key.dom.events.every(event => event.trusted)
    const mouseDelivered = mouse => mouse.dom.clicks === 1
      && JSON.stringify(mouse.dom.events.map(event => event.type)) === JSON.stringify(['mousedown', 'mouseup', 'click'])
      && mouse.dom.events.every(event => event.trusted)
    for (const step of ignoredInput.steps) {
      const states = [step.before]
      for (const route of ['cdp', 'sendInputEvent']) {
        const sample = step[route]
        states.push(sample.mouse.state, ...sample.keys.map(key => key.state))
        assert.ok([...sample.mouse.native, ...sample.keys.flatMap(key => key.native)].every(event => !event.prevented), 'the artificial input gate must remain open')
        if (!step.ignore) {
          assert.equal(mouseDelivered(sample.mouse), true, `${step.phase}:${route}: mouse control must deliver a trusted click`)
          assert.ok(sample.keys.every(fullKeyDelivered), `${step.phase}:${route}: controls must deliver trusted keydown and keyup`)
          for (const key of sample.keys) assert.equal(key.dom.value, key.variant === 'keyDown-without-text' ? '' : route === 'cdp' ? 'i' : 'x')
        }
      }
      for (const state of states) {
        assert.deepEqual([state.windowVisible, state.windowFocused, state.ownerFocused, state.guestFocused], [false, false, false, false])
      }
    }
    assert.deepEqual([ignoredInput.restored.state.windowVisible, ignoredInput.restored.state.windowFocused,
      ignoredInput.restored.state.ownerFocused, ignoredInput.restored.state.guestFocused], [false, false, false, false])
    const ignored = ignoredInput.steps.find(step => step.ignore)
    ignoredInput.cdpMouseSupported = mouseDelivered(ignored.cdp.mouse)
    ignoredInput.cdpFullKeySupported = ignored.cdp.keys.every(fullKeyDelivered)
      && ignored.cdp.keys.every(key => key.dom.value === (key.variant === 'keyDown-without-text' ? '' : 'i'))
    ignoredInput.ordinaryInputBlocked = ignored.sendInputEvent.mouse.dom.clicks === 0 && ignored.sendInputEvent.mouse.dom.events.length === 0
      && ignored.sendInputEvent.keys.every(key => key.dom.value === '' && key.dom.events.length === 0)
    ignoredInput.selectiveInputSupported = ignoredInput.cdpMouseSupported && ignoredInput.cdpFullKeySupported && ignoredInput.ordinaryInputBlocked
    console.log(`Native browser ignore-input qualification ${ignoredInput.selectiveInputSupported ? 'selective candidate observed; authority/drain unqualified' : 'unsupported'}: ${JSON.stringify(ignoredInput)}`)
    const productionShortcuts = baseline.productionShortcuts
    assert.equal(productionShortcuts.artificialGateOpen, true)
    assert.equal(productionShortcuts.ignoreInputEvents, false)
    assert.equal(productionShortcuts.privateUserData, join(root, 'profile'))
    assert.equal(productionShortcuts.configurationIPCInvoked, false)
    assert.equal(productionShortcuts.taskAuthorityQualified, false)
    assert.equal(productionShortcuts.cleanup, true)
    assert.deepEqual(productionShortcuts.steps.map(step => step.blocked), [false, true, false])
    assert.deepEqual(productionShortcuts.steps.map(step => step.overlayRevision), [1, 2, 3])
    const productionStates = [productionShortcuts.restored.state]
    for (const step of productionShortcuts.steps) {
      assert.equal(step.syntheticPrevent, false)
      assert.equal(mouseDelivered(step.mouse), true, `${step.phase}: the production keyboard handler must leave the control mouse path unchanged`)
      assert.ok(step.mouse.native.length > 0 && step.mouse.native.every(event => !event.prevented && !event.syntheticPrevent))
      assert.deepEqual(step.keys.map(key => key.variant), ['keyDown-with-text', 'rawKeyDown-plus-char', 'keyDown-without-text'])
      for (const key of step.keys) {
        assert.ok(key.native.length > 0, `${step.phase}:${key.variant}: observe the actual production before-input listener`)
        assert.ok(key.native.every(event => event.source === 'before-input-event' && event.prevented === step.blocked
          && event.overlayBlocked === step.blocked && !event.syntheticPrevent), `${step.phase}:${key.variant}: production overlay prevention must match the supplied state`)
        assert.ok(key.dom.events.every(event => event.trusted))
        if (!step.blocked) {
          assert.equal(fullKeyDelivered(key), true, `${step.phase}:${key.variant}: actual production handler must pass the full trusted key path`)
          assert.equal(key.dom.value, key.variant === 'keyDown-without-text' ? '' : 'i')
        }
      }
      productionStates.push(step.before, step.mouse.state, ...step.keys.map(key => key.state))
      step.cdpFullKeyPathDelivered = step.keys.every(fullKeyDelivered)
      step.keyResults = step.keys.map(key => ({ variant: key.variant, fullKeyPathDelivered: fullKeyDelivered(key),
        fullKeyEventCounts: key.fullKeyEventCounts, value: key.dom.value, domEvents: key.dom.events.map(event => event.type) }))
    }
    for (const state of productionStates) {
      assert.deepEqual([state.windowVisible, state.windowFocused, state.ownerFocused, state.guestFocused], [false, false, false, false])
    }
    assert.equal(productionShortcuts.restored.overlayBlocked, false)
    assert.equal(productionShortcuts.restored.prevent, true)
    assert.deepEqual(productionShortcuts.restored.listenersAfter, productionShortcuts.restored.listenersBefore)
    productionShortcuts.openAndRestoredFullKeySupported = productionShortcuts.steps.filter(step => !step.blocked).every(step => step.cdpFullKeyPathDelivered)
    productionShortcuts.blockedFullKeySupported = productionShortcuts.steps.find(step => step.blocked).cdpFullKeyPathDelivered
    console.log(`Native browser production shortcuts qualification: ${JSON.stringify(productionShortcuts)}`)
  }
  assert.equal(observation.concurrentAttachmentIdentity.samePartition, true)
  assert.equal(observation.concurrentAttachmentIdentity.attachments.length, 2)
  assert.equal(observation.concurrentAttachmentIdentity.userAgentIdentitySupported, true)
  assert.equal(observation.concurrentAttachmentIdentity.userAgentRestorationSupported, true)
  assert.ok(observation.concurrentAttachmentIdentity.attachments.every(attachment => attachment.sessionMatchesExpectedPartition))
  const identityRequests = requestObservations.filter(request => request.url.startsWith('/?ua_probe='))
  const httpUserAgentRestorationSupported = identityRequests.length === 2 && identityRequests.every(request => {
    const index = Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('ua_probe'))
    return request.userAgent === observation.concurrentAttachmentIdentity.attachments[index].defaultUserAgent
  })
  console.log(`Native browser HTTP UA restoration observed: ${JSON.stringify({ identityRequests, httpUserAgentRestorationSupported })}`)
  assert.equal(httpUserAgentRestorationSupported, true)
  result = { ...observation, requestObservations, httpUserAgentRestorationSupported,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    productionArtifactMatchesCurrentSource: true, productionInputArtifacts, childOutcome: outcome, timedOut, childrenExited: true,
  }
} finally {
  clearTimeout(deadline)
  terminateOwnedChild()
  if (childClosed) await childClosed
  if (server.listening) {
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  if (result) await writeFile(join(root, 'result.json'), JSON.stringify({ ...result, serverClosed: true }, null, 2) + '\n')
  console.log(`Native browser protocol evidence: ${root}; owned loopback closed`)
}
