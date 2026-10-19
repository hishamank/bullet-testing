/**
 * The `themes_nightly` run (slice 3), once a night at 02:00 server time, with the nightly model
 * (`LLM_NIGHTLY_MODEL`, else the live one). After downtime it runs once to catch up; every limit
 * is enforced against the database, so a catch-up after a week offline still makes at most 8
 * active themes and 2 Noticed cards in any 24 hours. Per user it:
 *
 *  1. embeds thoughts whose vector is missing or from another embedder (a model change);
 *  2. reviews links the model has not seen yet, least confident first (a bounded number per
 *     night): types them (`same_entity` / `same_topic`), and deletes a low-confidence one it finds
 *     unrelated (remembered, so it is not re-made);
 *  3. finds themes: clusters of linked thoughts of the last 30 days meeting the theme rules,
 *     continuing the theme they share most thoughts with (through merge aliases; never one the
 *     user called "Not a theme"), at most 8 active;
 *  4. names new themes in the user's own words (no name for a mostly-sensitive theme);
 *  5. retires Noticed cards left unopened for 14 days and writes new ones within the caps.
 */

import { randomUUID } from 'node:crypto'
import { CONNECTION_RULES, noticedHeadline, type NoticedQuote, shortQuote } from '@bullet/core'
import {
  clusterStats,
  clusterThoughts,
  daySpan,
  type EmbeddingProfile,
  type Embedder,
  type EngineConfig,
  isSensitiveTheme,
  type KnownTheme,
  type LinkReview,
  type LlmClient,
  matchClusters,
  nameTheme,
  pickActive,
  pickQuotes,
  reviewLink,
  similarityEdges,
  type ThemeCandidateThought,
  zonedParts,
  zonedToEpoch,
  addDays,
} from '@bullet/engine'
import { and, asc, desc, eq, gt, isNull, lte, max, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  nightlyRuns,
  noticedCards,
  themeAliases,
  themes,
  themeThoughts,
  thoughtLinks,
  users,
} from '../db/schema'
import { touch } from '../sync/changes'
import {
  activeThoughtInfo,
  comparableVectors,
  ensureBaseline,
  hasPair,
  vetoedPairs,
  deleteLink,
  ensureEmbedded,
  loadEmbeddings,
  type ThoughtInfo,
  vetoPair,
} from './store'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** The local hour the nightly run is scheduled at. */
export const NIGHTLY_HOUR = 2
/** Links reviewed per user per night (each is a model call). */
export const NIGHTLY_REVIEW_LIMIT = 40
/** Thoughts (re-)embedded per user per night. */
export const NIGHTLY_EMBED_LIMIT = 512
/** A failed run is tried again after this long. */
const RETRY_FAILED_AFTER_MS = HOUR_MS

export interface NightlyDeps {
  db: Db
  /** The nightly model (or the live one). */
  llm: LlmClient
  engine: EngineConfig
  embedder?: Embedder
  profile?: EmbeddingProfile
  now: () => number
  reviewLimit?: number
}

export interface NightlyStats {
  embedded: number
  reviewed: number
  unlinked: number
  activeThemes: number
  newThemes: number
  named: number
  cards: number
  retiredCards: number
}

/** The latest 02:00 (server time) at or before `now`. */
export function nightlySlot(now: number, timezone: string): number {
  const p = zonedParts(now, timezone)
  const today = zonedToEpoch(
    { year: p.year, month: p.month, day: p.day, hour: NIGHTLY_HOUR },
    timezone,
  )
  if (today <= now) return today
  const y = addDays(p, -1)
  return zonedToEpoch({ ...y, hour: NIGHTLY_HOUR }, timezone)
}

/**
 * The slot a run is due for, or null: due when no run finished for the latest 02:00 slot (one
 * run catches up any number of missed nights) and none started within the last hour.
 */
export function nightlyDue(db: Db, now: number, timezone: string): number | null {
  const slot = nightlySlot(now, timezone)
  const done = db
    .select({ id: nightlyRuns.id })
    .from(nightlyRuns)
    .where(and(eq(nightlyRuns.status, 'done'), sql`${nightlyRuns.slot_at} >= ${slot}`))
    .get()
  if (done) return null
  const recent = db
    .select({ at: max(nightlyRuns.started_at) })
    .from(nightlyRuns)
    .where(sql`${nightlyRuns.slot_at} >= ${slot}`)
    .get()?.at
  if (recent !== null && recent !== undefined && now - recent < RETRY_FAILED_AFTER_MS) return null
  return slot
}

/** Run the nightly work for every user, recording the run. */
export async function runNightly(deps: NightlyDeps, slot: number): Promise<NightlyStats> {
  const id = randomUUID()
  deps.db
    .insert(nightlyRuns)
    .values({ id, slot_at: slot, started_at: deps.now(), status: 'running' })
    .run()
  const total: NightlyStats = {
    embedded: 0,
    reviewed: 0,
    unlinked: 0,
    activeThemes: 0,
    newThemes: 0,
    named: 0,
    cards: 0,
    retiredCards: 0,
  }
  try {
    for (const u of deps.db.select({ id: users.id }).from(users).all()) {
      const s = await nightlyFor(deps, u.id)
      for (const k of Object.keys(total) as (keyof NightlyStats)[]) total[k] += s[k]
    }
    deps.db
      .update(nightlyRuns)
      .set({ status: 'done', finished_at: deps.now(), stats: { ...total } })
      .where(eq(nightlyRuns.id, id))
      .run()
    return total
  } catch (err) {
    deps.db
      .update(nightlyRuns)
      .set({
        status: 'failed',
        finished_at: deps.now(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(nightlyRuns.id, id))
      .run()
    throw err
  }
}

/** The nightly work for one user. */
export async function nightlyFor(deps: NightlyDeps, ownerId: string): Promise<NightlyStats> {
  const { db } = deps
  const stats: NightlyStats = {
    embedded: 0,
    reviewed: 0,
    unlinked: 0,
    activeThemes: 0,
    newThemes: 0,
    named: 0,
    cards: 0,
    retiredCards: 0,
  }
  const windowStart = deps.now() - CONNECTION_RULES.windowMs

  // 1. Vectors from another embedder (a model change) or missing ones, newest first.
  if (deps.embedder) {
    const have = loadEmbeddings(db, ownerId, deps.embedder.key)
    const todo = activeThoughtInfo(db, ownerId)
      .filter((t) => !have.has(t.id))
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, NIGHTLY_EMBED_LIMIT)
    stats.embedded = await ensureEmbedded(db, deps.embedder, ownerId, todo, deps.now())
    if (deps.profile?.centre) await ensureBaseline(db, deps.embedder, deps.now())
  }

  // 2. Review links.
  const reviewed = await reviewLinks(deps, ownerId)
  stats.reviewed = reviewed.reviewed
  stats.unlinked = reviewed.unlinked

  // 3. Themes.
  const themed = updateThemes(deps, ownerId, windowStart, deps.now())
  stats.activeThemes = themed.active
  stats.newThemes = themed.created

  // 4. Names.
  stats.named = await nameThemes(deps, ownerId, windowStart)

  // 5. Noticed.
  const cards = writeNoticed(deps, ownerId, windowStart)
  stats.cards = cards.created
  stats.retiredCards = cards.retired
  return stats
}

// --- 2. link review ---

async function reviewLinks(
  deps: NightlyDeps,
  ownerId: string,
): Promise<{ reviewed: number; unlinked: number }> {
  const { db } = deps
  const texts = new Map(activeThoughtInfo(db, ownerId).map((t) => [t.id, t.text]))
  const todo = db
    .select()
    .from(thoughtLinks)
    .where(
      and(
        eq(thoughtLinks.owner_id, ownerId),
        eq(thoughtLinks.state, 'active'),
        eq(thoughtLinks.origin, 'capture'),
        ne(thoughtLinks.type, 'answers'),
        isNull(thoughtLinks.reviewed_at),
      ),
    )
    .orderBy(asc(thoughtLinks.score))
    .all()
    .filter((l) => texts.has(l.a_thought_id) && texts.has(l.b_thought_id))
    .slice(0, deps.reviewLimit ?? NIGHTLY_REVIEW_LIMIT)
  const reviewBelow = deps.profile?.thresholds.reviewBelow ?? Number.POSITIVE_INFINITY
  const results: { id: string; relation: LinkReview }[] = []
  for (const l of todo) {
    const relation = await reviewLink(
      { llm: deps.llm, config: deps.engine },
      texts.get(l.a_thought_id) as string,
      texts.get(l.b_thought_id) as string,
    )
    if (relation) results.push({ id: l.id, relation })
  }
  let unlinked = 0
  const now = deps.now()
  db.transaction((tx) => {
    for (const r of results) {
      const l = tx.select().from(thoughtLinks).where(eq(thoughtLinks.id, r.id)).get()
      // The user may have acted meanwhile (a veto deletes it; "Same thing" makes it theirs).
      if (!l || l.state !== 'active' || l.origin !== 'capture') continue
      if (r.relation === 'unrelated') {
        if (l.score < reviewBelow) {
          deleteLink(tx, l, now)
          vetoPair(tx, ownerId, l.a_thought_id, l.b_thought_id, 'link', 'model', now)
          unlinked += 1
          continue
        }
        tx.update(thoughtLinks).set({ reviewed_at: now }).where(eq(thoughtLinks.id, l.id)).run()
        continue
      }
      // `revisits` is more specific than "same topic"; a shared person/place/project wins.
      const type = r.relation === 'same_entity' || l.type !== 'revisits' ? r.relation : l.type
      tx.update(thoughtLinks)
        .set({ type, reviewed_at: now, updated_at: now })
        .where(eq(thoughtLinks.id, l.id))
        .run()
      if (type !== l.type) touch(tx, ownerId, 'thought_links', l.id)
    }
  })
  return { reviewed: results.length, unlinked }
}

// --- 3. themes ---

type ThemeRow = typeof themes.$inferSelect

function knownThemes(db: Db, ownerId: string): KnownTheme[] {
  const rows = db.select().from(themes).where(eq(themes.owner_id, ownerId)).all()
  const members = db
    .select({
      theme: themeThoughts.theme_id,
      thought: themeThoughts.thought_id,
      state: themeThoughts.state,
    })
    .from(themeThoughts)
    .where(eq(themeThoughts.owner_id, ownerId))
    .all()
  return rows.map((t) => ({
    id: t.id,
    status: t.status,
    retiredBy: t.retired_by,
    mergedInto: t.merged_into_theme_id,
    // A merged theme matches on what it held before the merge (so the alias can fold it in).
    members: new Set(
      members
        .filter((m) => m.theme === t.id && (m.state === 'active' || t.retired_by === 'merge'))
        .map((m) => m.thought),
    ),
    vetoed: new Set(t.vetoed_thought_ids),
    lastSeenAt: t.last_seen_at,
  }))
}

/** Add `thoughts` to a theme (bringing back a membership an earlier edit removed). */
export function addThemeThoughts(
  db: Db,
  ownerId: string,
  themeId: string,
  members: readonly { id: string; bulletId: string }[],
  now: number,
): void {
  for (const m of members) {
    const existing = db
      .select()
      .from(themeThoughts)
      .where(and(eq(themeThoughts.theme_id, themeId), eq(themeThoughts.thought_id, m.id)))
      .get()
    if (existing?.state === 'active') continue
    if (existing) {
      db.update(themeThoughts)
        .set({ state: 'active', updated_at: now })
        .where(eq(themeThoughts.id, existing.id))
        .run()
      touch(db, ownerId, 'theme_thoughts', existing.id)
      continue
    }
    const id = randomUUID()
    db.insert(themeThoughts)
      .values({
        id,
        owner_id: ownerId,
        theme_id: themeId,
        thought_id: m.id,
        bullet_id: m.bulletId,
        created_at: now,
        updated_at: now,
      })
      .run()
    touch(db, ownerId, 'theme_thoughts', id)
  }
}

/** A theme's thoughts still active (all, or those since `since`). */
export function themeMembers(db: Db, ownerId: string, themeId: string, since = 0): ThoughtInfo[] {
  const ids = new Set(
    db
      .select({ id: themeThoughts.thought_id })
      .from(themeThoughts)
      .where(and(eq(themeThoughts.theme_id, themeId), eq(themeThoughts.state, 'active')))
      .all()
      .map((r) => r.id),
  )
  return activeThoughtInfo(db, ownerId).filter((t) => ids.has(t.id) && t.capturedAt >= since)
}

const asCandidate = (t: ThoughtInfo): ThemeCandidateThought => ({
  id: t.id,
  bulletId: t.bulletId,
  capturedAt: t.capturedAt,
  timezone: t.timezone,
  sensitive: t.sensitive,
})

/** Recount a theme over the window (count, days, first/last, sensitive share). */
export function refreshThemeStats(
  db: Db,
  theme: ThemeRow,
  windowStart: number,
  now: number,
  status: ThemeRow['status'] = theme.status,
): void {
  const members = themeMembers(db, theme.owner_id, theme.id, windowStart).map(asCandidate)
  const s = clusterStats(members)
  const next = {
    status,
    thought_count: s.count,
    day_count: s.days,
    first_seen_at: members.length ? s.firstAt : theme.first_seen_at,
    last_seen_at: members.length ? s.lastAt : theme.last_seen_at,
    sensitive_share: s.sensitiveShare,
  }
  const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== theme[k])
  if (!changed) return
  db.update(themes)
    .set({ ...next, updated_at: now })
    .where(eq(themes.id, theme.id))
    .run()
  touch(db, theme.owner_id, 'themes', theme.id)
  // Crossing the sensitive line shows or hides its memberships and cards on the phone.
  if (isSensitiveTheme(next.sensitive_share) !== isSensitiveTheme(theme.sensitive_share)) {
    for (const m of db
      .select({ id: themeThoughts.id })
      .from(themeThoughts)
      .where(eq(themeThoughts.theme_id, theme.id))
      .all()) {
      touch(db, theme.owner_id, 'theme_thoughts', m.id)
    }
    for (const c of db
      .select({ id: noticedCards.id })
      .from(noticedCards)
      .where(eq(noticedCards.theme_id, theme.id))
      .all()) {
      touch(db, theme.owner_id, 'noticed_cards', c.id)
    }
  }
}

function updateThemes(
  deps: NightlyDeps,
  ownerId: string,
  windowStart: number,
  now: number,
): { active: number; created: number } {
  return deps.db.transaction((tx) => {
    const recent = activeThoughtInfo(tx, ownerId).filter(
      (t) => t.capturedAt >= windowStart && t.capturedAt <= now,
    )
    const ids = new Set(recent.map((t) => t.id))
    const links = tx
      .select({ a: thoughtLinks.a_thought_id, b: thoughtLinks.b_thought_id })
      .from(thoughtLinks)
      .where(and(eq(thoughtLinks.owner_id, ownerId), eq(thoughtLinks.state, 'active')))
      .all()
    const neighbourMap = new Map<string, string[]>()
    for (const l of links) {
      neighbourMap.set(l.a, [...(neighbourMap.get(l.a) ?? []), l.b])
      neighbourMap.set(l.b, [...(neighbourMap.get(l.b) ?? []), l.a])
    }
    const inWindow = links
      .filter((e) => ids.has(e.a) && ids.has(e.b))
      .map((e) => [e.a, e.b] as const)
    // Similarity over the window (uncapped), the links themselves, minus vetoed pairs.
    const vectors =
      deps.embedder && deps.profile
        ? comparableVectors(tx, ownerId, deps.embedder.key, deps.profile.centre)
        : new Map<string, Float32Array>()
    const vetoed = vetoedPairs(tx, ownerId, 'link')
    const edges = deps.profile
      ? similarityEdges(
          recent.map((t) => ({
            id: t.id,
            vector: vectors.get(t.id) ?? null,
            entities: t.entities,
          })),
          deps.profile.thresholds,
          (a, b) => hasPair(vetoed, a, b),
          inWindow,
        )
      : inWindow
    const clusters = clusterThoughts(recent.map(asCandidate), edges)
    const active = pickActive(
      matchClusters(clusters, knownThemes(tx, ownerId), (id) => neighbourMap.get(id) ?? []),
    )
    const keep = new Set<string>()
    let created = 0
    for (const a of active) {
      let themeId = a.themeId
      if (themeId === null) {
        themeId = randomUUID()
        tx.insert(themes)
          .values({
            id: themeId,
            owner_id: ownerId,
            status: 'active',
            first_seen_at: a.stats.firstAt,
            last_seen_at: a.stats.lastAt,
            created_at: now,
            updated_at: now,
          })
          .run()
        touch(tx, ownerId, 'themes', themeId)
        created += 1
      }
      keep.add(themeId)
      addThemeThoughts(tx, ownerId, themeId, a.members, now)
    }
    for (const t of tx
      .select()
      .from(themes)
      .where(and(eq(themes.owner_id, ownerId), ne(themes.status, 'retired')))
      .all()) {
      refreshThemeStats(tx, t, windowStart, now, keep.has(t.id) ? 'active' : 'dormant')
    }
    return { active: keep.size, created }
  })
}

// --- 4. names ---

async function nameThemes(
  deps: NightlyDeps,
  ownerId: string,
  windowStart: number,
): Promise<number> {
  const { db } = deps
  const unnamed = db
    .select()
    .from(themes)
    .where(
      and(eq(themes.owner_id, ownerId), eq(themes.status, 'active'), isNull(themes.model_name)),
    )
    .all()
    .filter((t) => !isSensitiveTheme(t.sensitive_share))
  let named = 0
  for (const t of unnamed) {
    const notes = themeMembers(db, ownerId, t.id, windowStart)
      .filter((m) => !m.sensitive)
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .map((m) => m.text)
    const name = await nameTheme({ llm: deps.llm, config: deps.engine }, notes)
    if (!name) continue
    const now = deps.now()
    db.update(themes)
      .set({ model_name: name, updated_at: now })
      .where(and(eq(themes.id, t.id), isNull(themes.model_name)))
      .run()
    touch(db, ownerId, 'themes', t.id)
    named += 1
  }
  return named
}

// --- 5. Noticed ---

/** The longest headline quote (characters). */
const HEADLINE_QUOTE_CHARS = 60

/** Unopened cards older than 14 days retire. Returns how many. */
export function retireStaleCards(db: Db, ownerId: string, now: number): number {
  const stale = db
    .select({ id: noticedCards.id })
    .from(noticedCards)
    .where(
      and(
        eq(noticedCards.owner_id, ownerId),
        eq(noticedCards.state, 'active'),
        eq(noticedCards.status, 'new'),
        lte(noticedCards.created_at, now - CONNECTION_RULES.cardRetireMs),
      ),
    )
    .all()
  for (const c of stale) {
    db.update(noticedCards)
      .set({ status: 'retired', resolved_at: now, updated_at: now })
      .where(eq(noticedCards.id, c.id))
      .run()
    touch(db, ownerId, 'noticed_cards', c.id)
  }
  return stale.length
}

/** Withdraw a theme's unopened cards (it was retired or merged away). */
export function withdrawNewCards(db: Db, ownerId: string, themeId: string, now: number): void {
  for (const c of db
    .select({ id: noticedCards.id })
    .from(noticedCards)
    .where(
      and(
        eq(noticedCards.theme_id, themeId),
        eq(noticedCards.state, 'active'),
        eq(noticedCards.status, 'new'),
      ),
    )
    .all()) {
    db.update(noticedCards)
      .set({ status: 'retired', resolved_at: now, updated_at: now })
      .where(eq(noticedCards.id, c.id))
      .run()
    touch(db, ownerId, 'noticed_cards', c.id)
  }
}

function writeNoticed(
  deps: NightlyDeps,
  ownerId: string,
  windowStart: number,
): { created: number; retired: number } {
  const { db } = deps
  const now = deps.now()
  const vectors = deps.embedder ? loadEmbeddings(db, ownerId, deps.embedder.key) : new Map()
  return db.transaction((tx) => {
    const retired = retireStaleCards(tx, ownerId, now)
    const countSince = (since: number) =>
      tx
        .select({ n: sql<number>`count(*)` })
        .from(noticedCards)
        .where(and(eq(noticedCards.owner_id, ownerId), gt(noticedCards.created_at, since)))
        .get()?.n ?? 0
    const candidates = tx
      .select()
      .from(themes)
      .where(and(eq(themes.owner_id, ownerId), eq(themes.status, 'active')))
      .orderBy(desc(themes.thought_count), desc(themes.last_seen_at))
      .all()
      .filter((t) => !isSensitiveTheme(t.sensitive_share))
    let created = 0
    for (const t of candidates) {
      if (countSince(now - DAY_MS) >= CONNECTION_RULES.maxCardsPerDay) break
      const recentCard = tx
        .select({ id: noticedCards.id })
        .from(noticedCards)
        .where(
          and(
            eq(noticedCards.theme_id, t.id),
            gt(noticedCards.created_at, now - CONNECTION_RULES.cardEveryMs),
          ),
        )
        .get()
      if (recentCard) continue
      const members = themeMembers(tx, ownerId, t.id, windowStart).filter((m) => !m.sensitive)
      const picked = pickQuotes(
        members.map((m) => ({
          id: m.id,
          bulletId: m.bulletId,
          text: m.text,
          capturedAt: m.capturedAt,
          sensitive: m.sensitive,
          vector: (vectors.get(m.id) as Float32Array | undefined) ?? null,
        })),
      )
      if (!picked || members.length === 0) continue
      const count = members.length
      const days = daySpan(members.map(asCandidate))
      const quotes: NoticedQuote[] = picked.quotes.map((q) => ({
        thought_id: q.id,
        bullet_id: q.bulletId,
        text: shortQuote(q.text, 120),
      }))
      const id = randomUUID()
      tx.insert(noticedCards)
        .values({
          id,
          owner_id: ownerId,
          theme_id: t.id,
          headline: noticedHeadline(
            shortQuote(picked.headline.text, HEADLINE_QUOTE_CHARS),
            count,
            days,
          ),
          quotes,
          count,
          days,
          status: 'new',
          opened_at: null,
          resolved_at: null,
          created_at: now,
          updated_at: now,
        })
        .run()
      touch(tx, ownerId, 'noticed_cards', id)
      created += 1
    }
    return { created, retired }
  })
}

/** Follow a theme's merge aliases to the theme it lives in now. */
export function survivorOf(db: Db, themeId: string): string {
  let id = themeId
  for (let hops = 0; hops < 20; hops++) {
    const alias = db
      .select({ to: themeAliases.survivor_theme_id })
      .from(themeAliases)
      .where(eq(themeAliases.alias_theme_id, id))
      .get()
    if (!alias) return id
    id = alias.to
  }
  return id
}
