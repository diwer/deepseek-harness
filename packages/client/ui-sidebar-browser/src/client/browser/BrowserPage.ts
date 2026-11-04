/** Composition of one navigation provider and its presentation. */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import type { BrowserFrame } from './BrowserFrame.ts'
import type { BrowserTabState } from './BrowserPersistence.ts'

/** Provider construction inputs; persistence does not enter the live navigation interface. */
export interface BrowserPageOptions {
  /** Exact tab occurrence correlation; neither the id nor signal grants task authority. */
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly initial: BrowserTabState | undefined
  readonly persist: (state: BrowserTabState) => void
  readonly openRequested: (url: string) => void
}

/** The owning controller disposes frame; UI mounts only presentation. */
export interface BrowserPage {
  readonly frame: BrowserFrame
  readonly presentation: BrowserPresentation
}

/** Construct an idle provider without attaching DOM; saved navigation waits for an explicit frame command. */
export type BrowserPageFactory = (options: BrowserPageOptions) => BrowserPage
