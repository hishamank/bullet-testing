/**
 * Linking a capture's thoughts to earlier ones (slice 3), as pure decisions over vectors the
 * caller has already embedded (and centred, per the embedding profile):
 *
 *  - candidates are each new thought's `candidates` (10) nearest thoughts from other captures;
 *  - link at `link` (0.80 on a dedicated model), or `linkSharedEntity` (0.75) when both name the
 *    same person, place or project (`same_entity`); a later question or idea that restates an
 *    earlier one of the same kind `revisits` it; anything else is `same_topic`;
 *  - an earlier OPEN LOOP (`to_check` / `question`, unresolved) at `answerCheck` (0.70) or more
 *    gets a yes/no/unsure "does this answer it?" check by the live model ({@link answerCheck});
 *  - a pair between `connectionQuestion` (0.65) and the link threshold, both worries, things to
 *    check, self-questions or ideas, may become "Is this the same thing?";
 *  - at most `maxLinksPerThought` (5) links per thought, answers first, then the closest. Anything
 *    below a threshold is dropped, never queued; vetoed pairs never link.
 *
 * Sensitive thoughts are linked like any other (they never leave their own capture: the server
 * keeps such links off the phone), but never take part in an answer check or a question.
 */

import {
  CONNECTION_RULES,
  CONNECTION_THOUGHT_KINDS,
  type LinkType,
  RESOLVABLE_THOUGHT_KINDS,
  type ThoughtKind,
} from '@bullet/core'
import { sharedEntity } from './entities'
import type { LinkThresholds } from './profile'
import { topK, type Vector } from './vector'

export interface LinkableThought {
  id: string
  bulletId: string
  kind: ThoughtKind
  /** The capture's time. */
  capturedAt: number
  /** Named people, places, projects (from segmentation). */
  entities: readonly string[]
  sensitive: boolean
  neverAsk: boolean
  /** Open loops only: closed already (by hand, a note or an accepted answer). */
  resolved: boolean
  /** Unit vector, centred when the profile says so. */
  vector: Vector
}

export interface LinkProposal {
  /** The earlier thought. */
  a: string
  /** The new thought. */
  b: string
  type: LinkType
  score: number
}

export interface AnswerCheck {
  loop: LinkableThought
  answer: LinkableThought
  score: number
}

export interface QuestionCandidate {
  earlier: LinkableThought
  later: LinkableThought
  score: number
}

export interface LinkPlan {
  /** At or above threshold, not vetoed, not linked yet; best first (uncapped). */
  links: LinkProposal[]
  /** Open loops to check with the model; best first, one per loop. */
  answerChecks: AnswerCheck[]
  /** Pairs that may become a connection question; best first. */
  questions: QuestionCandidate[]
}

export interface PlanLinksInput {
  /** The capture's thoughts. */
  fresh: readonly LinkableThought[]
  /** Other captures' thoughts. */
  pool: readonly LinkableThought[]
  thresholds: LinkThresholds
  /** True for a pair the user (or a nightly review) said is not related. */
  vetoed: (a: string, b: string) => boolean
  /** True for a pair already linked. */
  linked: (a: string, b: string) => boolean
  /** Nearest thoughts considered per new thought. Default 10. */
  candidates?: number
  /** Answer checks per capture (each is a model call). Default 3. */
  maxAnswerChecks?: number
}

const isLoop = (k: ThoughtKind) => (RESOLVABLE_THOUGHT_KINDS as readonly ThoughtKind[]).includes(k)
const askable = (t: LinkableThought) =>
  !t.sensitive &&
  !t.neverAsk &&
  (CONNECTION_THOUGHT_KINDS as readonly ThoughtKind[]).includes(t.kind)
/** Kinds that restate rather than relate: a self-question asked again, an idea had again. */
const RESTATABLE: readonly ThoughtKind[] = ['question', 'idea', 'to_check']

/** What kind of link two thoughts close enough to link have. */
export function linkTypeFor(earlier: LinkableThought, later: LinkableThought): LinkType {
  if (sharedEntity(earlier.entities, later.entities)) return 'same_entity'
  if (earlier.kind === later.kind && RESTATABLE.includes(later.kind)) return 'revisits'
  return 'same_topic'
}

/** The earlier of two thoughts (capture time, then id for a tie). */
function order(x: LinkableThought, y: LinkableThought): [LinkableThought, LinkableThought] {
  if (x.capturedAt !== y.capturedAt) return x.capturedAt < y.capturedAt ? [x, y] : [y, x]
  return x.id < y.id ? [x, y] : [y, x]
}

export function planLinks(input: PlanLinksInput): LinkPlan {
  const th = input.thresholds
  const k = input.candidates ?? CONNECTION_RULES.candidates
  const links: LinkProposal[] = []
  const checks = new Map<string, AnswerCheck>()
  const questions: QuestionCandidate[] = []
  const seen = new Set<string>()

  for (const f of input.fresh) {
    const others = input.pool.filter((p) => p.bulletId !== f.bulletId && p.id !== f.id)
    for (const { item: c, score } of topK(f.vector, others, (t) => t.vector, k)) {
      const [earlier, later] = order(c, f)
      const key = `${earlier.id}|${later.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (input.vetoed(earlier.id, later.id)) continue
      const shared = sharedEntity(earlier.entities, later.entities)
      const threshold = shared ? th.linkSharedEntity : th.link
      const linked = input.linked(earlier.id, later.id)

      // Does the new thought answer an earlier open loop?
      if (
        score >= th.answerCheck &&
        isLoop(c.kind) &&
        !c.resolved &&
        c.capturedAt < f.capturedAt &&
        !isLoop(f.kind) &&
        !c.sensitive &&
        !f.sensitive
      ) {
        const prev = checks.get(c.id)
        if (!prev || prev.score < score) checks.set(c.id, { loop: c, answer: f, score })
      }
      if (linked) continue
      if (score >= threshold) {
        links.push({ a: earlier.id, b: later.id, type: linkTypeFor(earlier, later), score })
      } else if (score >= th.connectionQuestion && askable(earlier) && askable(later)) {
        questions.push({ earlier, later, score })
      }
    }
  }

  const byScore = <T extends { score: number }>(xs: T[]) => xs.sort((a, b) => b.score - a.score)
  return {
    links: byScore(links),
    answerChecks: byScore([...checks.values()]).slice(0, input.maxAnswerChecks ?? 3),
    questions: byScore(questions),
  }
}

/**
 * Keep at most `max` links per thought, counting the links each already has: `answers` links
 * first, then the closest pairs. Returns the links to create.
 */
export function capLinks(
  proposals: readonly LinkProposal[],
  existingCount: (thoughtId: string) => number,
  max: number = CONNECTION_RULES.maxLinksPerThought,
): LinkProposal[] {
  const count = new Map<string, number>()
  const used = (id: string) => count.get(id) ?? existingCount(id)
  const ordered = [...proposals].sort(
    (x, y) => Number(y.type === 'answers') - Number(x.type === 'answers') || y.score - x.score,
  )
  const kept: LinkProposal[] = []
  for (const p of ordered) {
    if (used(p.a) >= max || used(p.b) >= max) continue
    count.set(p.a, used(p.a) + 1)
    count.set(p.b, used(p.b) + 1)
    kept.push(p)
  }
  return kept
}
