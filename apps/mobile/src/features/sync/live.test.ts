import { describe, expect, test } from 'vite-plus/test'
import { createCoalescer } from './live'

function setup() {
  const clock = { now: 1_000 }
  const timers: { fn: () => void; at: number }[] = []
  let refreshes = 0
  const c = createCoalescer({
    delayMs: 100,
    coveredMs: 150,
    refresh: () => (refreshes += 1),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock.now + ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const advance = (ms: number) => {
    clock.now += ms
    for (const t of timers.splice(0)) {
      if (t.at <= clock.now) t.fn()
      else timers.push(t)
    }
  }
  return { c, advance, count: () => refreshes }
}

describe('live query coalescing', () => {
  test('a burst of row events (a pull page) refreshes once', () => {
    const { c, advance, count } = setup()
    for (let i = 0; i < 500; i++) c.rowChanged()
    advance(100)
    expect(count()).toBe(1)
    c.rowChanged()
    advance(100)
    expect(count()).toBe(2)
  })

  test("a local write's own row events don't refresh a second time", () => {
    const { c, advance, count } = setup()
    c.refreshed() // notifyLocalChange() right after the write
    advance(5)
    c.rowChanged()
    advance(100)
    expect(count()).toBe(0)
    advance(1_000)
    c.rowChanged() // a later write nobody refreshed for
    advance(100)
    expect(count()).toBe(1)
  })

  test('dispose drops a pending refresh', () => {
    const { c, advance, count } = setup()
    c.rowChanged()
    c.dispose()
    advance(100)
    expect(count()).toBe(0)
  })
})
