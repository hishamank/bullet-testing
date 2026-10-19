/**
 * Ids and the time zone, the browser's way. `crypto.randomUUID()` only exists in secure contexts
 * (https or localhost), and the home server may be reached over plain http on a tailnet, so ids
 * fall back to `getRandomValues`, which works everywhere.
 */

export function uuidv4(c: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>) {
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

export const browserUuid = () => uuidv4(globalThis.crypto)

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
