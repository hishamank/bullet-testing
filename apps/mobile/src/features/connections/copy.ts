/**
 * The app's own words on the slice 3 screens (Noticed, "Did this close it?", connection questions,
 * Related, the "again" dot, the theme screen). Observational, never interpretive: a test checks
 * that none of them uses a word from `NOTICED_DENYLIST`. The user's quoted words are exempt (they
 * come from the data, not from here). Pure, so screens and tests share it.
 */

/** «text», the user's words exactly as they are. */
export const quote = (text: string) => `«${text}»`

/** A short one-line «quote» of a longer text (a capture), cut at a word. */
export function shortQuote(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return quote(one)
  const cut = one.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return quote(`${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`)
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const COPY = {
  // Inbox · Noticed
  noticedTitle: 'Noticed',
  noticedEmpty: 'Nothing noticed yet.',
  open: 'Open',
  openHint: 'Lists every capture it came up in',
  notATheme: 'Not a theme',
  notAThemeHint: 'Removes this card and its theme',
  more: 'More',
  moreHint: 'Rename or merge',
  clear: 'Clear',
  clearHint: 'Removes this card. The theme stays.',
  rename: 'Rename',
  mergeWith: 'Merge with…',
  cancel: 'Cancel',
  save: 'Save',
  unnamed: 'Name it',
  renameTitle: 'Rename theme',
  renameField: 'Theme name',
  mergeIntro: 'Its captures join the theme you pick. This card goes away.',
  mergeEmpty: 'There is no other theme to merge with yet.',
  quoteHint: 'Opens the capture',

  // Inbox · To decide: "Did this close it?"
  closeAsk: 'Did this close it?',
  closeIt: 'Close it',
  keepOpen: 'Keep open',
  alreadyClosed: 'Already closed',
  ok: 'OK',

  // To think about · connection questions
  sameThing: 'Same thing',
  different: 'Different',

  // Capture detail · Related
  relatedTitle: 'Related',
  notRelated: 'Not related',
  notRelatedNote: '“Not related” removes a link for good.',
  notRelatedConfirm: 'Not related?',
  notRelatedDetail: 'The link goes. These two are not linked again.',

  // Stream · "again" dot
  againLabel: 'comes up again',
  openTheme: 'Opens the theme',

  // Theme screen
  back: 'Back',
  themeGone: 'This theme is no longer here.',
  undo: 'Undo',
  capturesTitle: 'Captures',

  // VoiceOver announcements
  closed: 'Closed.',
  keptOpen: 'Kept open.',
  removed: 'Removed.',
  renamed: 'Renamed.',
  merged: 'Merged.',
} as const

/** "Theme: Sami. Rename" / "Theme without a name. Name it". */
export function pillLabel(name: string | null): string {
  return name ? `Theme: ${name}. Rename` : `Theme without a name. ${COPY.unnamed}`
}

/** What the pill shows. */
export function pillText(name: string | null): string {
  return name ?? COPY.unnamed
}

/** The theme screen's title. */
export function themeTitle(name: string | null): string {
  return name ?? 'Theme'
}

export function capturesHeading(n: number): string {
  return `${COPY.capturesTitle} · ${n}`
}

export function relatedHeading(n: number): string {
  return `${COPY.relatedTitle} · ${n}`
}

/** "Closed by «passport valid until 2029»" on a closed loop. */
export function closedByLine(text: string): string {
  return `Closed by ${shortQuote(text)}`
}

/** "4 thoughts" in the Merge with… list. */
export function thoughtCount(n: number): string {
  return count(n, 'thought', 'thoughts')
}

/** VoiceOver for a "Did this close it?" card. */
export function closeAskLabel(loop: string, answer: string | null): string {
  return answer
    ? `${COPY.closeAsk} ${quote(loop)}, answered by ${quote(answer)}`
    : `${COPY.closeAsk} ${quote(loop)}`
}

/** Every fixed string above, for the wording test. */
export function allCopy(): string[] {
  return [
    ...Object.values(COPY),
    pillLabel('x'),
    pillLabel(null),
    themeTitle(null),
    capturesHeading(2),
    relatedHeading(2),
    closedByLine('x'),
    thoughtCount(1),
    thoughtCount(2),
    closeAskLabel('x', 'y'),
    closeAskLabel('x', null),
    openThemeLabel('x'),
  ]
}

/** The "again" dot (and its VoiceOver action): "Opens the theme «…»". */
export function openThemeLabel(thoughtText: string): string {
  return `${COPY.openTheme} ${quote(thoughtText)}`
}
