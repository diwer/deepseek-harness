// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }
const fixtures: ReturnType<typeof electronFixture>[] = []
function fixture() {
  const proof = Promise.withResolvers<undefined>()
  const wait = vi.fn((_lease: DesktopBrowserLeaseId) => proof.promise)
  const h = electronFixture(undefined, { protocolVersion: 1, wait })
  fixtures.push(h)
  return { ...h, proof, wait }
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose()
  vi.restoreAllMocks()
})

it('does not treat renderer dom-ready, presentation or navigation metadata as Main proof', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  expect(h.wait).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  guest.state.url = target.url
  guest.state.title = 'Unconfirmed document'
  guest.state.loading = false
  guest.emit('dom-ready')
  guest.emit('did-navigate')
  guest.emit('did-stop-loading')
  h.frame.goBack()
  h.frame.goForward()
  h.frame.reload()
  // Drain all derived promise reactions while Main proof remains unresolved.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(guest.loadURL).not.toHaveBeenCalled()
  expect(guest.goBack).not.toHaveBeenCalled()
  expect(guest.goForward).not.toHaveBeenCalled()
  expect(guest.reload).not.toHaveBeenCalled()
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'requested', loading: true, target })
  h.proof.resolve(undefined)
  await vi.waitFor(() => { expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
  guest.emit('dom-ready')
  expect(h.wait).toHaveBeenCalledOnce()
  expect(guest.loadURL).toHaveBeenCalledOnce()
})

it('also waits for renderer dom-ready when Main confirms first', async () => {
  const h = fixture()
  h.proof.resolve(undefined)
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  await h.proof.promise
  expect(guest.loadURL).not.toHaveBeenCalled()
  guest.emit('dom-ready')
  await vi.waitFor(() => { expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
})

it('loads only the latest requested address after the two readiness boundaries', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  const latest = { ...target, url: 'https://example.test/latest' }
  h.frame.loadUrl(latest)
  expect(guest.loadURL).not.toHaveBeenCalled()
  h.proof.resolve(undefined)
  await vi.waitFor(() => { expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(latest.url) })
})

it('disposes without waiting for a late Main answer and never navigates afterward', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  await h.frame.dispose()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.opens.size).toBe(0)
  h.proof.resolve(undefined)
  await h.proof.promise
  await new Promise(resolve => setTimeout(resolve, 0))
  guest.emit('dom-ready')
  expect(guest.loadURL).not.toHaveBeenCalled()
  expect(h.host.childElementCount).toBe(0)
})

it('consumes a late Main rejection after cancellation without reporting an active failure', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  await h.frame.dispose()
  h.proof.reject(new Error('released lease'))
  await expect(h.proof.promise).rejects.toThrow('released lease')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(guest.loadURL).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})

it('publishes an active proof failure, releases the guest, and permits a new exact lease', async () => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  h.proof.reject(new Error('Main attachment failed'))
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(first.loadURL).not.toHaveBeenCalled()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.opens.size).toBe(0)
  const secondProof = Promise.withResolvers<undefined>()
  const next = { ...h.reservation, lease: 'retry-lease' as DesktopBrowserLeaseId }
  h.bridge.acquire.mockResolvedValueOnce(next)
  h.wait.mockReturnValueOnce(secondProof.promise)
  h.frame.reload()
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(h.wait).toHaveBeenLastCalledWith(next.lease)
  second.emit('dom-ready')
  expect(second.loadURL).not.toHaveBeenCalled()
  secondProof.resolve(undefined)
  await vi.waitFor(() => { expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
  expect(h.frame.getSnapshot().error).toBeUndefined()
})

it('accepts a synchronous retry from the proof failure publication on the same mount', async () => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const nextProof = Promise.withResolvers<undefined>()
  const next = { ...h.reservation, lease: 'reentrant-retry-lease' as DesktopBrowserLeaseId }
  h.bridge.acquire.mockResolvedValueOnce(next)
  h.wait.mockReturnValueOnce(nextProof.promise)
  const unsubscribe = h.frame.subscribe(() => {
    if (h.frame.getSnapshot().error === undefined) return
    unsubscribe()
    h.frame.reload()
  })
  try {
    h.proof.reject(new Error('Main attachment failed'))
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledTimes(2) })
    const second = await h.guest()
    expect(second.element).not.toBe(first.element)
    expect(h.wait).toHaveBeenLastCalledWith(next.lease)
    second.emit('dom-ready')
    nextProof.resolve(undefined)
    await vi.waitFor(() => { expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
    expect(first.loadURL).not.toHaveBeenCalled()
    expect(h.frame.getSnapshot().error).toBeUndefined()
  } finally {
    unsubscribe()
  }
})

it.each(['reload', 'navigate'])('preserves explicit %s demand while failed proof cleanup awaits release', async (command) => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const released = Promise.withResolvers<undefined>()
  h.bridge.release.mockReturnValueOnce(released.promise)
  const nextProof = Promise.withResolvers<undefined>()
  const next = { ...h.reservation, lease: 'cleanup-retry-lease' as DesktopBrowserLeaseId }
  h.bridge.acquire.mockResolvedValueOnce(next)
  h.wait.mockReturnValueOnce(nextProof.promise)
  try {
    h.proof.reject(new Error('obsolete attachment failure'))
    await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease) })
    const latest = command === 'navigate' ? { ...target, url: 'https://example.test/retry' } : target
    if (command === 'navigate') h.frame.loadUrl(latest)
    else h.frame.reload()
    expect(h.bridge.acquire).toHaveBeenCalledOnce()
    released.resolve(undefined)
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledTimes(2) })
    const second = await h.guest()
    second.emit('dom-ready')
    nextProof.resolve(undefined)
    await vi.waitFor(() => { expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(latest.url) })
    expect(first.loadURL).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  } finally {
    released.resolve(undefined)
  }
})

it('does not automatically retry a crashed unconfirmed guest without new demand', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('render-process-gone')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  expect(h.frame.getSnapshot().error).toBeDefined()
})

it.each(['render-process-gone', 'destroyed'])('preserves a same-stack retry while %s cancels the pending proof', async (event) => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const nextProof = Promise.withResolvers<undefined>()
  const next = { ...h.reservation, lease: 'crash-retry-lease' as DesktopBrowserLeaseId }
  h.bridge.acquire.mockResolvedValueOnce(next)
  h.wait.mockReturnValueOnce(nextProof.promise)
  first.emit(event)
  h.frame.reload()
  await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledTimes(2) })
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  second.emit('dom-ready')
  nextProof.resolve(undefined)
  await vi.waitFor(() => { expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
  h.proof.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(first.loadURL).not.toHaveBeenCalled()
  expect(h.wait.mock.calls.map(([lease]) => lease)).toEqual([h.reservation.lease, next.lease])
})

it('does not transfer an old physical attachment proof across detach and remount', async () => {
  const h = fixture()
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  const nextProof = Promise.withResolvers<undefined>()
  const next = { ...h.reservation, lease: 'remount-lease' as DesktopBrowserLeaseId }
  h.bridge.acquire.mockResolvedValueOnce(next)
  h.wait.mockReturnValueOnce(nextProof.promise)
  unmount()
  h.mount()
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  second.emit('dom-ready')
  h.proof.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 0))
  h.frame.reload()
  expect(first.loadURL).not.toHaveBeenCalled()
  expect(second.loadURL).not.toHaveBeenCalled()
  expect(second.reload).not.toHaveBeenCalled()
  nextProof.resolve(undefined)
  await vi.waitFor(() => { expect(second.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
  expect(h.wait.mock.calls.map(([lease]) => lease)).toEqual([h.reservation.lease, next.lease])
})

it('does not start a Main wait when presentation synchronously removes its guest', async () => {
  const h = fixture()
  const unmount = h.mount()
  const present = h.presentation.present.bind(h.presentation)
  vi.spyOn(h.presentation, 'present').mockImplementation((element) => {
    present(element)
    unmount()
  })
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease) })
  expect(h.wait).not.toHaveBeenCalled()
  expect(h.host.childElementCount).toBe(0)
})

it('removes its cancellation listener after successful proof instead of retaining completed waits', async () => {
  const h = fixture()
  const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const before = remove.mock.calls.length
  guest.emit('dom-ready')
  h.proof.resolve(undefined)
  await vi.waitFor(() => { expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(target.url) })
  expect(remove.mock.calls.slice(before).some(([name]) => name === 'abort')).toBe(true)
})
