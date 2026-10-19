/**
 * Boot: take the mirror lock (one tab owns the local copy), load sql.js, open the local copy and
 * start the sync triggers; then show the app. The three early outcomes are calm one-liners.
 */

import { useEffect, useState } from 'react'
import { App } from './App'
import { createRuntime, type Runtime } from './app/runtime'
import { startTriggers } from './app/triggers'
import { createIdbBlobStore } from './data/persist'
import { browserStorage, createSettingsStore } from './data/settings'
import { loadSqlJs } from './data/sqljs'
import { acquireMirrorLock } from './data/tab-lock'
import { Button } from './ui/primitives'

// The lock is taken once per page, even when React runs the effect twice in development.
let lock: ReturnType<typeof acquireMirrorLock> | null = null

type State =
  | { kind: 'loading' }
  | { kind: 'other-tab' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; runtime: Runtime }

export function Boot() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let stop: (() => void) | null = null
    let runtime: Runtime | null = null
    let cancelled = false
    void (async () => {
      try {
        lock ??= acquireMirrorLock()
        if ((await lock) === 'other-tab') {
          if (!cancelled) setState({ kind: 'other-tab' })
          return
        }
        const sql = await loadSqlJs()
        if (cancelled) return
        runtime = await createRuntime({
          sql,
          store: createIdbBlobStore(),
          settings: createSettingsStore(browserStorage()),
          visible: () => document.visibilityState === 'visible',
        })
        if (cancelled) {
          runtime.dispose()
          return
        }
        stop = startTriggers(runtime)
        setState({ kind: 'ready', runtime })
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
      stop?.()
      runtime?.dispose()
    }
  }, [attempt])

  switch (state.kind) {
    case 'ready':
      return <App runtime={state.runtime} />
    case 'other-tab':
      return (
        <main className="boot" id="main">
          <h1>Bullet is open in another tab</h1>
          <p className="secondary">
            Your journal's local copy can only be open in one tab at a time. Use the other tab, or
            close it and reload this one.
          </p>
        </main>
      )
    case 'failed':
      return (
        <main className="boot" id="main">
          <h1>Bullet couldn't start</h1>
          <p className="secondary">
            This browser couldn't open its local copy ({state.message}). Your journal on the home
            server is safe, and nothing stored here was changed. Private windows sometimes block
            this: try a normal window.
          </p>
          <div>
            <Button
              variant="primary"
              onClick={() => {
                setState({ kind: 'loading' })
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        </main>
      )
    default:
      return (
        <main className="boot" id="main">
          <p className="secondary" role="status">
            Opening your journal…
          </p>
        </main>
      )
  }
}
