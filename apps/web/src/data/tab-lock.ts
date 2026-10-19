/**
 * One tab owns the mirror. Two tabs saving their own copy of it would overwrite each other's
 * unsent captures, so the second tab is told to use the first one. Uses the Web Locks API; that
 * only exists in secure contexts (https, localhost), so on plain http a BroadcastChannel ping
 * stands in: a new tab asks "anyone own the mirror?" and the owner answers. (Two tabs opened in the
 * same instant can both win; the lock is the strict one.) Where neither exists the tab proceeds.
 */

/** The part of `navigator.locks` this needs. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>
}

export type TabLock = 'owner' | 'other-tab'

/** The part of `BroadcastChannel` this needs. */
export interface ChannelLike {
  postMessage: (message: unknown) => void
  onmessage: ((event: { data: unknown }) => void) | null
  close: () => void
}

const browserChannel = (name: string): ChannelLike | null =>
  typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(name) as ChannelLike)

/** Ask other tabs if one owns the mirror; take it when nobody answers in time. */
function askOtherTabs(channel: ChannelLike, waitMs: number): Promise<TabLock> {
  return new Promise<TabLock>((resolve) => {
    let owner = false
    let timer: ReturnType<typeof setTimeout> | null = null
    channel.onmessage = (event) => {
      if (event.data === 'ping' && owner) channel.postMessage('owner')
      else if (event.data === 'owner' && !owner) {
        if (timer) clearTimeout(timer)
        resolve('other-tab')
      }
    }
    channel.postMessage('ping')
    timer = setTimeout(() => {
      owner = true
      resolve('owner')
    }, waitMs)
  })
}

/**
 * Take the mirror lock for as long as this page lives. Resolves `owner` when taken, `other-tab`
 * when another tab of this browser already holds it.
 */
export function acquireMirrorLock(
  locks: LockManagerLike | undefined = globalThis.navigator?.locks as LockManagerLike | undefined,
  name = 'bullet-mirror',
  channel: (name: string) => ChannelLike | null = browserChannel,
  waitMs = 250,
): Promise<TabLock> {
  if (!locks) {
    const ch = channel(name)
    return ch ? askOtherTabs(ch, waitMs) : Promise.resolve('owner')
  }
  return new Promise<TabLock>((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve('other-tab')
          return Promise.resolve()
        }
        resolve('owner')
        // Hold it until the page goes away.
        return new Promise<void>(() => {})
      })
      .catch(() => resolve('owner'))
  })
}
