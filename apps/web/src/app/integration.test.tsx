/**
 * The web client end to end, without a browser: a jsdom page, the real runtime (sql.js mirror,
 * sync client, HTTP transport) and the fake home server from @bullet/client. Pairs, captures with
 * the keyboard shortcut, syncs, and renders the Stream and the Inbox from the mirror.
 */

import { bullets, outbox, type PhoneDb, suggestions } from '@bullet/client'
import { FakeServer } from '@bullet/client/testing'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { App } from '../App'
import { createMemoryBlobStore } from '../data/persist'
import { createSettingsStore, type KeyValueStorage } from '../data/settings'
import { openMirror } from '../data/open'
import { loadSqlForTests } from '../test/sql'
import { createRuntime, type Runtime } from './runtime'

const URL_ = 'http://home.test:3001'
const TOKEN = 'bjd_made_up_token'

/** `fetch` that answers the sync API from the fake server (and checks the token). */
function fakeFetch(server: FakeServer, log: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    log.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return new Response('{"error":{"code":"unauthorized","message":"no"}}', { status: 401 })
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/sync/push')
      return json(await server.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')))
    if (url.pathname === '/sync/pull') {
      return json(
        await server.pull({
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 500),
        }),
      )
    }
    return new Response('{}', { status: 404 })
  }
}

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const countBullets = (db: PhoneDb) => db.select().from(bullets).all().length

const tick = () => act(async () => {})

async function until(check: () => void) {
  await act(async () => {
    await vi.waitFor(check, { timeout: 4000 })
  })
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the web client', () => {
  let container: HTMLDivElement
  let root: Root
  let rt: Runtime
  let server: FakeServer
  let requests: string[]
  const store = createMemoryBlobStore()

  const $ = (selector: string) => container.querySelector<HTMLElement>(selector)
  const text = () => container.textContent ?? ''
  const button = (name: RegExp | string) => {
    const found = Array.from(container.querySelectorAll('button')).find((b) =>
      typeof name === 'string'
        ? (b.getAttribute('aria-label') ?? b.textContent) === name
        : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
    )
    if (!found) throw new Error(`no button ${String(name)}`)
    return found
  }
  const click = (el: HTMLElement) => act(async () => el.click())
  const go = async (hash: string) => {
    await act(async () => {
      window.location.hash = hash
    })
    await until(() => expect(window.location.hash).toBe(hash))
    await tick()
  }

  beforeEach(async () => {
    window.location.hash = ''
    window.localStorage.clear()
    server = new FakeServer()
    requests = []
    rt = await createRuntime({
      sql: await loadSqlForTests(),
      store,
      settings: createSettingsStore(memoryStorage()),
      fetch: fakeFetch(server, requests),
      // A long debounce: anything stored before it fires was stored on purpose.
      persistDelayMs: 60_000,
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App runtime={rt} />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    rt.dispose()
    await store.clear()
  })

  async function pair(token = TOKEN) {
    expect(text()).toContain('Connect your home server')
    await act(async () => {
      setValue($('input[type="url"]') as HTMLInputElement, URL_)
      setValue($('input[type="password"]') as HTMLInputElement, token)
    })
    await click(button('Connect'))
  }

  test('pairs, captures with Ctrl+Enter, syncs, and shows the Stream and the Inbox', async () => {
    // Not paired: only the setup page, and no sync traffic.
    expect(text()).not.toContain('Journal')
    await pair('bjd_wrong_token')
    await until(() => expect(text()).toContain("didn't accept this token"))
    expect(rt.server()).toBeNull()

    await pair()
    await until(() => expect(text()).toContain('Journal'))
    expect(rt.server()).toEqual({ baseUrl: URL_, token: TOKEN })

    // The Capture page: a multi-line box. Plain Enter is a new line; Ctrl+Enter sends.
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'call the dentist on thursday\nand buy olive oil'))
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(server.bullets.size).toBe(0)
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(text()).toContain('Saved')
    expect((box as HTMLTextAreaElement).value).toBe('')

    // It reached the home server (idempotent op), with its text intact.
    await until(() => expect(server.bullets.size).toBe(1))
    const [id, bullet] = [...server.bullets.entries()][0] ?? ['', undefined]
    expect(bullet?.text).toBe('call the dentist on thursday\nand buy olive oil')
    expect(requests.filter((r) => r === 'POST /sync/push').length).toBeGreaterThan(0)

    // The server finishes reading it; the next sync pulls the new state into the mirror.
    server.process(id, 'processed')
    await act(async () => rt.sync.syncNow())
    await go('#/journal/stream')
    await until(() => expect(text()).toContain('call the dentist on thursday'))
    expect(text()).toContain('Today')

    // Something to decide, as the server would have proposed it.
    await act(async () => {
      rt.db()
        .insert(suggestions)
        .values({
          id: crypto.randomUUID(),
          source_bullet_id: id,
          target_kind: 'task',
          operation: 'create',
          payload: { title: 'Call the dentist' },
          confidence: 0.9,
          tier: 'suggest',
          status: 'pending',
          auto_applied: false,
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        .run()
      rt.notify()
    })
    await go('#/inbox')
    await until(() => expect(text()).toContain('To decide'))
    expect(text()).toContain('Call the dentist')
    expect($('a[aria-label^="Open inbox"]')?.textContent).toContain('1')

    // Accept: written at once, held for the Undo window; Undo puts it back.
    await click(button(/^Accept/))
    await until(() => expect(text()).toContain('Added'))
    await click(button(/^Undo/))
    await until(() => expect(text()).not.toContain('Added'))
    expect(button(/^Accept/)).toBeTruthy()

    // Dismiss, then Undo inside the window.
    await click(button(/^Dismiss/))
    await until(() => expect(text()).toContain('Dismissed'))
    await click(button(/^Undo/))
    await until(() => expect(button(/^Accept/)).toBeTruthy())
  })

  test('opens Capture detail in a panel, edits the text, and offers the three-choice delete', async () => {
    await pair()
    await until(() => expect(text()).toContain('Journal'))
    await act(async () => rt.run(() => undefined))
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'a made-up thought about a made-up place'))
    await click(button('Send'))
    await until(() => expect(server.bullets.size).toBe(1))
    await go('#/journal/stream')
    await until(() => expect(text()).toContain('a made-up thought'))

    await click($('.card-open') as HTMLElement)
    await until(() => expect($('aside.panel')).not.toBeNull())
    expect($('aside.panel')?.textContent).toContain('a made-up thought about a made-up place')
    expect(window.location.hash).toContain('panel=capture:')

    // Edit: the text changes locally and an edit op is queued for the server.
    await click(button('Edit text'))
    const editor = $('#capture-text-edit') as HTMLTextAreaElement
    await act(async () => setValue(editor, 'a different made-up thought'))
    await click(button('Save'))
    await until(() =>
      expect($('aside.panel')?.textContent).toContain('a different made-up thought'),
    )
    await until(() =>
      expect([...server.bullets.values()][0]?.text).toBe('a different made-up thought'),
    )

    // Delete asks first, with Cancel as the safe choice and the two ways to delete.
    await click(button('Delete capture…'))
    const dialog = $('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Delete this capture?')
    expect(dialog?.textContent).toContain('Delete + extractions')
    expect(dialog?.textContent).toContain('Delete but keep extractions')
    await click(button('Cancel'))
    expect($('[role="alertdialog"]')).toBeNull()

    // Escape closes the panel.
    await act(async () => {
      $('aside.panel')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await until(() => expect($('aside.panel')).toBeNull())
  })

  test('the local copy is saved, survives a reload, and is wiped by Unpair', async () => {
    await pair()
    await until(() => expect(text()).toContain('Journal'))
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'kept across a reload'))
    await click(button('Send'))
    await until(() => expect(server.bullets.size).toBe(1))
    await rt.flush()

    // A second page load over the same stored image sees the capture.
    const reloaded = await openMirror(await loadSqlForTests(), store)
    expect(countBullets(reloaded.db)).toBe(1)
    reloaded.close()

    // Unpair from Settings: confirms first, then the token and the copy are gone.
    await click(button(/Sync status/))
    await until(() => expect($('aside.panel')?.textContent).toContain('Home server'))
    await click(button('Unpair…'))
    expect($('[role="alertdialog"]')?.textContent).toContain('Unpair this browser?')
    await click(button('Unpair'))
    await until(() => expect(text()).toContain('Connect your home server'))
    expect(rt.server()).toBeNull()
    // Whatever is stored now (nothing, or a fresh empty image) has none of the old journal.
    await new Promise((r) => setTimeout(r, 50))
    const empty = await openMirror(await loadSqlForTests(), store)
    expect(countBullets(empty.db)).toBe(0)
    empty.close()
  })

  test('"Saved" means stored: an offline capture is in IndexedDB before the debounce, no flush needed', async () => {
    await pair()
    await until(() => expect(text()).toContain('Journal'))
    const { TransportError } = await import('@bullet/client')
    server.failNext = { count: 1000, error: new TransportError('network', 'down') }
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'written while the server is away'))
    await click(button('Send'))
    await until(() => expect(text()).toContain('Saved'))
    expect(window.localStorage.getItem('bullet.draft')).toBeNull()
    expect(server.bullets.size).toBe(0)

    // A reload right now (nothing flushed by hand) still has the capture and its outbox op.
    const reloaded = await openMirror(await loadSqlForTests(), store)
    expect(
      reloaded.db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.text),
    ).toEqual(['written while the server is away'])
    expect(reloaded.db.select().from(outbox).all().length).toBeGreaterThan(0)
    reloaded.close()
  })

  test('if the copy cannot be stored, no "Saved": the text and the draft stay, with a calm note', async () => {
    await pair()
    await until(() => expect(text()).toContain('Journal'))
    const saveSpy = vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'cannot be stored yet'))
    await click(button('Send'))
    await until(() => expect(text()).toContain("Couldn't save this in your browser yet"))
    expect(text()).not.toContain('Saved')
    expect((box as HTMLTextAreaElement).value).toBe('cannot be stored yet')
    expect(window.localStorage.getItem('bullet.draft')).toBe('cannot be stored yet')

    // Storage works again: sending the same text stores it (once) and then it is Saved.
    saveSpy.mockRestore()
    warn.mockRestore()
    await click(button('Send'))
    await until(() => expect(text()).toContain('Saved'))
    const mirror = await openMirror(await loadSqlForTests(), store)
    expect(mirror.db.select().from(bullets).all()).toHaveLength(1)
    mirror.close()
  })

  test('Reset local copy rebuilds the mirror from a full pull', async () => {
    await pair()
    await until(() => expect(text()).toContain('Journal'))
    const box = $('textarea.capture-input') as HTMLTextAreaElement
    await act(async () => setValue(box, 'rebuilt from the server'))
    await click(button('Send'))
    await until(() => expect(server.bullets.size).toBe(1))
    const [id] = [...server.bullets.keys()]
    server.process(id ?? '', 'processed')
    await act(async () => rt.sync.syncNow())

    await act(async () => rt.resetLocalCopy())
    await until(() => expect(countBullets(rt.db())).toBe(1))
    expect(rt.server()).toEqual({ baseUrl: URL_, token: TOKEN })
  })
})
