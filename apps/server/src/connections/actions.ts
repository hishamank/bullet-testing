/**
 * The user's corrections of connections (push ops). Each is remembered: nothing re-creates what
 * the user took back, not a nightly run, an edit or re-processing.
 *
 *  - `link.veto`       — "Not related": the link goes and the pair is vetoed (both directions).
 *  - `theme.rename`    — the user's name shows from now on (the model's is kept, unseen).
 *  - `theme.retire`    — "Not a theme": retired, never re-created from mostly the same thoughts,
 *                        its unopened cards withdrawn; its links stay.
 *  - `theme.merge`     — its thoughts move to the survivor, it is retired with an alias, and later
 *                        matches of it fold into the survivor.
 *  - `noticed.open` / `noticed.dismiss`.
 *  - a connection question's "Same thing" / "Different" (`question.answer`).
 */

import { CONNECTION_RULES } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { noticedCards, themeAliases, themes, themeThoughts, thoughtLinks } from '../db/schema'
import { ApplyError } from '../apply/apply'
import { touch } from '../sync/changes'
import { linkByUser } from './link-job'
import { addThemeThoughts, refreshThemeStats, withdrawNewCards } from './nightly'
import { clearVetoes, deleteLink, linkBetween, vetoPair } from './store'

export function vetoLink(
  db: Db,
  ownerId: string,
  linkId: string,
  now: number,
): 'applied' | 'duplicate' {
  const link = db
    .select()
    .from(thoughtLinks)
    .where(and(eq(thoughtLinks.id, linkId), eq(thoughtLinks.owner_id, ownerId)))
    .get()
  if (!link) throw new ApplyError('not_found', `link ${linkId} not found`)
  vetoPair(db, ownerId, link.a_thought_id, link.b_thought_id, 'link', 'user', now)
  if (link.state === 'deleted') return 'duplicate'
  deleteLink(db, link, now)
  return 'applied'
}

function getTheme(db: Db, ownerId: string, id: string) {
  const t = db
    .select()
    .from(themes)
    .where(and(eq(themes.id, id), eq(themes.owner_id, ownerId)))
    .get()
  if (!t) throw new ApplyError('not_found', `theme ${id} not found`)
  return t
}

export function renameTheme(db: Db, ownerId: string, id: string, name: string, now: number): void {
  const t = getTheme(db, ownerId, id)
  if (t.state !== 'active' || t.status === 'retired') {
    throw new ApplyError('invalid', 'the theme was retired')
  }
  const clean = name.trim().replace(/\s+/g, ' ')
  if (clean === '') throw new ApplyError('invalid', 'a theme name cannot be empty')
  if (clean === t.user_name) return
  db.update(themes).set({ user_name: clean, updated_at: now }).where(eq(themes.id, t.id)).run()
  touch(db, ownerId, 'themes', t.id)
}

/** Stop showing a theme's thoughts as part of it (retired or merged away). */
function releaseMembers(db: Db, ownerId: string, themeId: string, now: number): string[] {
  const rows = db
    .select()
    .from(themeThoughts)
    .where(and(eq(themeThoughts.theme_id, themeId), eq(themeThoughts.state, 'active')))
    .all()
  for (const r of rows) {
    db.update(themeThoughts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(themeThoughts.id, r.id))
      .run()
    touch(db, ownerId, 'theme_thoughts', r.id)
  }
  return rows.map((r) => r.thought_id)
}

export function retireTheme(
  db: Db,
  ownerId: string,
  id: string,
  now: number,
): 'applied' | 'duplicate' {
  const t = getTheme(db, ownerId, id)
  if (t.status === 'retired' && t.retired_by === 'user') return 'duplicate'
  if (t.status === 'retired') throw new ApplyError('invalid', 'the theme was merged into another')
  const held = releaseMembers(db, ownerId, t.id, now)
  db.update(themes)
    .set({
      status: 'retired',
      retired_by: 'user',
      vetoed_thought_ids: [...new Set([...t.vetoed_thought_ids, ...held])],
      updated_at: now,
    })
    .where(eq(themes.id, t.id))
    .run()
  touch(db, ownerId, 'themes', t.id)
  withdrawNewCards(db, ownerId, t.id, now)
  return 'applied'
}

export function mergeTheme(
  db: Db,
  ownerId: string,
  id: string,
  intoId: string,
  now: number,
): 'applied' | 'duplicate' {
  if (id === intoId) throw new ApplyError('invalid', 'a theme cannot merge into itself')
  const from = getTheme(db, ownerId, id)
  const into = getTheme(db, ownerId, intoId)
  if (from.status === 'retired' && from.merged_into_theme_id === intoId) return 'duplicate'
  if (from.status === 'retired' || into.status === 'retired' || into.state !== 'active') {
    throw new ApplyError('invalid', 'only themes still showing can be merged')
  }
  const moved = db
    .select()
    .from(themeThoughts)
    .where(and(eq(themeThoughts.theme_id, from.id), eq(themeThoughts.state, 'active')))
    .all()
  releaseMembers(db, ownerId, from.id, now)
  addThemeThoughts(
    db,
    ownerId,
    into.id,
    moved.map((m) => ({ id: m.thought_id, bulletId: m.bullet_id })),
    now,
  )
  db.update(themes)
    .set({ status: 'retired', retired_by: 'merge', merged_into_theme_id: into.id, updated_at: now })
    .where(eq(themes.id, from.id))
    .run()
  touch(db, ownerId, 'themes', from.id)
  db.insert(themeAliases)
    .values({
      alias_theme_id: from.id,
      owner_id: ownerId,
      survivor_theme_id: into.id,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: themeAliases.alias_theme_id,
      set: { survivor_theme_id: into.id },
    })
    .run()
  withdrawNewCards(db, ownerId, from.id, now)
  refreshThemeStats(db, into, now - CONNECTION_RULES.windowMs, now, 'active')
  return 'applied'
}

function getCard(db: Db, ownerId: string, id: string) {
  const c = db
    .select()
    .from(noticedCards)
    .where(and(eq(noticedCards.id, id), eq(noticedCards.owner_id, ownerId)))
    .get()
  if (!c) throw new ApplyError('not_found', `card ${id} not found`)
  return c
}

export function openCard(
  db: Db,
  ownerId: string,
  id: string,
  now: number,
): 'applied' | 'duplicate' {
  const c = getCard(db, ownerId, id)
  if (c.status !== 'new') return 'duplicate'
  db.update(noticedCards)
    .set({ status: 'opened', opened_at: now, updated_at: now })
    .where(eq(noticedCards.id, c.id))
    .run()
  touch(db, ownerId, 'noticed_cards', c.id)
  return 'applied'
}

export function dismissCard(
  db: Db,
  ownerId: string,
  id: string,
  now: number,
): 'applied' | 'duplicate' {
  const c = getCard(db, ownerId, id)
  if (c.status === 'dismissed' || c.status === 'retired') return 'duplicate'
  db.update(noticedCards)
    .set({ status: 'dismissed', resolved_at: now, updated_at: now })
    .where(eq(noticedCards.id, c.id))
    .run()
  touch(db, ownerId, 'noticed_cards', c.id)
  return 'applied'
}

/**
 * A connection question answered with an option: "Same thing" links the two thoughts (the user's
 * own link, lifting any veto), "Different" vetoes the pair.
 */
export function answerConnection(
  db: Db,
  ownerId: string,
  thoughtId: string | null,
  relatedId: string | null,
  same: boolean,
  now: number,
): void {
  if (thoughtId === null || relatedId === null) {
    throw new ApplyError('invalid', 'the question is not about two thoughts')
  }
  if (same) {
    clearVetoes(db, ownerId, thoughtId, relatedId)
    if (!linkByUser(db, ownerId, thoughtId, relatedId, now)) {
      throw new ApplyError('conflict', 'one of the thoughts is gone')
    }
    return
  }
  vetoPair(db, ownerId, thoughtId, relatedId, 'link', 'user', now)
  const link = linkBetween(db, ownerId, thoughtId, relatedId)
  if (link) deleteLink(db, link, now)
}
