/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

const GUEST_LEASE_USER_AGENT = 'DSH-BrowserBootstrap/'
const ATTACHMENT_TIMEOUT_MS = 30_000

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  ready: boolean
  guest?: WebContents
  inputSetup?: Promise<void>
  releaseInput?: () => void
  attachmentWait?: {
    readonly promise: Promise<void>
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly retirements = new Map<DesktopBrowserLeaseId, { readonly owner: WebContents; readonly promise: Promise<void> }>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false, ready: false })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * Concurrent releases join native input disposal and exact guest destruction.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   * @returns after guest destruction; rejects on input disposal or native close failures.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) {
      const retirement = this.retirements.get(key)
      if (retirement === undefined) return
      if (retirement.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
      await retirement.promise
      return
    }
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    await this.releaseLease(key, lease, new Error('desktop browser: guest lease released'))
  }

  /**
   * Await this lease's exact guest, inert bootstrap document and installed native input.
   * The lease owns one 30-second deadline; timeout retires it and destroys its known guest.
   * @param owner - authenticated IPC sender.
   * @param id - one-shot lease received over IPC.
   * @returns when native attachment is ready; rejects for stale, foreign or retired leases.
   */
  async waitForAttachment(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) throw new Error('desktop browser: guest lease is no longer active')
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    if (lease.ready) return
    if (lease.attachmentWait === undefined) {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        void this.releaseLease(key, lease, new Error('desktop browser: native attachment timed out'))
          .catch((error: unknown) => { console.error(error) })
      }, ATTACHMENT_TIMEOUT_MS)
      lease.attachmentWait = { promise, resolve, reject, timer }
    }
    await lease.attachmentWait.promise
  }

  private releaseLease(id: DesktopBrowserLeaseId, lease: GuestLease, reason: Error): Promise<void> {
    const retirement = this.retirements.get(id)
    if (retirement !== undefined) return retirement.promise
    if (this.leases.get(id) !== lease) return Promise.resolve()
    // Reserve the join before input disposal or guest.close can reenter release.
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.retirements.set(id, { owner: lease.owner, promise })
    this.leases.delete(id)
    lease.ready = false
    const wait = lease.attachmentWait
    delete lease.attachmentWait
    if (wait !== undefined) { clearTimeout(wait.timer); wait.reject(reason) }
    const inputSetup = lease.inputSetup
    const drain = async (): Promise<void> => {
      try {
        if (inputSetup !== undefined) await inputSetup
        const releaseInput = lease.releaseInput
        delete lease.releaseInput
        releaseInput?.()
      } finally {
        const guest = lease.guest
        if (guest !== undefined && !guest.isDestroyed()) {
          const destroyed = new Promise<void>((done) => { guest.once('destroyed', done) })
          guest.close({ waitForBeforeUnload: false })
          await destroyed
        }
      }
    }
    void drain().then(() => { this.retirements.delete(id); resolve() }, (error: unknown) => {
      this.retirements.delete(id)
      reject(error)
    })
    return promise
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      // Electron applies this to the inert load before did-attach, when getURL is still empty.
      params.useragent = `${GUEST_LEASE_USER_AGENT}${id}`
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      const marker = guest.getUserAgent()
      const id = (marker.startsWith(GUEST_LEASE_USER_AGENT) ? marker.slice(GUEST_LEASE_USER_AGENT.length) : '') as DesktopBrowserLeaseId
      const lease = this.leases.get(id)
      if (lease === undefined || lease.owner !== owner || !lease.attached || lease.guest !== undefined
        || guest.session !== session.fromPartition(lease.partition)) {
        guest.close({ waitForBeforeUnload: false })
        return
      }
      lease.guest = guest
      const current = (): boolean => this.leases.get(id) === lease && lease.guest === guest && !guest.isDestroyed()
      const fail = (reason: Error): void => {
        if (this.leases.get(id) !== lease) return
        void this.releaseLease(id, lease, reason).catch((error: unknown) => { console.error(error) })
      }
      let bootstrapReady = false
      const publish = (): void => {
        if (!current() || !bootstrapReady || lease.releaseInput === undefined) return
        lease.ready = true
        const wait = lease.attachmentWait
        delete lease.attachmentWait
        if (wait !== undefined) { clearTimeout(wait.timer); wait.resolve() }
      }
      guest.once('destroyed', () => { fail(new Error('desktop browser: guest destroyed')) })
      guest.once('render-process-gone', () => { fail(new Error('desktop browser: guest renderer exited')) })
      guest.once('dom-ready', () => {
        if (!current()) return
        if (guest.getURL() !== `about:blank#${id}`) {
          fail(new Error('desktop browser: invalid guest bootstrap document'))
          return
        }
        bootstrapReady = true
        publish()
      })
      try {
        // The lease marker must not reach the first remote document or native input callback.
        guest.setUserAgent(guest.session.getUserAgent())
        guest.setWindowOpenHandler(({ url, postBody }) => {
          if (current() && lease.ready && !owner.isDestroyed() && postBody === undefined && this.allowedNavigation(url)) {
            const request: DesktopBrowserOpenRequest = { lease: id, url: new URL(url).href }
            owner.send(DESKTOP_IPC.browserOpenRequested, request)
          }
          return { action: 'deny' }
        })
        guest.on('will-frame-navigate', (event) => {
          if (event.isMainFrame && (!lease.ready || !this.allowedNavigation(event.url))) event.preventDefault()
        })
        guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
          if (mainFrame && (!lease.ready || !this.allowedNavigation(url))) event.preventDefault()
        })
        guest.on('will-attach-webview', (event) => { event.preventDefault() })
        guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
        // A reentrant release must drain the disposer returned by this synchronous setup.
        const inputSetup = Promise.withResolvers<void>()
        lease.inputSetup = inputSetup.promise
        try { lease.releaseInput = attachInput(guest, id) }
        finally { delete lease.inputSetup; inputSetup.resolve() }
        publish()
      } catch (error) {
        console.error('Desktop browser native attachment failed', error)
        fail(new Error('desktop browser: native attachment setup failed', { cause: error }))
      }
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
