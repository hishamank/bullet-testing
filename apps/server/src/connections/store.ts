/**
 * Connections on the server: thought embeddings, links, vetoes. Plain functions over a Db or a
 * transaction; every write to a synced row (links, theme memberships, questions, suggestions)
 * calls `touch()` in the same transaction.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { LinkType } from '@bullet/core'
import {
  centre,
  combineMeans,
  decodeVector,
  EMBED_BACKGROUND_SENTENCES,
  type Embedder,
  encodeVector,
  meanOf,
  normalize,
  type Vector,
  type VectorMean,
} from '@bullet/engine'
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  bullets,
  embeddingBaselines,
  linkVetoes,
  noticedCards,
  questions,
  suggestions,
  themeThoughts,
  thoughtEmbeddings,
  thoughtLinks,
  thoughts,
} from '../db/schema'
import { touch } from '../sync/changes'

export type LinkRow = typeof thoughtLinks.$inferSelect
export type VetoScope = 'link' | 'resolve'

/** Smaller id first: one row stands for both directions. */
export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])
const pairKey = (x: string, y: string) => pairOf(x, y).join('|')

// --- embeddings ---

export const textHash = (text: string) =>
  createHash('sha256').update(text.normalize('NFC').trim()).digest('hex').slice(0, 32)

/** Every stored vector of the owner under this embedder key, by thought id. */
export function loadEmbeddings(db: Db, ownerId: string, key: string): Map<string, Vector> {
  const rows = db
    .select({ id: thoughtEmbeddings.thought_id, vector: thoughtEmbeddings.vector })
    .from(thoughtEmbeddings)
    .where(and(eq(thoughtEmbeddings.owner_id, ownerId), eq(thoughtEmbeddings.model, key)))
    .all()
  return new Map(rows.map((r) => [r.id, decodeVector(r.vector)]))
}

/**
 * Embed the thoughts that have no vector under the embedder's key, or one made from another
 * text. Returns how many were embedded. The model call happens outside any transaction; vectors
 * are a cache, so writing them is safe whatever else happened meanwhile.
 */
export async function ensureEmbedded(
  db: Db,
  embedder: Embedder,
  ownerId: string,
  items: readonly { id: string; text: string }[],
  now: number,
): Promise<number> {
  if (items.length === 0) return 0
  const have = new Map(
    db
      .select({
        id: thoughtEmbeddings.thought_id,
        model: thoughtEmbeddings.model,
        hash: thoughtEmbeddings.text_hash,
      })
      .from(thoughtEmbeddings)
      .where(
        inArray(
          thoughtEmbeddings.thought_id,
          items.map((i) => i.id),
        ),
      )
      .all()
      .map((r) => [r.id, r]),
  )
  const todo = items.filter((i) => {
    const h = have.get(i.id)
    return !h || h.model !== embedder.key || h.hash !== textHash(i.text)
  })
  if (todo.length === 0) return 0
  const vectors = await embedder.embed(todo.map((t) => t.text))
  db.transaction((tx) => {
    for (const [n, t] of todo.entries()) {
      const v = normalize(vectors[n] ?? [])
      const values = {
        thought_id: t.id,
        owner_id: ownerId,
        model: embedder.key,
        text_hash: textHash(t.text),
        dim: v.length,
        vector: Buffer.from(encodeVector(v)),
        created_at: now,
        updated_at: now,
      }
      tx.insert(thoughtEmbeddings)
        .values(values)
        .onConflictDoUpdate({
          target: thoughtEmbeddings.thought_id,
          set: { ...values, created_at: undefined },
        })
        .run()
    }
  })
  return todo.length
}

/** The background mean for this embedder (embedded once, then read from the database). */
export async function ensureBaseline(db: Db, embedder: Embedder, now: number): Promise<VectorMean> {
  const row = db
    .select()
    .from(embeddingBaselines)
    .where(eq(embeddingBaselines.model, embedder.key))
    .get()
  if (row) return { sum: decodeVector(row.sum), count: row.count }
  const vectors = (await embedder.embed([...EMBED_BACKGROUND_SENTENCES])).map((v) => normalize(v))
  const mean = meanOf(vectors)
  if (!mean) throw new Error('the embedder returned no vectors')
  db.insert(embeddingBaselines)
    .values({
      model: embedder.key,
      dim: mean.sum.length,
      sum: Buffer.from(encodeVector(mean.sum)),
      count: mean.count,
      created_at: now,
    })
    .onConflictDoNothing()
    .run()
  return mean
}

/** The mean to centre on: the background plus the user's own thoughts. */
export function corpusMean(
  baseline: VectorMean | null,
  vectors: Iterable<Vector>,
): VectorMean | null {
  return combineMeans(baseline, meanOf([...vectors]))
}

/**
 * The owner's vectors as similarity reads them: centred on the background + journal mean when the
 * profile says so (the background mean as stored; without it, the journal's alone).
 */
export function comparableVectors(
  db: Db,
  ownerId: string,
  key: string,
  centreThem: boolean,
): Map<string, Vector> {
  const raw = loadEmbeddings(db, ownerId, key)
  if (!centreThem) return raw
  const row = db.select().from(embeddingBaselines).where(eq(embeddingBaselines.model, key)).get()
  const baseline = row ? { sum: decodeVector(row.sum), count: row.count } : null
  const mean = corpusMean(baseline, raw.values())
  return new Map([...raw].map(([id, v]) => [id, centre(v, mean)]))
}

// --- vetoes ---

export function vetoedPairs(db: Db, ownerId: string, scope: VetoScope): Set<string> {
  return new Set(
    db
      .select({ lo: linkVetoes.lo_thought_id, hi: linkVetoes.hi_thought_id })
      .from(linkVetoes)
      .where(and(eq(linkVetoes.owner_id, ownerId), eq(linkVetoes.scope, scope)))
      .all()
      .map((r) => `${r.lo}|${r.hi}`),
  )
}

export const hasPair = (set: ReadonlySet<string>, x: string, y: string) => set.has(pairKey(x, y))

export function isVetoed(db: Db, ownerId: string, x: string, y: string, scope: VetoScope): boolean {
  const [lo, hi] = pairOf(x, y)
  return (
    db
      .select({ lo: linkVetoes.lo_thought_id })
      .from(linkVetoes)
      .where(
        and(
          eq(linkVetoes.owner_id, ownerId),
          eq(linkVetoes.lo_thought_id, lo),
          eq(linkVetoes.hi_thought_id, hi),
          eq(linkVetoes.scope, scope),
        ),
      )
      .get() !== undefined
  )
}

/** Remember that two thoughts are not related (`link`) / that one did not answer the other. */
export function vetoPair(
  db: Db,
  ownerId: string,
  x: string,
  y: string,
  scope: VetoScope,
  source: 'user' | 'model',
  now: number,
): void {
  const [lo, hi] = pairOf(x, y)
  db.insert(linkVetoes)
    .values({
      owner_id: ownerId,
      lo_thought_id: lo,
      hi_thought_id: hi,
      scope,
      source,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [
        linkVetoes.owner_id,
        linkVetoes.lo_thought_id,
        linkVetoes.hi_thought_id,
        linkVetoes.scope,
      ],
      // The user's word outranks a nightly review's.
      set: source === 'user' ? { source } : {},
    })
    .run()
}

/** "Same thing": the user's own link lifts any veto on the pair. */
export function clearVetoes(db: Db, ownerId: string, x: string, y: string): void {
  const [lo, hi] = pairOf(x, y)
  db.delete(linkVetoes)
    .where(
      and(
        eq(linkVetoes.owner_id, ownerId),
        eq(linkVetoes.lo_thought_id, lo),
        eq(linkVetoes.hi_thought_id, hi),
        eq(linkVetoes.scope, 'link'),
      ),
    )
    .run()
}

// --- links ---

const touching = (id: string) =>
  or(eq(thoughtLinks.a_thought_id, id), eq(thoughtLinks.b_thought_id, id))

export function activeLinks(db: Db, ownerId: string): LinkRow[] {
  return db
    .select()
    .from(thoughtLinks)
    .where(and(eq(thoughtLinks.owner_id, ownerId), eq(thoughtLinks.state, 'active')))
    .all()
}

export function linkBetween(db: Db, ownerId: string, x: string, y: string): LinkRow | undefined {
  const [first, second] = pairOf(x, y)
  return db
    .select()
    .from(thoughtLinks)
    .where(
      and(
        eq(thoughtLinks.owner_id, ownerId),
        or(
          and(eq(thoughtLinks.a_thought_id, first), eq(thoughtLinks.b_thought_id, second)),
          and(eq(thoughtLinks.a_thought_id, second), eq(thoughtLinks.b_thought_id, first)),
        ),
      ),
    )
    .get()
}

export function linkCount(db: Db, thoughtId: string): number {
  return db
    .select({ id: thoughtLinks.id })
    .from(thoughtLinks)
    .where(and(touching(thoughtId), eq(thoughtLinks.state, 'active')))
    .all().length
}

export interface NewLink {
  /** The earlier thought and its capture. */
  a: { id: string; bulletId: string }
  b: { id: string; bulletId: string }
  type: LinkType
  score: number
  origin: 'capture' | 'user'
}

/** Create (or bring back) the link between two thoughts. Returns its id. */
export function upsertLink(db: Db, ownerId: string, l: NewLink, now: number): string {
  const existing = linkBetween(db, ownerId, l.a.id, l.b.id)
  if (existing) {
    db.update(thoughtLinks)
      .set({
        state: 'active',
        type: l.type,
        score: Math.max(existing.score, l.score),
        origin: existing.origin === 'user' ? 'user' : l.origin,
        updated_at: now,
      })
      .where(eq(thoughtLinks.id, existing.id))
      .run()
    touch(db, ownerId, 'thought_links', existing.id)
    return existing.id
  }
  const id = randomUUID()
  db.insert(thoughtLinks)
    .values({
      id,
      owner_id: ownerId,
      a_thought_id: l.a.id,
      a_bullet_id: l.a.bulletId,
      b_thought_id: l.b.id,
      b_bullet_id: l.b.bulletId,
      type: l.type,
      score: l.score,
      origin: l.origin,
      reviewed_at: l.origin === 'user' ? now : null,
      created_at: now,
      updated_at: now,
    })
    .run()
  touch(db, ownerId, 'thought_links', id)
  return id
}

export function setLinkType(db: Db, link: LinkRow, type: LinkType, now: number, reviewed = false) {
  db.update(thoughtLinks)
    .set({ type, updated_at: now, ...(reviewed ? { reviewed_at: now } : {}) })
    .where(eq(thoughtLinks.id, link.id))
    .run()
  touch(db, link.owner_id, 'thought_links', link.id)
}

export function deleteLink(db: Db, link: LinkRow, now: number): void {
  if (link.state === 'deleted') return
  db.update(thoughtLinks)
    .set({ state: 'deleted', updated_at: now })
    .where(eq(thoughtLinks.id, link.id))
    .run()
  touch(db, link.owner_id, 'thought_links', link.id)
}

/**
 * Send a thought's links, theme memberships and the cards quoting it again: its sensitivity
 * decides what the phone may keep, and it may have changed with an edit.
 */
export function touchLinksOf(db: Db, ownerId: string, thoughtIds: readonly string[]): void {
  if (thoughtIds.length === 0) return
  for (const m of db
    .select({ id: themeThoughts.id })
    .from(themeThoughts)
    .where(
      and(eq(themeThoughts.owner_id, ownerId), inArray(themeThoughts.thought_id, [...thoughtIds])),
    )
    .all()) {
    touch(db, ownerId, 'theme_thoughts', m.id)
  }
  const ids = new Set(thoughtIds)
  for (const c of db
    .select({ id: noticedCards.id, quotes: noticedCards.quotes })
    .from(noticedCards)
    .where(eq(noticedCards.owner_id, ownerId))
    .all()) {
    if (c.quotes.some((q) => ids.has(q.thought_id))) touch(db, ownerId, 'noticed_cards', c.id)
  }
  for (const l of db
    .select({ id: thoughtLinks.id })
    .from(thoughtLinks)
    .where(
      and(
        eq(thoughtLinks.owner_id, ownerId),
        or(
          inArray(thoughtLinks.a_thought_id, [...thoughtIds]),
          inArray(thoughtLinks.b_thought_id, [...thoughtIds]),
        ),
      ),
    )
    .all()) {
    touch(db, ownerId, 'thought_links', l.id)
  }
}

/**
 * A thought is gone (its capture was deleted, or an edit removed it): its links and theme
 * memberships go, and so do a pending "Did this close it?" and a live connection question about
 * it. Vetoes stay (they are about ids that can never come back anyway).
 */
export function retireConnectionsOfThought(
  db: Db,
  ownerId: string,
  thoughtId: string,
  now: number,
): void {
  for (const l of db
    .select()
    .from(thoughtLinks)
    .where(and(touching(thoughtId), eq(thoughtLinks.state, 'active')))
    .all()) {
    deleteLink(db, l, now)
  }
  for (const m of db
    .select({ id: themeThoughts.id })
    .from(themeThoughts)
    .where(and(eq(themeThoughts.thought_id, thoughtId), eq(themeThoughts.state, 'active')))
    .all()) {
    db.update(themeThoughts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(themeThoughts.id, m.id))
      .run()
    touch(db, ownerId, 'theme_thoughts', m.id)
  }
  for (const s of db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, ownerId),
        eq(suggestions.target_kind, 'thought_resolve'),
        eq(suggestions.status, 'pending'),
        eq(suggestions.state, 'active'),
        or(eq(suggestions.target_id, thoughtId), eq(suggestions.source_thought_id, thoughtId)),
      ),
    )
    .all()) {
    db.update(suggestions)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(suggestions.id, s.id))
      .run()
    touch(db, ownerId, 'suggestions', s.id)
  }
  for (const q of db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.owner_id, ownerId),
        eq(questions.origin, 'connection'),
        eq(questions.state, 'active'),
        inArray(questions.status, ['open', 'snoozed']),
        or(eq(questions.related_thought_id, thoughtId), eq(questions.source_thought_id, thoughtId)),
      ),
    )
    .all()) {
    db.update(questions)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(questions.id, q.id))
      .run()
    touch(db, ownerId, 'questions', q.id)
  }
}

// --- thoughts as the connection code reads them ---

export interface ThoughtInfo {
  id: string
  bulletId: string
  text: string
  kind: (typeof thoughts.$inferSelect)['kind']
  entities: string[]
  sensitive: boolean
  neverAsk: boolean
  resolvedAt: number | null
  capturedAt: number
  timezone: string
}

const thoughtInfoColumns = {
  id: thoughts.id,
  bulletId: thoughts.source_bullet_id,
  text: thoughts.text,
  kind: thoughts.kind,
  entities: thoughts.entities,
  sensitive: thoughts.sensitive,
  neverAsk: thoughts.never_ask,
  resolvedAt: thoughts.resolved_at,
  capturedAt: bullets.captured_at,
  timezone: bullets.timezone,
}

/** Active thoughts of active captures (all of the owner's, or one capture's). */
export function activeThoughtInfo(db: Db, ownerId: string, bulletId?: string): ThoughtInfo[] {
  return db
    .select(thoughtInfoColumns)
    .from(thoughts)
    .innerJoin(bullets, eq(bullets.id, thoughts.source_bullet_id))
    .where(
      and(
        eq(thoughts.owner_id, ownerId),
        eq(thoughts.state, 'active'),
        eq(bullets.state, 'active'),
        ...(bulletId ? [eq(thoughts.source_bullet_id, bulletId)] : []),
      ),
    )
    .all()
}

export function thoughtInfo(db: Db, ownerId: string, id: string): ThoughtInfo | undefined {
  return db
    .select(thoughtInfoColumns)
    .from(thoughts)
    .innerJoin(bullets, eq(bullets.id, thoughts.source_bullet_id))
    .where(
      and(
        eq(thoughts.owner_id, ownerId),
        eq(thoughts.id, id),
        eq(thoughts.state, 'active'),
        eq(bullets.state, 'active'),
      ),
    )
    .get()
}

/** Suggestions of kind `thought_resolve` waiting on this loop (from any capture). */
export function pendingResolveFor(db: Db, ownerId: string, loopId: string) {
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, ownerId),
        eq(suggestions.target_kind, 'thought_resolve'),
        eq(suggestions.target_id, loopId),
        eq(suggestions.status, 'pending'),
        eq(suggestions.state, 'active'),
      ),
    )
    .all()
}

/** Has this capture ever proposed closing this loop (any outcome but withdrawn)? */
export function proposedBefore(db: Db, ownerId: string, loopId: string, bulletId: string): boolean {
  return (
    db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.owner_id, ownerId),
          eq(suggestions.target_kind, 'thought_resolve'),
          eq(suggestions.target_id, loopId),
          eq(suggestions.source_bullet_id, bulletId),
          ne(suggestions.state, 'deleted'),
        ),
      )
      .get() !== undefined
  )
}
