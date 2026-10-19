import { describe, expect, test, vi } from 'vite-plus/test'
import { startTriggers } from './triggers'

/** A page stand-in: two event targets and a visibility state. */
function fakePage() {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  })
  return { win, doc, page: { window: win, document: doc } as never }
}

function fakeRuntime() {
  const calls = { sync: 0, flush: 0, notify: 0, undo: 0, foreground: [] as boolean[], dirty: false }
  const rt = {
    sync: {
      syncNow: () => {
        calls.sync += 1
        return Promise.resolve()
      },
      setForeground: (v: boolean) => calls.foreground.push(v),
    },
    flush: () => {
      calls.flush += 1
      return Promise.resolve()
    },
    notify: () => {
      calls.notify += 1
    },
    dirty: () => calls.dirty,
    inbox: {
      flushDecisions: () => {
        calls.undo += 1
      },
    },
  }
  return { rt: rt as never, calls }
}

describe('sync triggers', () => {
  test('syncs on load', () => {
    const { rt, calls } = fakeRuntime()
    const { page } = fakePage()
    startTriggers(rt, page)
    expect(calls.sync).toBe(1)
  })

  test('syncs when the window gets focus and when the network comes back', () => {
    const { rt, calls } = fakeRuntime()
    const { win, page } = fakePage()
    startTriggers(rt, page)
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new Event('online'))
    expect(calls.sync).toBe(3)
  })

  test('visible again: the gentle schedule resumes and a sync runs; hidden: it stops and the copy is saved', () => {
    const { rt, calls } = fakeRuntime()
    const { doc, page } = fakePage()
    startTriggers(rt, page)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(calls.foreground).toEqual([false])
    expect(calls.flush).toBe(1)
    expect(calls.sync).toBe(1)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(calls.foreground).toEqual([false, true])
    expect(calls.sync).toBe(2)
  })

  test('hiding the tab closes the Undo windows, like the phone going to the background', () => {
    const { rt, calls } = fakeRuntime()
    const { doc, page } = fakePage()
    startTriggers(rt, page)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(calls.undo).toBe(1)
  })

  test('closing the tab asks first only while something is unsaved', () => {
    const { rt, calls } = fakeRuntime()
    const { win, page } = fakePage()
    startTriggers(rt, page)
    const clean = new Event('beforeunload', { cancelable: true })
    win.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    calls.dirty = true
    const unsaved = new Event('beforeunload', { cancelable: true })
    win.dispatchEvent(unsaved)
    expect(unsaved.defaultPrevented).toBe(true)
  })

  test('closing the tab saves the local copy; going offline refreshes the status', () => {
    const { rt, calls } = fakeRuntime()
    const { win, page } = fakePage()
    startTriggers(rt, page)
    win.dispatchEvent(new Event('pagehide'))
    win.dispatchEvent(new Event('offline'))
    expect(calls.flush).toBe(1)
    expect(calls.notify).toBe(1)
  })

  test('stopping removes every listener', () => {
    const { rt, calls } = fakeRuntime()
    const { win, doc, page } = fakePage()
    const stop = startTriggers(rt, page)
    stop()
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new Event('online'))
    win.dispatchEvent(new Event('pagehide'))
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(calls.sync).toBe(1)
    expect(calls.flush).toBe(0)
    void vi
  })
})
