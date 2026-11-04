---
description: "Right-Sidebar browser tabs for sandboxed HTTP(S) pages, including loopback services."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

English | [中文](README.zh.md)

## Summary

Browse HTTP(S) pages, including loopback services, inside independent right-Sidebar tabs. Web uses an iframe with application-managed history; Desktop uses Electron `<webview>` with native navigation history and retained pages. The package never injects Electron or Node access into visited content.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Browser is disabled by default in Web profiles and enabled on Desktop. Enable the shipped entry through the Web profile patch to use it. Open **Browser** from the right-Sidebar guide and enter an HTTP(S) URL. Chat HTTP(S) links open here when the [link preference](../ui-chat/README.md) selects **In-App Sidebar**. A host name without a scheme becomes HTTPS. Public and loopback targets use the same default sandbox. Each guide action or delegated message-link activation creates another Browser tab.

### When to choose it

Choose Browser for a Web page that should remain beside the current Session. Choose [Document Preview](../ui-sidebar-documentpreview/README.md) for local files, and use the explicit external-browser action when a site refuses iframe embedding or needs browser capabilities this package withholds.

### Minimal configuration

The package has no plugin configuration. A Web profile enables the shipped entry through its profile patch:

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`. The optional URL passes the same validation as address-bar input before navigation.

The `browser.new` command opens a separate Browser page in the focused dock pane, replacing a guide and retaining existing content pages. From the conversation or a floating content page, it uses the active dock pane. Desktop defaults to Cmd+T on macOS and Ctrl+T on Windows; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves the command unbound. The guide button uses a blue globe and displays the effective shortcut inline without a duplicate tooltip.

The toolbar provides Back, Forward, Reload, Go, and Open in system browser. Web also offers a per-tab sandbox toggle; disabling it is temporary and displays an amber warning with neutral text. Desktop shows the observed page title. After a restart, Browser shows the saved title and URL; Restore or Reload opens that address only when requested.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Protocol policy

The address parser accepts HTTP and HTTPS, including loopback targets. It rejects `file:` URLs, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering.

### Iframe carrier

Web uses `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` by default. The frame has no direct download or top-navigation flag. Popups leave the sandbox; in Web, an escaped popup retains its opener and can navigate the top-level application. The visited origin can use its own cookies and Web storage but a cross-origin target cannot read DSH DOM, storage, or API responses. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. The toolbar can remove the sandbox for the current tab occurrence; the choice is not persisted. An unsandboxed page can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. The package does not proxy or probe remote pages.

Web records toolbar submissions and typed tab opens. A navigation state machine treats the first iframe load for each controlled revision as known and a later load as proof that the page changed to an unreadable URL. In that unknown state the address is marked, Back, Forward, and external-open are disabled, and Reload returns to the last controlled URL. A remounted body reloads the latest application-known URL and uses its optional initial URL only before the first controlled target. History API and fragment changes that emit no iframe load remain invisible. An iframe `error` event displays a transient load-failure notice until the next controlled load without changing URL history.

### Controller

Each tab's `BrowserController` owns address validation, commands and explicit restoration. The page factory receives the exact tab id and occurrence signal for correlation, not authority; physical remount reuses the page. `BrowserFrame` supplies carrier-neutral navigation state; `IframeImpl` uses `BrowserNavigation`, while `ElectronWebViewImpl` observes Chromium history. `BrowserPresentation` owns physical DOM attachment. Slot injection supplies `useBrowserState` and plain callbacks, keeping provider objects and observables out of the React body.

Desktop's main process approves guest leases and enforces attachment, navigation and permission policy. Preload exposes only scoped Browser operations. Shared declarations use the standard `/types` export with `import type`; the Host and Client compile through separate tsconfig files. Desktop Browser tabs declare `keepMounted`, so Sidebar preserves their DOM across tab changes, Session switches, collapse and floating.

On a bridge advertising `nativeAttachment` version 1, initial navigation waits for both renderer `dom-ready` and Main's confirmation of the exact one-shot lease, installed input routing, and inert bootstrap document. Main binds the physical guest before that document is ready, so early release can destroy it. The attachment wait is lease-owned and expires after 30 seconds; release, crash, or owner retirement rejects it. Physical removal cancels the Client wait immediately; disposal awaits lease release. Late answers cannot activate a replacement guest. Legacy manual bridges retain renderer-only readiness. Attachment confirmation grants neither Agent authorization nor control ownership; see the [native attachment decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md#native-attachment-readiness).

The `/types` declarations also describe private Host–Main task messages. They carry correlation metadata, not browser authority, and add no preload method, Tool or Client automation entry. Host scope admission additionally requires the exact Agent's current, non-retired activity. Its registry closes all of that activity's tasks before awaiting cleanup, including late acquisition and in-flight work; an empty activity can also be retired without permanently retiring the Agent. These components are not connected to the production task provider or Core drain event; without a Main handler, task preparation fails instead of using a manual lease. See the [task IPC decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md#task-ipc-authority).

The page refresh shortcut calls the same reload operation as the toolbar. Its tooltip and ARIA key combination follow the effective binding. Desktop routes accepted shortcuts from an approved guest through its owning window; the focused webview must still carry that guest’s lease. Web leaves browser-reserved combinations unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [Document Preview](../ui-sidebar-documentpreview/README.md) — local source, Markdown, images, HTML, and PDF rendering.
- [Sidebar Browser decision](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md) — iframe behavior and controller ownership.
- [Desktop Browser decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md) — webview leases, Session storage grouping and manual restoration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Browser tabs are user-facing presentation state and register no tool, prompt section, or Session event.

#### KV Cache effect

None; browsing does not enter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The isolation policy deliberately gives up some browser compatibility:

- Many sites refuse iframe embedding or need downloads or top-level navigation withheld from the frame by the default sandbox. An HTTPS application can also block public HTTP pages as mixed content. Disabling the sandbox trades its restrictions for compatibility but does not bypass mixed-content or private-network policy. The unsandboxed frame can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. It does not isolate the visited origin's cookies per Browser tab or prevent an in-frame page from choosing its own next URL.
- In Web, a popup that escapes the sandbox retains its opener and can use that chain to navigate the top-level application. Desktop handles popup creation separately.
- A later iframe load reveals that navigation occurred but not the new cross-origin URL. History API and fragment changes may remain invisible; Web Back and Forward are unavailable after the state becomes unknown.
- Browsers conceal many iframe failures for security: DNS, TLS, mixed-content, CSP, and `X-Frame-Options` failures may emit `load` or no actionable event instead of `error`. The load-failure notice is best-effort.
- Saved title and URL survive reloads and plugin unload while the tab remains in Sidebar's layout. Closing the tab removes its checkpoint. Restart restoration does not recover page memory, unsaved forms or Chromium's history stack.
- Local files are rejected and remain owned by Document Preview.
- Desktop shares process-local storage partitions between tabs in one DSH Session; different Sessions are isolated even when they use the same Workspace or CWD. Storage selection does not wait for Workspace readiness and grants no task authorization, automation or handoff capability. Mounted guests keep their partition; after upgrading, restart Desktop to establish fresh assignments. Cookies and Web storage do not survive application restart. Guest permissions, downloads and native popups are denied; approved HTTP(S) popup requests open Sidebar tabs. Host-address filtering is not a general private-network or DNS-rebinding firewall.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

After `pnpm run build:artifacts`, run `pnpm run test:desktop:browser` from the repository root to qualify storage and exact native attachment against the current production artifacts. The fixtures use private Electron profiles and owned loopback pages; they do not launch the installed app or establish task authorization, full input handling or original-tree integration.

Run `node apps/desktop/scripts/test-browser-protocol.mjs` separately for protocol qualification. It compares a synthetic input gate, `Input.setIgnoreInputEvents`, and the current emitted production shortcut handler with a controlled overlay callback. On an owned hidden guest, the three tested CDP key variants deliver complete trusted key pairs when the real handler is unblocked, without native window or guest focus. A blocked overlay still allows partial key delivery and CDP mouse input; it is not an Agent input-authority barrier. Ignore-input blocks both tested CDP and ordinary injected input rather than selecting one source. None of these observations qualifies arbitrary keys, IME, physical OS input, or human-takeover drainage.

</details>
