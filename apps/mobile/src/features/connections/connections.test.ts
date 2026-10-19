import { readFileSync } from 'node:fs'
import {
  CONNECTION_OPTIONS,
  NOTICED_DENYLIST,
  type PullResponse,
  type Question,
  type Suggestion,
  type SyncedThought,
  usesDeniedWord,
} from '@bullet/core'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import {
  acceptSuggestion,
  answerConnection,
  renameTheme,
  retireTheme,
  undoSuggestion,
} from '../../data/local'
import { applyPull } from '../../data/mirror'
import { themes, thoughts } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import { buildInbox, loadInboxRows } from '../inbox/model'
import { closedLine, listLoops } from '../journal/loops'
import { loadThinkView } from '../reflect/model'
import { allCopy, closedByLine, pillLabel, pillText, quote, shortQuote } from './copy'
import {
  cleanThemeName,
  dayWord,
  inboxIsEmpty,
  loadLoopAnswers,
  loadNoticed,
  loadRelated,
  loadTheme,
  mergeChoices,
  themeOfThoughts,
} from './model'

const DAY = 86_400_000
const TZ = 'Europe/Paris'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const B1 = id(0xb01)
const B2 = id(0xb02)
const B3 = id(0xb03)
const LOOP = id(0xa01)
const ANSWER = id(0xa02)
const OTHER = id(0xa03)
const LINK = id(0x101)
const LINK2 = id(0x102)
const THEME = id(0x201)
const THEME2 = id(0x202)
const CARD = id(0x301)
const RESOLVE = id(0x401)
const Q = id(0x501)
const base = { owner_id: OWNER, created_at: T0, updated_at: T0, state: 'active' as const }

const bullet = (bid: string, text: string, at: number) => ({
  ...base,
  id: bid,
  text,
  captured_at: at,
  timezone: TZ,
  source: 'text' as const,
  text_edited_by_user: false,
  text_from_draft: false,
  answers_question_id: null,
  resolves_thought_id: null,
  processing: {
    status: 'processed' as const,
    attempts: 1,
    error: null,
    next_retry_at: null,
    updated_at: at,
  },
})

const thought = (
  tid: string,
  bid: string,
  text: string,
  kind: SyncedThought['kind'],
): SyncedThought => ({
  ...base,
  id: tid,
  source_bullet_id: bid,
  position: 0,
  text,
  span: null,
  kind,
  kind_source: 'engine',
  resolved_at: null,
  resolved_by_bullet_id: null,
  never_ask: false,
})

const resolve: Suggestion = {
  ...base,
  id: RESOLVE,
  source_bullet_id: B2,
  source_thought_id: ANSWER,
  target_kind: 'thought_resolve',
  operation: 'update',
  target_id: LOOP,
  payload: { thought_id: LOOP, resolved_by_bullet_id: B2 },
  confidence: 0.8,
  tier: 'suggest',
  status: 'pending',
  resolved_at: null,
  applied_entity_id: null,
  applied_at: null,
  auto_applied: false,
}

const connection: Question = {
  ...base,
  id: Q,
  source_bullet_id: B3,
  source_thought_id: OTHER,
  suggestion_id: null,
  kind: 'reflective',
  origin: 'connection',
  topic: 'other',
  text: 'Is this the same thing? «check if the passport expires» / «جواز السفر»',
  options: [...CONNECTION_OPTIONS],
  status: 'open',
  answer_bullet_id: null,
  answer_option: null,
  resolved_at: null,
  snoozed_until: null,
  snooze_count: 0,
  template_id: null,
  related_thought_id: LOOP,
}

const theme = (tid: string, name: string | null, status: 'active' | 'dormant', count: number) => ({
  ...base,
  id: tid,
  name,
  named_by_user: false,
  status,
  merged_into_theme_id: null,
  thought_count: count,
  day_count: 3,
  first_seen_at: T0,
  last_seen_at: T0,
})

const page = (): PullResponse => ({
  cursor: '1',
  has_more: false,
  server_time: T0,
  changes: {
    bullets: [
      bullet(B1, 'check if the passport expires', T0 - 9 * DAY),
      bullet(B2, 'passport valid until 2029', T0 - DAY),
      bullet(B3, 'جواز السفر', T0),
    ],
    suggestions: [resolve],
    tasks: [],
    events: [],
    trackers: [],
    tracker_entries: [],
    activities: [],
    audio_attachments: [],
    transcripts: [],
    thoughts: [
      thought(LOOP, B1, 'check if the passport expires', 'to_check'),
      thought(ANSWER, B2, 'passport valid until 2029', 'note'),
      thought(OTHER, B3, 'جواز السفر', 'idea'),
    ],
    questions: [connection],
    thought_links: [
      {
        ...base,
        id: LINK,
        a_thought_id: LOOP,
        a_bullet_id: B1,
        b_thought_id: ANSWER,
        b_bullet_id: B2,
        type: 'answers',
        visible_from: 'both',
      },
      {
        ...base,
        id: LINK2,
        a_thought_id: LOOP,
        a_bullet_id: B1,
        b_thought_id: OTHER,
        b_bullet_id: B3,
        type: 'same_entity',
        visible_from: 'both',
      },
    ],
    themes: [theme(THEME, 'passport', 'active', 4), theme(THEME2, null, 'dormant', 5)],
    theme_thoughts: [
      { ...base, id: id(0x601), theme_id: THEME, thought_id: LOOP, bullet_id: B1 },
      { ...base, id: id(0x603), theme_id: THEME, thought_id: OTHER, bullet_id: B3 },
      { ...base, id: id(0x602), theme_id: THEME2, thought_id: ANSWER, bullet_id: B2 },
    ],
    noticed_cards: [
      {
        ...base,
        id: CARD,
        theme_id: THEME,
        headline: '«check if the passport expires» · came up 4 times in 3 days',
        quotes: [
          { thought_id: OTHER, bullet_id: B3, text: 'جواز السفر' },
          { thought_id: LOOP, bullet_id: B1, text: 'check if the passport expires' },
        ],
        count: 4,
        days: 3,
        status: 'new',
        opened_at: null,
        resolved_at: null,
      },
    ],
  },
})

function setup() {
  const db = openTestDb()
  const deps = testDeps()
  applyPull(db, page())
  return { db, deps }
}

describe('wording', () => {
  test("the app's own words on these screens are observational (none from the denylist)", () => {
    for (const word of [
      'seem',
      'tend',
      'should',
      'pattern',
      'stress',
      'anxious',
      'always',
      'never',
    ]) {
      expect(NOTICED_DENYLIST).toContain(word)
    }
    for (const text of allCopy()) expect(usesDeniedWord(text), text).toBe(false)
  })

  test('no string in the slice 3 screens and components uses a denied word', () => {
    const files = [
      '../../components/connections/InboxCards.tsx',
      '../../components/connections/parts.tsx',
      '../../components/connections/RelatedList.tsx',
      '../../components/connections/ThemeSheets.tsx',
      '../../components/inbox/ThinkCard.tsx',
      '../../app/inbox/index.tsx',
      '../../app/theme/[id].tsx',
      '../../app/journal/loops.tsx',
      './actions.ts',
      './model.ts',
    ]
    for (const f of files) {
      const source = readFileSync(new URL(f, import.meta.url), 'utf8')
        // Comments are notes for developers, not words on screen.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      const strings = [
        ...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g),
        // JSX text between tags.
        ...source.matchAll(/>([^<>{}\n]+)</g),
      ].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
      for (const s of strings) expect(usesDeniedWord(s), `${f}: ${s}`).toBe(false)
    }
  })

  test("the user's own quoted words are kept as they are, even with a denied word", () => {
    expect(quote('I always stress about Monday')).toBe('«I always stress about Monday»')
    expect(shortQuote('a b c', 60)).toBe('«a b c»')
    expect(shortQuote(`${'word '.repeat(30)}end`, 20)).toBe('«word word word word…»')
    expect(closedByLine('passport valid until 2029')).toBe('Closed by «passport valid until 2029»')
  })
})

describe('Noticed', () => {
  test('cards quote the user, with a day for each quote, Arabic laid out right to left', () => {
    const { db } = setup()
    const [card] = loadNoticed(db, T0)
    expect(card?.headline).toBe('«check if the passport expires» · came up 4 times in 3 days')
    expect(card?.headlineRtl).toBe(false)
    expect(card?.theme).toEqual({ id: THEME, name: 'passport' })
    expect(card?.isNew).toBe(true)
    expect(card?.quotes).toEqual([
      {
        thoughtId: OTHER,
        bulletId: B3,
        text: 'جواز السفر',
        when: 'Today',
        rtl: true,
        label: 'Today: «جواز السفر»',
      },
      {
        thoughtId: LOOP,
        bulletId: B1,
        text: 'check if the passport expires',
        when: '6 Oct',
        rtl: false,
        label: '6 Oct: «check if the passport expires»',
      },
    ])
  })

  test('"Not a theme" hides its card; nothing noticed leaves the section empty', () => {
    const { db, deps } = setup()
    retireTheme(db, THEME, deps)
    expect(loadNoticed(db, T0)).toEqual([])
  })

  test('the pill shows the name, or asks for one', () => {
    expect(pillText('passport')).toBe('passport')
    expect(pillText(null)).toBe('Name it')
    expect(pillLabel('Sami')).toBe('Theme: Sami. Rename')
    const { db, deps } = setup()
    renameTheme(db, THEME, 'Travel papers', deps)
    expect(loadNoticed(db, T0)[0]?.theme.name).toBe('Travel papers')
  })

  test('a typed name is one trimmed line of at most 60 characters', () => {
    expect(cleanThemeName('  Sami \n talk ')).toBe('Sami talk')
    expect(cleanThemeName('   ')).toBeNull()
    expect(cleanThemeName('x'.repeat(80))?.length).toBe(60)
  })

  test('"Merge with…" lists the other themes, an unnamed one by its newest quote', () => {
    const { db } = setup()
    expect(mergeChoices(db, THEME)).toEqual([
      { id: THEME2, title: '«passport valid until 2029»', detail: '5 thoughts' },
    ])
    expect(mergeChoices(db, THEME2).map((c) => c.title)).toEqual(['passport'])
  })
})

describe('the theme screen and the "again" dot', () => {
  test('a theme lists its captures newest first; a retired one is gone', () => {
    const { db, deps } = setup()
    const view = loadTheme(db, THEME, T0)
    expect(view?.name).toBe('passport')
    expect(view?.captures.map((c) => [c.bulletId, c.when])).toEqual([
      [B3, 'Today'],
      [B1, '6 Oct'],
    ])
    retireTheme(db, THEME, deps)
    expect(loadTheme(db, THEME, T0)).toBeNull()
    expect(loadTheme(db, id(0xfff), T0)).toBeNull()
  })

  test('only thoughts of an active theme get the dot, pointing at that theme', () => {
    const { db } = setup()
    const map = themeOfThoughts(db, [LOOP, ANSWER, OTHER])
    // THEME2 is dormant: no dot for ANSWER.
    expect(map).toEqual(
      new Map([
        [LOOP, THEME],
        [OTHER, THEME],
      ]),
    )
  })
})

describe('Related', () => {
  test('rows carry a day, the small word and the quote, newest capture first', () => {
    const { db } = setup()
    expect(loadRelated(db, B1, T0, TZ)).toEqual([
      {
        linkId: LINK2,
        bulletId: B3,
        text: 'جواز السفر',
        rtl: true,
        meta: 'Today · same person',
        label: 'Today, same person: «جواز السفر»',
      },
      {
        linkId: LINK,
        bulletId: B2,
        text: 'passport valid until 2029',
        rtl: false,
        meta: 'Yesterday · answers',
        label: 'Yesterday, answers: «passport valid until 2029»',
      },
    ])
  })

  test('days read as Today, Yesterday, a weekday this past week, then a date', () => {
    expect(dayWord(T0, T0, TZ)).toBe('Today')
    expect(dayWord(T0 - DAY, T0, TZ)).toBe('Yesterday')
    expect(dayWord(T0 - 3 * DAY, T0, TZ)).toBe('Mon')
    expect(dayWord(T0 - 9 * DAY, T0, TZ)).toBe('6 Oct')
    expect(dayWord(T0 - 400 * DAY, T0, TZ)).toBe('10 Sep 2025')
  })
})

describe('"Did this close it?"', () => {
  test('a waiting one quotes the loop and the answer', () => {
    const { db } = setup()
    expect(loadLoopAnswers(db)).toEqual([
      {
        suggestionId: RESOLVE,
        loop: 'check if the passport expires',
        loopRtl: false,
        loopBulletId: B1,
        answer: 'passport valid until 2029',
        answerRtl: false,
        answerBulletId: B2,
        alreadyClosed: false,
      },
    ])
  })

  test('a loop closed meanwhile shows as already closed', () => {
    const { db } = setup()
    db.update(thoughts).set({ resolved_at: T0 }).where(eq(thoughts.id, LOOP)).run()
    expect(loadLoopAnswers(db)[0]?.alreadyClosed).toBe(true)
  })

  test('Close it: under Done for you with Undo, and "Closed by «…»" on the loop; Undo reopens', () => {
    const { db, deps } = setup()
    acceptSuggestion(db, RESOLVE, deps)
    expect(loadLoopAnswers(db)).toEqual([])
    const view = buildInbox(loadInboxRows(db, { now: T0, timezone: TZ, heldIds: [] }), [])
    expect(view.done.map((d) => [d.suggestionId, d.summary.done, d.bulletId])).toEqual([
      [RESOLVE, 'Closed «check if the passport expires»', B2],
    ])
    const loops = listLoops(db)
    expect(loops.done.map((l) => l.closedLine)).toEqual(['Closed by «passport valid until 2029»'])

    undoSuggestion(db, RESOLVE, deps)
    expect(listLoops(db).toCheck.map((l) => l.id)).toEqual([LOOP])
    const after = buildInbox(loadInboxRows(db, { now: T0, timezone: TZ, heldIds: [] }), [])
    expect(after.done).toEqual([])
  })

  test('closed lines: by a capture, with a note when its words are gone, or checked off', () => {
    expect(closedLine('note text', { resolvedByBulletId: B2 })).toBe('Closed by «note text»')
    expect(closedLine(null, { resolvedByBulletId: B2 })).toBe('Closed with a note')
    expect(closedLine(null, { resolvedByBulletId: null })).toBe('Checked off')
  })

  test('the whole Inbox is empty only when nothing at all shows', () => {
    expect(inboxIsEmpty(true, 0, 0)).toBe(true)
    expect(inboxIsEmpty(true, 1, 0)).toBe(false)
    expect(inboxIsEmpty(true, 0, 1)).toBe(false)
    expect(inboxIsEmpty(false, 0, 0)).toBe(false)
  })
})

describe('connection questions', () => {
  test('one shows under To think about; "Same thing" alone does not land in Answered', () => {
    const { db, deps } = setup()
    expect(loadThinkView(db, T0).toThink.map((q) => [q.id, q.origin])).toEqual([[Q, 'connection']])
    answerConnection(db, Q, true, deps)
    const view = loadThinkView(db, T0)
    expect(view.toThink).toEqual([])
    expect(view.answered).toEqual([])
    expect(db.select().from(themes).all().length).toBe(2)
  })
})
