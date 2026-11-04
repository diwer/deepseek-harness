# Agent Note: Retained Desktop browser webviews

Status: implemented

English | [中文](2026-09-20-desktop-browser-webview.zh.md)

The storage ownership decision is partially superseded by [Session-scoped browser storage](2026-11-04-browser-session-storage.md). The Workspace/CWD storage rationale below records the original decision; carrier, guest security and lifecycle decisions remain active.

## Problem

An iframe cannot expose cross-origin navigation or render sites that refuse embedding. An Electron guest loses forms, scroll position and native history if its tab body unmounts on selection or container changes. Page lifetime must therefore remain independent of visibility and layout changes.

Independent per-tab storage also prevents related pages in one Workspace from sharing site login state. Page lifetime and storage ownership need different owners.

## Decision

Desktop uses `<webview>` through `ElectronWebViewImpl`; Web retains its opt-in iframe carrier. The [Sidebar Browser decision](2026-09-16-sidebar-browser.md) owns shared tab behavior and iframe limitations; this note owns the Desktop carrier and Workspace-keyed partitions.

The [stable Sidebar mounting decision](../architecture/2026-09-20-sidebar-retained-tab-layout.md) owns retained Session and tab containers in real CSS layout. Workspace storage ownership and baseline guest security remain with this note.

- `BrowserController` owns address commands and recoverable presentation state. Native history stays in the guest; actual URL and title observations update the persisted address.
- Controller registries are keyed by DSH Session, independently of presentation bindings. Rebinding replaces the store writer without recreating the page.
- `electron/pages.ts` composes the Electron navigation provider and presentation object. `ElectronWebViewImpl` owns guest leases and native navigation; `ElectronWebviewPresentation` creates the tag and attaches it inside the Sidebar-owned content container.
- The Desktop Browser type declares `keepMounted`. Sidebar retains its DOM ancestors across hiding and docking; CSS owns layout and clipping. Docking gestures disable guest pointer input, and body-local drop hints use normal stacking. A physical unmount cancels pending attachment and releases the guest; a later mount recreates it from the known address.
- Tab occurrence cancellation, plugin unload and window destruction release guests. Guest crashes leave a retryable failure; Reload creates a new guest. Application restart offers the saved title and URL for explicit restoration; it creates no guest until the user restores or submits an address. Page memory and native history are not restored.

The standard `./types` subpath exports the shared lease, reservation, open-request and bridge declarations through a declaration-only `types` condition; Desktop consumers use `import type`. There is no runtime default, extra JavaScript artifact or early Host bundling for these declarations. Preload exposes scoped operations and callbacks, not raw IPC or Electron objects.

Browser has separate Host and Client compiler programs. Desktop and the Host aggregate reference only `tsconfig.host.json`, which compiles the package root and shared bridge declarations; the Client aggregate references `tsconfig.client.json` for the browser implementation. The package root tsconfig is solution-only. This keeps Client consumers of generated `/remote` declarations out of the Host compilation that precedes Typert generation.

### Storage ownership

`DesktopBrowserGuests` assigns a random, non-persistent Electron partition to each canonical CWD account. The Client uses the Host-normalized `WorkspaceView.path`, not the Workspace record UUID, so recreating a Workspace at the same directory does not change its storage account key. Browser tabs whose DSH Sessions resolve to that CWD share the account; Sessions without a resolved Workspace remain separately isolated. Workspace membership is resolved after the Client receives its authoritative baseline and is fixed for a guest occurrence. The CWD key controls sharing, not disk persistence.

Closing a tab releases its guest, not its account's cookies or storage. Cookies, localStorage, IndexedDB, Service Workers and cache remain partition-owned and subject to normal origin rules. DOM, native history and sessionStorage remain page-owned. Account partitions survive window recreation within the Electron process but do not persist across application exit.

### Initial guest policy

Only the primary application window enables `webviewTag`. The main process accepts guest reservations only from that window's application top frame and validates a one-use lease, partition and inert initial `about:blank` document before allowing the guest. The main process replaces renderer-supplied preferences: no Node integration, guest preload, nested webviews, plugins, insecure content, dialogs or drag navigation; sandbox, context isolation and Web security stay enabled.

Guest Sessions do not register the application protocol or inherit the application's authenticated request forwarding. Permission requests and checks, device access, display capture, downloads, native popup windows and HTTP authentication prompts are denied. Approved direct HTTP(S) popup requests without a POST body are routed through their live lease to a new Sidebar tab; scripted blank-window and POST popup flows remain unsupported. Navigation accepts credential-free HTTP(S); request filtering rejects local-file and privileged schemes and the known DSH Host endpoint, including common loopback aliases. This is not a general private-network or DNS-rebinding firewall.

The Desktop toolbar has no sandbox-disable switch. The implementation adds no remote-debugging endpoint or browser-use integration. A future automation provider requires an authenticated, target-scoped broker rather than access to every application target. The separation of a target/lifetime handle from navigation commands follows the same distinction as Playwright's Android WebView and Page objects; device-level input is a separate responsibility.

### Native attachment readiness

The optional Desktop bridge capability `nativeAttachment` version 1 waits for Main to associate the exact owner, lease and guest, install native input, and validate that guest's first inert `about:blank#lease` document. Each pending lease shares one bounded 30-second wait; stale or foreign leases reject. Renderer `dom-ready`, successful presentation and page metadata are not Main proof. `ElectronWebViewImpl` requires both the native capability and its current renderer's `dom-ready` before loading the pending address; legacy manual bridges without the capability retain renderer-only behavior.

Main forces a lease-specific bootstrap User-Agent in `will-attach-webview` and recovers it through `guest.getUserAgent()` in `did-attach-webview`, before the first document is ready. It cross-checks the actual Electron Session against the reserved partition, then immediately restores that Session's default User-Agent before native input callbacks or readiness publication. The marker belongs only to the inert bootstrap, not subsequent website requests. Native qualification must verify exact recovery and restoration after Electron upgrades: Electron 44 does not expose `additionalArguments` or `partition` through `getLastWebPreferences()`, and neither the initial URL nor frame name identifies a guest at this early event. Shared-partition identity or reservation order is never a substitute for exact lease identity.

Release, timeout, guest crash and owner navigation revoke pending readiness. Retirement reserves its owner-scoped join before cleanup callbacks, so concurrent or reentrant release waits for the same native input disposal and actual guest destruction. If release reenters input installation, the drain waits for its returned disposer; disposal errors reject the shared result only after guest destruction. Removing the active lease does not imply destruction has completed. The Client cancels its local wait immediately on physical removal and awaits owned releases during disposal; late native answers cannot activate another physical guest. These readiness mechanisms grant no task authority and add no automation endpoint.

### Task IPC authority

Private task scope admission compares the exact live execution Agent against the Host registry and derives its Session internally. It also requires that exact Agent's current, non-aborted activity. Each admission creates a distinct Host-local capability and storage identity, including admissions in the same Session. Serialized run, provider, Agent and task epochs only correlate messages; possessing these strings grants no authority. The existing Browser `/types` export carries declarations without another runtime package or cross-application source dependency. The registry reserves activity retirement before reentrant callbacks, closes every matching task before awaiting any cleanup, and joins late acquisition, admitted work and retained cleanup failures. Retirement also closes admission for an activity that never created a task. Ordinary idle must reclaim the activity's tasks, not the Agent: the same Agent can start another activity. Permanent Agent retirement is reserved for actual destruction and cannot substitute for per-activity drainage. Registering this registry with the Core drain event remains production-composition work.

The reverse channel reserves request and retirement state before sends or callbacks. A positive, strictly increasing request ID and exact epoch tuple bind every reply. Cancelling any request retires its whole task; a separate cancellation acknowledgement follows native retirement and all admitted work, including late results. An ordinary result or error cannot substitute for this acknowledgement. A deadline that expires during IPC retires the task without native execution rather than treating scheduling delay as Host corruption. Successful and failed callbacks both wait for revoked-resource cleanup; operation and cleanup failures remain independently observable.

Main separates native drain from transport close. Graceful shutdown first closes native admission, while retaining cancellation IPC until the Host acknowledges teardown and exits. Actual IPC loss closes the channel and invalidates platform credentials immediately. A bounded exit-diagnostic grace preserves normal child stderr; a disconnected child that remains alive is reported and terminated independently of native drain. Joined close waits for outstanding deliveries even after disconnection and retains every distinct native or delivery failure instead of mistaking removal from a pending set for successful cleanup. A fatal server failure that closes cancellation replies also severs the actual child IPC and requests termination; otherwise the still-connected Host could wait forever for an acknowledgement that can no longer arrive. Termination joins actual process exit, IPC disconnect and both stdio closes; aggregate `ChildProcess.close` alone can be missing after local IPC disconnect.

These private components have deterministic scope/channel tests, real channel-to-server cancellation tests and Node-child shutdown/disconnect tests. No production native handler or model-facing Tool consumes them. Original Sidebar preparation, task-owned native storage, universal pre-idle drain and human handoff remain unconnected; the existing manual Browser path is unchanged. The identity registry alone is not evidence of end-to-end task isolation.

## Alternatives considered

**Render the guest in a visibility-mounted tab body.** Unmounting disconnects the guest. Direct mounting requires the Sidebar's retained body and stable ancestor mechanism.

**Move the guest between visible and hidden DOM containers.** Electron 44's `WebViewElement.disconnectedCallback` detaches the guest and resets its internal instance. Retaining the element reference or React key does not preserve that instance; the parent stays fixed instead.

**Use one partition per tab.** This isolates site accounts between related pages. Workspace ownership provides the requested sharing without sharing the application Session; a tab still owns its own guest.

**Change the partition of an active webview.** Electron fixes the partition before first navigation. Selecting another isolation scope requires a replacement guest and an explicit policy for existing site data, not a live attribute toggle.

## Consequences

Sidebar-owned stable ancestors preserve the page without Browser-owned geometry or occlusion handling. Hidden guests retain page memory and may continue network activity; there is no idle eviction policy. Persistent storage, selectable isolation scopes and permission-grant UI remain separate work. Temporary Workspace partitions are the current policy, not a promise that Workspace isolation always implies temporary storage.

Focused tests cover navigation recovery, preload listener scoping and migrated iframe behavior. Private Electron 44.7.0 fixtures verify current emitted production guest-manager attachment: reverse-order same-partition identity, the inert-document/input-installation boundary, default User-Agent restoration, foreign-owner rejection and joined physical release. A separate fixture verifies cookies and localStorage isolation and restart behavior. These fixtures do not mount the original Loader tree or establish overlap, foreground/background focus, platform styling or complete task authorization; those remain integration gaps. No GUI recording accompanies the change. This is not evidence that the complete browser security policy is ready for release.

Protocol qualification distinguishes the fixture's synthetic blanket input gate from the real emitted `installDesktopShortcuts().attachGuest` handler. With the synthetic gate open, an owned hidden guest and a controlled unblocked overlay callback, all three tested CDP key variants deliver trusted keydown/keyup without native focus; only the variants supplying text insert it. Blocking the real overlay does not completely stop CDP: some keydown/text delivery survives, key pairs are incomplete, and mouse input still passes. `Input.setIgnoreInputEvents` blocks both CDP and ordinary injected input, so it cannot provide selective source admission. Neither mechanism establishes task authority. Main must separately close authenticated task-command admission and join admitted work before acknowledging human takeover; that composition remains pending. The experiment uses renderer focus emulation, not OS focus or physical input, and does not exercise real overlay UI, configured shortcuts, chords or IME.

The package's Electron provider, presentation, page factory and Workspace storage resolver live in `src/client/electron/`. That directory is temporarily excluded from per-file coverage until a native Electron harness covers guest behavior; its unit tests still run. Shared Browser controllers, restoration UI, iframe code and Sidebar retention remain subject to the existing coverage requirements.
