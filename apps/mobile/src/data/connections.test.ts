import {
  CONNECTION_OPTIONS,
  type PullResponse,
  pushOpSchema,
  type Question,
  type Suggestion,
  type SyncedThought,
} from '@bullet/core'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { inboxCount } from '../features/capture/counts'
import { openTestDb, T0, testDeps } from '../test/db'
import {
  listLoopAnswers,
  listNoticed,
  listRelated,
  listThemes,
  RELATED_WORDS,
  thoughtsInThemes,
} from './connections'
import {
  acceptSuggestion,
  answerConnection,
  answerQuestion,
  dismissNoticed,
  mergeTheme,
  openNoticed,
  rejectSuggestion,
  renameTheme,
  retireTheme,
  undoSuggestion,
  vetoLink,
} from './local'
import { applyPull } from './mirror'
import { listPendingSuggestions } from './queries'
import { noticedCards, outbox, themes, thoughtLinks, thoughts } from './schema'

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
  timezone: 'Europe/Paris',
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
  text: 'Is this the same thing? «check if the passport expires» / «passport stuff»',
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

const page = (cursor = '1'): PullResponse => ({
  cursor,
  has_more: false,
  server_time: T0,
  changes: {
    bullets: [
      bullet(B1, 'check if the passport expires', T0),
      bullet(B2, 'passport valid until 2029', T0 + 86_400_000),
      bullet(B3, 'passport stuff', T0 + 2 * 86_400_000),
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
      thought(OTHER, B3, 'passport stuff', 'idea'),
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
        type: 'revisits',
        visible_from: 'both',
      },
    ],
    themes: [
      {
        ...base,
        id: THEME,
        name: 'passport',
        named_by_user: false,
        status: 'active',
        merged_into_theme_id: null,
        thought_count: 4,
        day_count: 3,
        first_seen_at: T0,
        last_seen_at: T0,
      },
      {
        ...base,
        id: THEME2,
        name: 'travel',
        named_by_user: false,
        status: 'dormant',
        merged_into_theme_id: null,
        thought_count: 5,
        day_count: 3,
        first_seen_at: T0,
        last_seen_at: T0,
      },
    ],
    theme_thoughts: [
      { ...base, id: id(0x601), theme_id: THEME, thought_id: LOOP, bullet_id: B1 },
      { ...base, id: id(0x602), theme_id: THEME2, thought_id: OTHER, bullet_id: B3 },
    ],
    noticed_cards: [
      {
        ...base,
        id: CARD,
        theme_id: THEME,
        headline: '«passport» · came up 4 times in 3 days',
        quotes: [
          { thought_id: ANSWER, bullet_id: B2, text: 'passport valid until 2029' },
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
  const ops = () =>
    db
      .select()
      .from(outbox)
      .all()
      .map((o) => pushOpSchema.parse(o.op))
  return { db, deps, ops }
}

describe('Related', () => {
  test('a link shown from one capture only is listed there only', () => {
    const { db } = setup()
    // LINK2 joins B1 (a) and B3 (b); shown from B3's capture only.
    db.update(thoughtLinks).set({ visible_from: 'b' }).where(eq(thoughtLinks.id, LINK2)).run()
    expect(listRelated(db, B1).map((r) => r.linkId)).toEqual([LINK])
    expect(listRelated(db, B3).map((r) => r.linkId)).toEqual([LINK2])
    // And the other way round.
    db.update(thoughtLinks).set({ visible_from: 'a' }).where(eq(thoughtLinks.id, LINK2)).run()
    expect(listRelated(db, B1).map((r) => r.linkId)).toEqual([LINK2, LINK])
    expect(listRelated(db, B3)).toEqual([])
  })

  test('a capture lists the thoughts linked to it, newest capture first, with a small word', () => {
    const { db } = setup()
    expect(listRelated(db, B1)).toEqual([
      {
        linkId: LINK2,
        type: 'revisits',
        word: 'again',
        thoughtId: LOOP,
        other: {
          bulletId: B3,
          thoughtId: OTHER,
          text: 'passport stuff',
          capturedAt: T0 + 2 * 86_400_000,
        },
      },
      expect.objectContaining({
        linkId: LINK,
        word: RELATED_WORDS.answers,
        other: expect.objectContaining({ bulletId: B2 }),
      }),
    ])
    expect(listRelated(db, B2).map((r) => r.other.bulletId)).toEqual([B1])
  })

  test('"Not related" hides the link at once and queues link.veto; a pull does not bring it back', () => {
    const { db, deps, ops } = setup()
    vetoLink(db, LINK, deps)
    expect(listRelated(db, B2)).toEqual([])
    expect(ops()).toEqual([expect.objectContaining({ type: 'link.veto', link_id: LINK })])
    applyPull(db, page('2'))
    expect(db.select().from(thoughtLinks).where(eq(thoughtLinks.id, LINK)).get()?.state).toBe(
      'deleted',
    )
  })
})

describe('Noticed', () => {
  test('cards with their theme pill; Noticed never in the badge', () => {
    const { db } = setup()
    const [card] = listNoticed(db)
    expect(card).toMatchObject({
      id: CARD,
      headline: '«passport» · came up 4 times in 3 days',
      status: 'new',
      theme: { id: THEME, name: 'passport', namedByUser: false },
    })
    expect(card?.quotes.map((q) => q.bullet_id)).toEqual([B2, B1])
    // The badge counts what waits for a decision: here the one "Did this close it?". Never Noticed.
    expect(inboxCount(db)).toBe(1)
    rejectSuggestion(db, RESOLVE, testDeps())
    expect(inboxCount(db)).toBe(0)
  })

  test('open, dismiss; rename, merge and not a theme', () => {
    const { db, deps, ops } = setup()
    openNoticed(db, CARD, deps)
    expect(listNoticed(db)[0]?.status).toBe('opened')
    renameTheme(db, THEME, '  Passport  renewal ', deps)
    expect(listNoticed(db)[0]?.theme).toMatchObject({ name: 'Passport renewal', namedByUser: true })
    expect(listThemes(db, THEME).map((t) => t.id)).toEqual([THEME2])
    mergeTheme(db, THEME2, THEME, deps)
    expect(listThemes(db).map((t) => t.id)).toEqual([THEME])
    dismissNoticed(db, CARD, deps)
    expect(listNoticed(db)).toEqual([])
    retireTheme(db, THEME, deps)
    expect(listThemes(db)).toEqual([])
    expect(ops().map((o) => o.type)).toEqual([
      'noticed.open',
      'theme.rename',
      'theme.merge',
      'noticed.dismiss',
      'theme.retire',
    ])
    // A pull before the server answers keeps the local decisions.
    applyPull(db, page('2'))
    expect(db.select().from(themes).where(eq(themes.id, THEME)).get()?.status).toBe('retired')
    expect(db.select().from(noticedCards).get()?.status).toBe('dismissed')
  })

  test('not a theme withdraws its unopened cards', () => {
    const { db, deps } = setup()
    retireTheme(db, THEME, deps)
    expect(db.select().from(noticedCards).get()?.status).toBe('retired')
    expect(listNoticed(db)).toEqual([])
  })

  test('the Stream "again" dot: thoughts in an active theme', () => {
    const { db } = setup()
    expect(thoughtsInThemes(db, [LOOP, ANSWER, OTHER])).toEqual(new Set([LOOP]))
  })
})

describe('"Did this close it?"', () => {
  test('listed on its own (not with things); accept closes the loop, Undo reopens it', () => {
    const { db, deps, ops } = setup()
    expect(listPendingSuggestions(db)).toEqual([])
    const [v] = listLoopAnswers(db)
    expect(v).toMatchObject({
      loop: { id: LOOP, text: 'check if the passport expires' },
      answer: { id: ANSWER, text: 'passport valid until 2029' },
      alreadyClosed: false,
    })
    acceptSuggestion(db, RESOLVE, deps)
    const loop = () => db.select().from(thoughts).where(eq(thoughts.id, LOOP)).get()
    expect(loop()).toMatchObject({ resolved_at: T0, resolved_by_bullet_id: B2 })
    expect(listLoopAnswers(db, 'accepted')).toHaveLength(1)
    // Its pull before the server has it keeps the loop closed.
    applyPull(db, page('2'))
    expect(loop()?.resolved_by_bullet_id).toBe(B2)
    undoSuggestion(db, RESOLVE, deps)
    expect(loop()).toMatchObject({ resolved_at: null, resolved_by_bullet_id: null })
    expect(ops().map((o) => o.type)).toEqual(['suggestion.accept', 'suggestion.undo'])
  })

  test('closed another way meanwhile shows Already closed; dismiss is a plain reject', () => {
    const { db, deps, ops } = setup()
    db.update(thoughts)
      .set({ resolved_at: T0, resolved_by_bullet_id: null })
      .where(eq(thoughts.id, LOOP))
      .run()
    expect(listLoopAnswers(db)[0]?.alreadyClosed).toBe(true)
    rejectSuggestion(db, RESOLVE, deps)
    expect(listLoopAnswers(db)).toEqual([])
    expect(ops().map((o) => o.type)).toEqual(['suggestion.reject'])
  })
})

describe('a connection question', () => {
  test('answered with Same thing / Different (the only reflective question with options)', () => {
    const { db, deps, ops } = setup()
    answerConnection(db, Q, true, deps)
    expect(ops()).toEqual([
      expect.objectContaining({ type: 'question.answer', question_id: Q, option: 'Same thing' }),
    ])
    expect(() => answerQuestion(db, Q, 'Maybe', deps)).toThrow(/not an option/)
  })
})
