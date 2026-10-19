/**
 * The `link` job (slice 3): one per capture, queued in the transaction that stores its
 * extraction and run by the worker right after extraction jobs (before reflect jobs), so links
 * show within moments of `processed`. It:
 *
 *  1. embeds the capture's thoughts (the embedder call happens outside any transaction);
 *  2. plans links against every other capture's thoughts (`planLinks`: 10 nearest, thresholds of
 *     the embedding profile, vetoes respected, at most 5 links per thought);
 *  3. asks the live model "does this answer it?" for close open loops; a yes links them
 *     (`answers`) and proposes closing the loop: ONE `thought_resolve` suggestion, tier `suggest`
 *     (never for a sensitive answer, a loop closed already, or a pair the user dismissed);
 *  4. may ask "Is this the same thing?" about a pair just under the link threshold, only when the
 *     capture gets no other reflective question (it waits for the capture's reflect job).
 *
 * A failed embedder or model call retries with backoff; on the last attempt an unanswered loop
 * check counts as "unsure" so the links are still made.
 */

import { randomUUID } from 'node:crypto'
import {
  CONNECTION_OPTIONS,
  CONNECTION_THOUGHT_KINDS,
  connectionQuestionText,
  type ThoughtKind,
} from '@bullet/core'
import {
  answerCheck,
  type AnswerVerdict,
  capLinks,
  centre,
  type EmbeddingProfile,
  type Embedder,
  type EngineConfig,
  type LinkableThought,
  type LinkProposal,
  type LlmClient,
  planLinks,
  quoteLanguage,
  sharedEntity,
} from '@bullet/engine'
import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, linkJobs, questions, reflectJobs, suggestions } from '../db/schema'
import { type BulletRow, DEFAULT_RETRY_POLICY, type RetryPolicy, retryDelay } from '../queue/jobs'
import { createReflectiveQuestion, refusalNow } from '../reflect/questions'
import { touch } from '../sync/changes'
import {
  activeLinks,
  activeThoughtInfo,
  corpusMean,
  ensureBaseline,
  ensureEmbedded,
  hasPair,
  isVetoed,
  linkBetween,
  linkCount,
  loadEmbeddings,
  pairOf,
  pendingResolveFor,
  proposedBefore,
  setLinkType,
  type ThoughtInfo,
  thoughtInfo,
  touchLinksOf,
  upsertLink,
  vetoedPairs,
} from './store'

export type LinkJobRow = typeof linkJobs.$inferSelect

/** At most this many earlier thoughts embedded on the side per job (a model change is nightly). */
const MAX_BACKFILL = 64

/** Queue (or re-queue) a capture's link job: in the transaction that stores its extraction. */
export function queueLinkJob(db: Db, bullet: BulletRow, now: number): void {
  db.insert(linkJobs)
    .values({
      bullet_id: bullet.id,
      owner_id: bullet.owner_id,
      status: 'queued',
      attempts: 0,
      text_version: bullet.text_version,
      run_after: now,
      pending_question: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: linkJobs.bullet_id,
      set: {
        status: 'queued',
        attempts: 0,
        text_version: bullet.text_version,
        run_after: now,
        locked_at: null,
        last_error: null,
        pending_question: null,
        updated_at: now,
      },
    })
    .run()
}

export function cancelLinkJob(db: Db, bulletId: string, now: number): void {
  db.update(linkJobs)
    .set({ status: 'cancelled', pending_question: null, updated_at: now })
    .where(and(eq(linkJobs.bullet_id, bulletId), inArray(linkJobs.status, ['queued', 'done'])))
    .run()
}

export interface ClaimedLinkJob {
  job: LinkJobRow
  bullet: BulletRow
}

export function claimNextLinkJob(db: Db, now: number): ClaimedLinkJob | null {
  return db.transaction((tx) => {
    for (;;) {
      const job = tx
        .select()
        .from(linkJobs)
        .where(and(eq(linkJobs.status, 'queued'), lte(linkJobs.run_after, now)))
        .orderBy(asc(linkJobs.run_after), asc(linkJobs.created_at))
        .limit(1)
        .get()
      if (!job) return null
      const bullet = tx.select().from(bullets).where(eq(bullets.id, job.bullet_id)).get()
      if (!bullet || bullet.state !== 'active' || bullet.text_version !== job.text_version) {
        tx.update(linkJobs)
          .set({ status: 'cancelled', updated_at: now })
          .where(eq(linkJobs.bullet_id, job.bullet_id))
          .run()
        continue
      }
      const claimed = {
        ...job,
        status: 'running' as const,
        attempts: job.attempts + 1,
        locked_at: now,
      }
      tx.update(linkJobs)
        .set({ status: 'running', attempts: claimed.attempts, locked_at: now, updated_at: now })
        .where(eq(linkJobs.bullet_id, job.bullet_id))
        .run()
      return { job: claimed, bullet }
    }
  })
}

function isLinkJobCurrent(db: Db, claimed: ClaimedLinkJob): BulletRow | null {
  const job = db.select().from(linkJobs).where(eq(linkJobs.bullet_id, claimed.job.bullet_id)).get()
  const bullet = db.select().from(bullets).where(eq(bullets.id, claimed.job.bullet_id)).get()
  if (!job || !bullet || bullet.state !== 'active') return null
  if (job.status !== 'running' || job.locked_at !== claimed.job.locked_at) return null
  if (job.text_version !== bullet.text_version) return null
  return bullet
}

export interface LinkDeps {
  db: Db
  embedder: Embedder
  profile: EmbeddingProfile
  llm: LlmClient
  engine: EngineConfig
  now: () => number
  retry?: RetryPolicy
}

export interface LinkOutcome {
  status: 'done' | 'stale'
  links: number
  resolves: number
  question: 'asked' | 'deferred' | 'none'
}

const toLinkable = (t: ThoughtInfo, vector: Float32Array): LinkableThought => ({
  id: t.id,
  bulletId: t.bulletId,
  kind: t.kind,
  capturedAt: t.capturedAt,
  entities: t.entities,
  sensitive: t.sensitive,
  neverAsk: t.neverAsk,
  resolved: t.resolvedAt !== null,
  vector,
})

/** Run one claimed link job. Throws when the embedder (or, before the last try, the model) fails. */
export async function runLinkJob(deps: LinkDeps, claimed: ClaimedLinkJob): Promise<LinkOutcome> {
  const { db, embedder, profile } = deps
  const ownerId = claimed.bullet.owner_id
  const none: LinkOutcome = { status: 'done', links: 0, resolves: 0, question: 'none' }
  const fresh = activeThoughtInfo(db, ownerId, claimed.bullet.id)
  if (fresh.length === 0) {
    finishLinkJob(db, claimed.bullet.id, deps.now(), null)
    return none
  }

  // 1. Vectors: this capture's thoughts, plus a few earlier ones that have none yet.
  const all = activeThoughtInfo(db, ownerId)
  let vectors = loadEmbeddings(db, ownerId, embedder.key)
  const missing = all.filter((t) => t.bulletId !== claimed.bullet.id && !vectors.has(t.id))
  await ensureEmbedded(
    db,
    embedder,
    ownerId,
    [...fresh, ...missing.slice(-MAX_BACKFILL)],
    deps.now(),
  )
  const baseline = profile.centre ? await ensureBaseline(db, embedder, deps.now()) : null
  vectors = loadEmbeddings(db, ownerId, embedder.key)
  const mean = profile.centre ? corpusMean(baseline, vectors.values()) : null
  const linkable = (t: ThoughtInfo) => {
    const v = vectors.get(t.id)
    return v ? toLinkable(t, centre(v, mean)) : null
  }
  const freshL = fresh.map(linkable).filter((t): t is LinkableThought => t !== null)
  const pool = all
    .filter((t) => t.bulletId !== claimed.bullet.id)
    .map(linkable)
    .filter((t): t is LinkableThought => t !== null)

  // 2. Plan.
  const linkVetoes = vetoedPairs(db, ownerId, 'link')
  const resolveVetoes = vetoedPairs(db, ownerId, 'resolve')
  const linked = new Set(
    activeLinks(db, ownerId).map((l) => pairOf(l.a_thought_id, l.b_thought_id).join('|')),
  )
  const plan = planLinks({
    fresh: freshL,
    pool,
    thresholds: profile.thresholds,
    vetoed: (a, b) => hasPair(linkVetoes, a, b),
    linked: (a, b) => hasPair(linked, a, b),
  })

  // 3. Open loops: ask the live model (outside any transaction).
  const lastTry = claimed.job.attempts >= (deps.retry ?? DEFAULT_RETRY_POLICY).maxAttempts
  const verdicts: { check: (typeof plan.answerChecks)[number]; verdict: AnswerVerdict }[] = []
  for (const check of plan.answerChecks) {
    if (hasPair(resolveVetoes, check.loop.id, check.answer.id)) continue
    if (proposedBefore(db, ownerId, check.loop.id, claimed.bullet.id)) continue
    if (pendingResolveFor(db, ownerId, check.loop.id).length > 0) continue
    const loopText =
      fresh.find((t) => t.id === check.loop.id)?.text ??
      all.find((t) => t.id === check.loop.id)?.text
    const answerText = fresh.find((t) => t.id === check.answer.id)?.text
    if (!loopText || !answerText) continue
    let verdict: AnswerVerdict
    try {
      verdict = await answerCheck({ llm: deps.llm, config: deps.engine }, loopText, answerText)
    } catch (err) {
      if (!lastTry) throw err
      verdict = 'unsure'
    }
    verdicts.push({ check, verdict })
  }

  // 4. Store, if the capture is still the text this job read.
  const now = deps.now()
  return db.transaction((tx): LinkOutcome => {
    const bullet = isLinkJobCurrent(tx, claimed)
    if (!bullet) return { ...none, status: 'stale' }

    const yes = verdicts.filter((v) => v.verdict === 'yes')
    const proposals: LinkProposal[] = plan.links.map((l) => ({ ...l }))
    for (const { check } of yes) {
      const [a, b] = [check.loop.id, check.answer.id]
      const p = proposals.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))
      if (p) p.type = 'answers'
      else if (!hasPair(linkVetoes, a, b))
        proposals.push({ a, b, type: 'answers', score: check.score })
    }
    // An existing link the answer runs along becomes an `answers` link.
    for (const { check } of yes) {
      const existing = linkBetween(tx, bullet.owner_id, check.loop.id, check.answer.id)
      if (existing?.state === 'active') setLinkType(tx, existing, 'answers', now)
    }
    const byId = new Map([...freshL, ...pool].map((t) => [t.id, t]))
    let links = 0
    const unlinked = proposals.filter(
      (x) => linkBetween(tx, bullet.owner_id, x.a, x.b)?.state !== 'active',
    )
    for (const p of capLinks(unlinked, (id) => linkCount(tx, id))) {
      const a = byId.get(p.a)
      const b = byId.get(p.b)
      if (!a || !b || isVetoed(tx, bullet.owner_id, a.id, b.id, 'link')) continue
      upsertLink(
        tx,
        bullet.owner_id,
        {
          a: { id: a.id, bulletId: a.bulletId },
          b: { id: b.id, bulletId: b.bulletId },
          type: p.type,
          score: p.score,
          origin: 'capture',
        },
        now,
      )
      links += 1
    }

    let resolves = 0
    for (const { check } of yes) {
      if (createThoughtResolve(tx, bullet, check.loop.id, check.answer.id, check.score, now)) {
        resolves += 1
      }
    }

    // The capture's thoughts may have become sensitive: their links are sent again.
    touchLinksOf(
      tx,
      bullet.owner_id,
      fresh.map((t) => t.id),
    )

    // 5. "Is this the same thing?" — only if the capture gets no other question.
    const candidate = plan.questions.find(
      (q) =>
        !linkBetween(tx, bullet.owner_id, q.earlier.id, q.later.id) &&
        !isVetoed(tx, bullet.owner_id, q.earlier.id, q.later.id, 'link'),
    )
    let question: LinkOutcome['question'] = 'none'
    if (candidate) {
      const pending = {
        thought_id: candidate.later.id,
        related_thought_id: candidate.earlier.id,
        score: candidate.score,
      }
      if (reflectPending(tx, bullet.id)) {
        finishLinkJob(tx, bullet.id, now, pending)
        return { status: 'done', links, resolves, question: 'deferred' }
      }
      question = askConnectionQuestion(
        tx,
        bullet,
        pending.thought_id,
        pending.related_thought_id,
        now,
      )
        ? 'asked'
        : 'none'
    }
    finishLinkJob(tx, bullet.id, now, null)
    return { status: 'done', links, resolves, question }
  })
}

function finishLinkJob(
  db: Db,
  bulletId: string,
  now: number,
  pendingQuestion: LinkJobRow['pending_question'],
): void {
  db.update(linkJobs)
    .set({
      status: 'done',
      locked_at: null,
      last_error: null,
      pending_question: pendingQuestion,
      updated_at: now,
    })
    .where(eq(linkJobs.bullet_id, bulletId))
    .run()
}

/** Is the capture's reflect job still to run (it may ask the capture's one question)? */
function reflectPending(db: Db, bulletId: string): boolean {
  const job = db
    .select({ status: reflectJobs.status })
    .from(reflectJobs)
    .where(eq(reflectJobs.bullet_id, bulletId))
    .get()
  return job?.status === 'queued' || job?.status === 'running'
}

/**
 * Propose closing `loopId` because `answerId` (a thought of `bullet`) answers it: one
 * `thought_resolve` suggestion at tier `suggest`. Nothing when the loop is closed or gone, either
 * thought is sensitive, the user dismissed this pair, or a proposal for the loop is waiting.
 */
export function createThoughtResolve(
  db: Db,
  bullet: BulletRow,
  loopId: string,
  answerId: string,
  score: number,
  now: number,
): boolean {
  const ownerId = bullet.owner_id
  const loop = thoughtInfo(db, ownerId, loopId)
  const answer = thoughtInfo(db, ownerId, answerId)
  if (!loop || !answer || answer.bulletId !== bullet.id) return false
  if (loop.resolvedAt !== null || loop.sensitive || answer.sensitive) return false
  if (loop.kind !== 'to_check' && loop.kind !== 'question') return false
  if (isVetoed(db, ownerId, loopId, answerId, 'resolve')) return false
  if (proposedBefore(db, ownerId, loopId, bullet.id)) return false
  if (pendingResolveFor(db, ownerId, loopId).length > 0) return false
  const id = randomUUID()
  db.insert(suggestions)
    .values({
      id,
      owner_id: ownerId,
      source_bullet_id: bullet.id,
      source_thought_id: answerId,
      target_kind: 'thought_resolve',
      operation: 'update',
      target_id: loopId,
      payload: { thought_id: loopId, resolved_by_bullet_id: bullet.id },
      confidence: Math.max(0, Math.min(1, score)),
      tier: 'suggest',
      status: 'pending',
      resolved_at: null,
      applied_entity_id: null,
      applied_at: null,
      auto_applied: false,
      applied_before: null,
      applied_after: null,
      created_at: now,
      updated_at: now,
    })
    .run()
  touch(db, ownerId, 'suggestions', id)
  return true
}

const askable = (t: ThoughtInfo) =>
  !t.sensitive &&
  !t.neverAsk &&
  (CONNECTION_THOUGHT_KINDS as readonly ThoughtKind[]).includes(t.kind)

/**
 * Ask "Is this the same thing? «earlier» / «later»" for a thought of `bullet` and an earlier
 * thought, when everything still allows it: the capture has no reflective question of its own
 * (one per capture, whatever the origin), answers none, has no sensitive thought; both thoughts
 * are askable; the pair is neither linked nor vetoed; and the slice 2 limits allow a new one.
 */
export function askConnectionQuestion(
  db: Db,
  bullet: BulletRow,
  thoughtId: string,
  relatedId: string,
  now: number,
): boolean {
  const ownerId = bullet.owner_id
  if (bullet.state !== 'active') return false
  if (bullet.answers_question_id !== null) {
    const answered = db
      .select({ kind: questions.kind })
      .from(questions)
      .where(eq(questions.id, bullet.answers_question_id))
      .get()
    if (answered?.kind === 'reflective') return false
  }
  const own = db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.source_bullet_id, bullet.id),
        eq(questions.kind, 'reflective'),
        inArray(questions.origin, ['capture', 'connection']),
        eq(questions.state, 'active'),
      ),
    )
    .get()
  if (own) return false
  const capture = activeThoughtInfo(db, ownerId, bullet.id)
  if (capture.some((t) => t.sensitive)) return false
  const later = capture.find((t) => t.id === thoughtId)
  const earlier = thoughtInfo(db, ownerId, relatedId)
  if (!later || !earlier || !askable(later) || !askable(earlier)) return false
  const link = linkBetween(db, ownerId, later.id, earlier.id)
  if (link?.state === 'active' || isVetoed(db, ownerId, later.id, earlier.id, 'link')) return false
  if (refusalNow(db, ownerId, 'connection', now) !== null) return false
  createReflectiveQuestion(
    db,
    {
      ownerId,
      origin: 'connection',
      text: connectionQuestionText(earlier.text, later.text, quoteLanguage(later.text)),
      sourceBulletId: bullet.id,
      sourceThoughtId: later.id,
      relatedThoughtId: earlier.id,
      options: [...CONNECTION_OPTIONS],
    },
    now,
  )
  return true
}

/**
 * The capture's reflect job is over without a question of its own: a connection question the
 * link job held back may now take the slot. Called in the reflect job's final transaction.
 */
export function askDeferredConnectionQuestion(db: Db, bulletId: string, now: number): boolean {
  const job = db.select().from(linkJobs).where(eq(linkJobs.bullet_id, bulletId)).get()
  const pending = job?.pending_question
  if (!job || !pending || job.status !== 'done') return false
  db.update(linkJobs)
    .set({ pending_question: null, updated_at: now })
    .where(eq(linkJobs.bullet_id, bulletId))
    .run()
  const bullet = db.select().from(bullets).where(eq(bullets.id, bulletId)).get()
  if (!bullet || bullet.text_version !== job.text_version) return false
  return askConnectionQuestion(db, bullet, pending.thought_id, pending.related_thought_id, now)
}

/** A failed embedder/model call: retry later with backoff, or give up quietly. */
export function markLinkJobFailed(
  db: Db,
  claimed: ClaimedLinkJob,
  err: unknown,
  now: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): 'retry' | 'failed' | 'stale' {
  return db.transaction((tx) => {
    if (!isLinkJobCurrent(tx, claimed)) return 'stale'
    const giveUp = claimed.job.attempts >= policy.maxAttempts
    tx.update(linkJobs)
      .set({
        status: giveUp ? 'failed' : 'queued',
        run_after: giveUp ? claimed.job.run_after : now + retryDelay(claimed.job.attempts, policy),
        locked_at: null,
        last_error: err instanceof Error ? err.message : String(err),
        updated_at: now,
      })
      .where(eq(linkJobs.bullet_id, claimed.job.bullet_id))
      .run()
    return giveUp ? 'failed' : 'retry'
  })
}

export function recoverStuckLinkJobs(db: Db, now: number): number {
  return db
    .update(linkJobs)
    .set({ status: 'queued', locked_at: null, run_after: now, updated_at: now })
    .where(eq(linkJobs.status, 'running'))
    .run().changes
}

/** "Same thing" on a connection question: link the two thoughts (the user's link, no cap). */
export function linkByUser(db: Db, ownerId: string, x: string, y: string, now: number): boolean {
  const a = thoughtInfo(db, ownerId, x)
  const b = thoughtInfo(db, ownerId, y)
  if (!a || !b) return false
  const [earlier, later] = a.capturedAt <= b.capturedAt ? [a, b] : [b, a]
  upsertLink(
    db,
    ownerId,
    {
      a: { id: earlier.id, bulletId: earlier.bulletId },
      b: { id: later.id, bulletId: later.bulletId },
      type: sharedEntity(earlier.entities, later.entities) ? 'same_entity' : 'same_topic',
      score: 1,
      origin: 'user',
    },
    now,
  )
  return true
}
