/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Host-derived task identity on the private Desktop process channel; identifiers are not caller authority. */
export interface DesktopBrowserTaskScope {
  readonly runEpoch: string
  readonly providerEpoch: string
  readonly agentEpoch: string
  readonly taskId: string
  readonly taskEpoch: string
  readonly sessionId: string
}

/** Allowlisted task operations; Main reserves the guest before asking the original Sidebar tree to prepare it. */
export type DesktopBrowserTaskCommand = { readonly action: 'prepare' }
  | { readonly action: 'navigate'; readonly lease: DesktopBrowserLeaseId; readonly url: string }
  | { readonly action: 'screenshot'; readonly lease: DesktopBrowserLeaseId }
  | { readonly action: 'release'; readonly lease: DesktopBrowserLeaseId }

/** Command result; preparing alone grants neither native input authority nor renderer-chosen guest ownership. */
export type DesktopBrowserTaskResult = { readonly action: 'prepared'; readonly lease: DesktopBrowserLeaseId }
  | { readonly action: 'navigated'; readonly url: string }
  | { readonly action: 'screenshot'; readonly png: string }
  | { readonly action: 'released' }

/** Host-to-Main request identity is separate from Main-to-Host shell control request ids. */
export interface DesktopBrowserTaskRequest {
  readonly type: 'browser-task/request'
  readonly direction: 'host-to-main'
  readonly requestId: number
  readonly scope: DesktopBrowserTaskScope
  readonly deadlineAt: number
  readonly command: DesktopBrowserTaskCommand
}

/** Cancelling any request retires its whole task; acknowledgement means all admitted work and resources drained. */
export interface DesktopBrowserTaskCancel {
  readonly type: 'browser-task/cancel'
  readonly direction: 'host-to-main'
  readonly requestId: number
  readonly scope: DesktopBrowserTaskScope
}

/** Main replies once; cancellation failures never claim quiescence. */
export interface DesktopBrowserTaskReply {
  readonly type: 'browser-task/reply'
  readonly direction: 'main-to-host'
  readonly requestId: number
  readonly scope: DesktopBrowserTaskScope
  readonly outcome: { readonly kind: 'result'; readonly value: DesktopBrowserTaskResult }
    | { readonly kind: 'error'; readonly message: string }
}

/** Separate cancellation acknowledgement remains correlated even after a normal reply was sent. */
export interface DesktopBrowserTaskCancelled {
  readonly type: 'browser-task/cancelled'
  readonly direction: 'main-to-host'
  readonly requestId: number
  readonly scope: DesktopBrowserTaskScope
  readonly error?: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** Optional, versioned Main attachment proof; absent on legacy manual-only bridges. */
  readonly nativeAttachment?: {
    readonly protocolVersion: 1
    /**
     * Wait for this exact one-shot lease's Main association, input setup, and first inert document.
     * The wait is lease-owned and bounded; releasing the lease cancels it. This grants no input authority.
     * @param lease - the caller's reservation, never a tab id or storage identity.
     * @returns only after Main commits the current physical guest; released/foreign leases reject.
     */
    wait(lease: DesktopBrowserLeaseId): Promise<void>
  }
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
