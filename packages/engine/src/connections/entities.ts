/**
 * Named entities (people, places, projects) as segmentation reports them, compared loosely: case,
 * accents, a leading article ("the Hamra flat" / "Hamra flat", "l'école", "el bayt") and
 * punctuation don't matter.
 */

const ARTICLE = /^(?:(?:the|a|an|my|our|le|la|les|el|al|il)\s+|l')/u

/** The comparable form of an entity name ('' when nothing is left). */
export function normalizeEntity(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .trim()
    .replace(ARTICLE, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clean a list from the model: trimmed, de-duplicated, at most 6, nothing absurdly long. */
export function cleanEntities(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    const key = normalizeEntity(name)
    if (key.length < 2 || name.length > 60 || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 6) break
  }
  return out
}

/** Do the two lists name the same person, place or project? */
export function sharedEntity(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const left = new Set(a.map(normalizeEntity).filter((x) => x.length >= 2))
  return b.some((x) => left.has(normalizeEntity(x)))
}
