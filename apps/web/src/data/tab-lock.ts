/**
 * One tab owns the mirror. Two tabs saving their own copy of it would overwrite each other's
 * unsent captures, so the second tab is told to use the first one. Uses the Web Locks API; where
 * it is missing the tab simply proceeds.
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

/**
 * Take the mirror lock for as long as this page lives. Resolves `owner` when taken, `other-tab`
 * when another tab of this browser already holds it.
 */
export function acquireMirrorLock(
  locks: LockManagerLike | undefined = globalThis.navigator?.locks as LockManagerLike | undefined,
  name = 'bullet-mirror',
): Promise<TabLock> {
  if (!locks) return Promise.resolve('owner')
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
