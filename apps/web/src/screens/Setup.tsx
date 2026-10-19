/** Home server address + device token, checked with one small pull, then kept in this browser. */

import {
  CHECK_MESSAGES,
  checkConnection,
  type ConnectionCheck,
  createHttpTransport,
  normalizeServerUrl,
  normalizeToken,
} from '@bullet/client'
import { useState } from 'react'
import { useRuntime } from '../app/hooks'
import { Button } from '../ui/primitives'

/** The server this page came from is the usual answer: prefill it. */
export function defaultServerUrl(location: Pick<Location, 'protocol' | 'origin'>): string {
  return location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : ''
}

export function Setup() {
  const rt = useRuntime()
  const [url, setUrl] = useState(() => defaultServerUrl(window.location))
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ConnectionCheck | null>(null)

  const parsed = () => {
    const u = normalizeServerUrl(url)
    if (!u.ok) return { error: u.error }
    const k = normalizeToken(token)
    if (!k.ok) return { error: k.error }
    return { settings: { baseUrl: u.url, token: k.token } }
  }

  async function connect() {
    const p = parsed()
    setResult(null)
    if (!p.settings) {
      setError(p.error ?? null)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const check = await checkConnection(
        createHttpTransport({
          ...p.settings,
          timeoutMs: 10_000,
          fetch: rt.fetch,
        }),
      )
      setResult(check)
      if (check === 'ok') rt.pair(p.settings)
    } finally {
      setBusy(false)
    }
  }

  const message = error ?? (result && result !== 'ok' ? CHECK_MESSAGES[result] : null)
  return (
    <main className="setup" id="main">
      <h1>Connect your home server</h1>
      <p className="secondary">
        Your journal stays in this browser and on your own home server. Nothing is sent anywhere
        else.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void connect()
        }}
      >
        <label className="field">
          <span className="field-label">Home server address</span>
          <input
            type="url"
            value={url}
            placeholder="my-mac.tailnet.ts.net"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value)
              setResult(null)
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">Device token</span>
          <input
            type="password"
            value={token}
            placeholder="Paste it here"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              setToken(e.target.value)
              setResult(null)
            }}
          />
          <span className="caption">
            On the server, run <code>pnpm --filter server device:add my-browser</code> and paste the
            token it prints. This browser needs its own token.
          </span>
        </label>
        {message ? (
          <p className="warn" role="alert">
            {message}
          </p>
        ) : null}
        <div className="row">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Connect'}
          </Button>
          {result === 'unreachable' ? (
            <Button
              onClick={() => {
                const p = parsed()
                if (p.settings) rt.pair(p.settings)
              }}
            >
              Save anyway
            </Button>
          ) : null}
        </div>
      </form>
    </main>
  )
}
