import {
  CONNECTION_RULES,
  connectionQuestionText,
  NOTICED_DENYLIST,
  noticedHeadline,
  shortQuote,
  usesDeniedWord,
} from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import { EngineError } from '../errors'
import { createScriptedLlmClient } from '../llm/scripted'
import { createOpenAiCompatibleEmbedder, JOURNAL_NOTE_TEMPLATE } from './embedder'
import { cleanEntities, sharedEntity } from './entities'
import { answerCheck, fallbackThemeName, nameTheme, reviewLink, validThemeName } from './judge'
import { capLinks, type LinkableThought, planLinks } from './links'
import { DEDICATED_PROFILE, LLM_PROFILE, profileForModel } from './profile'
import {
  clusterStats,
  clusterThoughts,
  daySpan,
  type KnownTheme,
  matchClusters,
  pickActive,
  pickQuotes,
  qualifiesAsTheme,
  similarityEdges,
  type ThemeCandidateThought,
} from './themes'
import {
  blendMeans,
  centre,
  cosine,
  decodeVector,
  dot,
  encodeVector,
  meanOf,
  normalize,
  topK,
} from './vector'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1, 9, 0)
const config = ENGINE_CONFIG_DEFAULTS

describe('vectors', () => {
  test('cosine, normalisation and a byte round trip', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0)
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2)
    const v = normalize([3, 4])
    expect([...v]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)])
    const bytes = encodeVector(v)
    // An unaligned copy (as SQLite may hand back) still decodes.
    const shifted = new Uint8Array(bytes.length + 1).subarray(1)
    shifted.set(bytes)
    expect([...decodeVector(shifted)]).toEqual([...v])
  })

  test('centring removes the common direction an LLM puts in every vector', () => {
    const common = [5, 0, 0]
    const a = normalize([5, 1, 0])
    const b = normalize([5, 0, 1])
    expect(dot(a, b)).toBeGreaterThan(0.9)
    const mean = meanOf([normalize(common), a, b])
    expect(dot(centre(a, mean), centre(b, mean))).toBeLessThan(0.1)
  })

  test('top k, best first', () => {
    const q = normalize([1, 0])
    const items = [normalize([0, 1]), normalize([1, 1]), normalize([1, 0.1])]
    expect(topK(q, items, (x) => x, 2).map((s) => s.item)).toEqual([items[2], items[1]])
  })
})

describe('the embedder adapter', () => {
  test('posts to /v1/embeddings in batches with the template, keyed by model and template', async () => {
    const bodies: { model: string; input: string[] }[] = []
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: 'http://127.0.0.1:8082/',
      model: 'qwen3.5-4b',
      template: JOURNAL_NOTE_TEMPLATE,
      batchSize: 2,
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe('http://127.0.0.1:8082/v1/embeddings')
        const body = JSON.parse(init.body as string) as { model: string; input: string[] }
        bodies.push(body)
        // Out of order on purpose: the adapter orders by `index`.
        const data = body.input.map((_, i) => ({ index: i, embedding: [i, 1] })).reverse()
        return new Response(JSON.stringify({ data }), { status: 200 })
      }) as typeof fetch,
    })
    expect(embedder.key).toBe('qwen3.5-4b|journal-eol-v1')
    const out = await embedder.embed(['a', 'b', 'c'])
    expect(out).toEqual([
      [0, 1],
      [1, 1],
      [0, 1],
    ])
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.input[0]).toBe('This journal note : "a" is about, in one word:"')
  })

  test('a server without --embeddings is an EMBED_HTTP error', async () => {
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: 'http://x',
      model: 'm',
      fetch: (async () =>
        new Response('not supported', { status: 501 })) as unknown as typeof fetch,
    })
    await expect(embedder.embed(['a'])).rejects.toMatchObject({ code: 'EMBED_HTTP' })
    await expect(embedder.embed(['a'])).rejects.toBeInstanceOf(EngineError)
  })
})

describe('profiles', () => {
  test('the spec numbers for a dedicated model; calibrated centred ones for an LLM', () => {
    expect(DEDICATED_PROFILE.thresholds).toMatchObject({
      link: 0.8,
      linkSharedEntity: 0.75,
      answerCheck: 0.7,
      connectionQuestion: 0.65,
    })
    expect(profileForModel('nomic-embed-text-v1.5')).toBe(DEDICATED_PROFILE)
    expect(profileForModel('qwen3.5-4b-q4_k_m')).toBe(LLM_PROFILE)
    expect(LLM_PROFILE.centre).toBe(true)
    for (const p of [DEDICATED_PROFILE, LLM_PROFILE]) {
      const t = p.thresholds
      expect(t.connectionQuestion).toBeLessThanOrEqual(t.answerCheck)
      expect(t.answerCheck).toBeLessThan(t.linkSharedEntity)
      expect(t.linkSharedEntity).toBeLessThan(t.link)
    }
  })
})

describe('named entities', () => {
  test('compared loosely; cleaned', () => {
    expect(sharedEntity(['the Hamra flat'], ['Hamra Flat'])).toBe(true)
    expect(sharedEntity(['Karim'], ['karim!'])).toBe(true)
    expect(sharedEntity(['Karim'], ['Karima'])).toBe(false)
    expect(sharedEntity(['theatre'], ['atre'])).toBe(false)
    expect(cleanEntities(['Karim', ' karim ', 'x', 'Sara'])).toEqual(['Karim', 'Sara'])
  })
})

/** A thought on the unit circle at `angle` degrees: two thoughts score cos(difference). */
let n = 0
function thought(o: Partial<LinkableThought> & { score: number }): LinkableThought {
  n += 1
  const s = o.score
  return {
    id: o.id ?? `t${n}`,
    bulletId: o.bulletId ?? `b${n}`,
    kind: o.kind ?? 'note',
    capturedAt: o.capturedAt ?? T0 + n,
    entities: o.entities ?? [],
    sensitive: o.sensitive ?? false,
    neverAsk: o.neverAsk ?? false,
    resolved: o.resolved ?? false,
    vector: normalize([s, Math.sqrt(1 - s * s)]),
  }
}
const anchor = (o: Partial<LinkableThought> = {}) =>
  thought({ capturedAt: T0 + 10 * DAY, bulletId: 'new', ...o, score: 1 })
const none = () => false

describe('planLinks', () => {
  const th = DEDICATED_PROFILE.thresholds

  test('link at 0.80; 0.75 with a shared name; below threshold dropped', () => {
    const f = anchor({ entities: ['Karim'] })
    const pool = [
      thought({ id: 'hi', score: 0.81 }),
      thought({ id: 'lo', score: 0.78 }),
      thought({ id: 'named', score: 0.76, entities: ['karim'] }),
      thought({ id: 'named-lo', score: 0.74, entities: ['Karim'] }),
    ]
    const plan = planLinks({ fresh: [f], pool, thresholds: th, vetoed: none, linked: none })
    expect(plan.links.map((l) => [l.a, l.type])).toEqual([
      ['hi', 'same_topic'],
      ['named', 'same_entity'],
    ])
  })

  test('candidates are the 10 nearest only; vetoed and linked pairs are skipped', () => {
    const f = anchor()
    const pool = Array.from({ length: 12 }, (_, i) =>
      thought({ id: `p${i}`, score: 0.99 - i * 0.01 }),
    )
    const plan = planLinks({
      fresh: [f],
      pool,
      thresholds: th,
      vetoed: (a) => a === 'p0',
      linked: (a) => a === 'p1',
    })
    expect(plan.links.map((l) => l.a)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'])
  })

  test('a question or idea said again revisits it', () => {
    const f = anchor({ kind: 'question' })
    const plan = planLinks({
      fresh: [f],
      pool: [thought({ id: 'q', kind: 'question', score: 0.9 })],
      thresholds: th,
      vetoed: none,
      linked: none,
    })
    expect(plan.links[0]?.type).toBe('revisits')
  })

  test('open loops at 0.70+ are checked: earlier, unresolved, neither sensitive', () => {
    const f = anchor()
    const pool = [
      thought({ id: 'loop', kind: 'to_check', score: 0.72 }),
      thought({ id: 'closed', kind: 'question', score: 0.9, resolved: true }),
      thought({ id: 'far', kind: 'to_check', score: 0.69 }),
      thought({ id: 'later', kind: 'to_check', score: 0.9, capturedAt: T0 + 20 * DAY }),
      thought({ id: 'secret', kind: 'to_check', score: 0.9, sensitive: true }),
    ]
    const plan = planLinks({ fresh: [f], pool, thresholds: th, vetoed: none, linked: none })
    expect(plan.answerChecks.map((c) => c.loop.id)).toEqual(['loop'])
    const sensitiveAnswer = planLinks({
      fresh: [anchor({ sensitive: true })],
      pool: [thought({ id: 'loop', kind: 'to_check', score: 0.9 })],
      thresholds: th,
      vetoed: none,
      linked: none,
    })
    expect(sensitiveAnswer.answerChecks).toHaveLength(0)
  })

  test('a connection question: 0.65 up to the threshold, both reflective kinds, nothing sensitive', () => {
    const f = anchor({ kind: 'worry' })
    const pool = [
      thought({ id: 'ok', kind: 'idea', score: 0.7 }),
      thought({ id: 'note', kind: 'note', score: 0.7 }),
      thought({ id: 'low', kind: 'worry', score: 0.6 }),
      thought({ id: 'secret', kind: 'worry', score: 0.7, sensitive: true }),
      thought({ id: 'never', kind: 'worry', score: 0.7, neverAsk: true }),
    ]
    const plan = planLinks({ fresh: [f], pool, thresholds: th, vetoed: none, linked: none })
    expect(plan.questions.map((q) => q.earlier.id)).toEqual(['ok'])
  })

  test('capLinks: at most 5 per thought, counting existing links, answers first', () => {
    const proposals = Array.from({ length: 7 }, (_, i) => ({
      a: `old${i}`,
      b: 'new',
      type: 'same_topic' as const,
      score: 0.9 - i * 0.01,
    }))
    proposals.push({ a: 'loop', b: 'new', type: 'answers' as never, score: 0.71 })
    const kept = capLinks(proposals, (id) => (id === 'old0' ? 5 : 0))
    expect(kept).toHaveLength(CONNECTION_RULES.maxLinksPerThought)
    expect(kept[0]?.a).toBe('loop')
    expect(kept.some((k) => k.a === 'old0')).toBe(false)
  })
})

const ct = (
  id: string,
  day: number,
  bulletId = `b-${id}`,
  sensitive = false,
): ThemeCandidateThought => ({
  id,
  bulletId,
  capturedAt: T0 + day * DAY,
  timezone: 'Europe/Paris',
  sensitive,
})

describe('themes', () => {
  test('≥ 4 thoughts, ≥ 3 distinct local days, ≥ 2 captures', () => {
    expect(qualifiesAsTheme(clusterStats([ct('a', 0), ct('b', 1), ct('c', 2), ct('d', 2)]))).toBe(
      true,
    )
    expect(qualifiesAsTheme(clusterStats([ct('a', 0), ct('b', 1), ct('c', 2)]))).toBe(false)
    expect(qualifiesAsTheme(clusterStats([ct('a', 0), ct('b', 1), ct('c', 1), ct('d', 1)]))).toBe(
      false,
    )
    // One capture can't span 3 days, but the rule is checked on its own too.
    const one = [ct('a', 0, 'x'), ct('b', 1, 'x'), ct('c', 2, 'x'), ct('d', 3, 'x')]
    expect(qualifiesAsTheme(clusterStats(one))).toBe(false)
    // The local day counts: 23:30 and 00:30 in Paris are two days even within an hour.
    const late = { ...ct('e', 0), capturedAt: Date.UTC(2026, 9, 1, 21, 30) }
    const early = { ...ct('f', 0), capturedAt: Date.UTC(2026, 9, 1, 22, 30) }
    expect(clusterStats([late, early]).days).toBe(2)
    expect(daySpan([ct('a', 0), ct('b', 6)])).toBe(7)
  })

  test('clusters are connected groups', () => {
    const ts = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ct(id, i))
    const groups = clusterThoughts(ts, [
      ['a', 'b'],
      ['b', 'c'],
      ['d', 'e'],
      ['a', 'zzz'],
    ])
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ])
  })

  test('similarity edges are uncapped and respect vetoes', () => {
    // `s` on a shared axis, the rest on the thought's own axis.
    const v = (s: number, own: number) => {
      const out = [s, 0, 0, 0, 0]
      out[own] = Math.sqrt(1 - s * s)
      return normalize(out)
    }
    const ts = [
      { id: 'a', vector: v(1, 1), entities: [] },
      { id: 'b', vector: v(0.85, 1), entities: [] },
      { id: 'c', vector: v(0.85, 2), entities: [] },
      { id: 'd', vector: v(0.9, 3), entities: [] },
      { id: 'e', vector: v(0.5, 4), entities: [] },
    ]
    const edges = similarityEdges(
      ts,
      DEDICATED_PROFILE.thresholds,
      (x, y) => x === 'a' && y === 'c',
    )
    // a–c is vetoed; b–c (0.72), b–d and c–d (0.77) and anything with e are below 0.80.
    expect(edges).toEqual([
      ['a', 'b'],
      ['a', 'd'],
    ])
    // The links given are kept as they are.
    expect(similarityEdges([], DEDICATED_PROFILE.thresholds, none, [['x', 'y']])).toEqual([
      ['x', 'y'],
    ])
  })

  const known = (o: Partial<KnownTheme> & { id: string }): KnownTheme => ({
    status: 'active',
    retiredBy: null,
    mergedInto: null,
    members: new Set(),
    vetoed: new Set(),
    lastSeenAt: null,
    ...o,
  })
  const cluster = (prefix: string) => [0, 1, 2, 3].map((d) => ct(`${prefix}${d}`, d))

  test('continues the theme sharing most thoughts, through merge aliases', () => {
    const c = cluster('x')
    const out = matchClusters(
      [c],
      [
        known({
          id: 'old',
          status: 'retired',
          retiredBy: 'merge',
          mergedInto: 'survivor',
          members: new Set(['x0', 'x1']),
        }),
        known({ id: 'survivor', members: new Set(['y0']) }),
      ],
    )
    expect(out.map((a) => a.themeId)).toEqual(['survivor'])
  })

  test('a topic back after the window continues the theme it links to', () => {
    const out = matchClusters(
      [cluster('x')],
      [known({ id: 'old', status: 'dormant', members: new Set(['o1']) })],
      (id) => (id === 'x0' ? ['o1'] : []),
    )
    expect(out[0]?.themeId).toBe('old')
  })

  test('"Not a theme" is never re-created from mostly the same thoughts', () => {
    const vetoed = known({
      id: 'no',
      status: 'retired',
      retiredBy: 'user',
      vetoed: new Set(['x0', 'x1']),
    })
    expect(matchClusters([cluster('x')], [vetoed])).toEqual([])
    // With mostly new thoughts it may come back, as a new theme.
    const bigger = [...cluster('x'), ...[4, 5, 6].map((d) => ct(`x${d}`, d))]
    expect(matchClusters([bigger], [vetoed]).map((a) => a.themeId)).toEqual([null])
  })

  test('two clusters on one theme (a merge) are one theme; at most 8 active', () => {
    const merged = matchClusters(
      [cluster('x'), cluster('y')],
      [known({ id: 't', members: new Set(['x0', 'y0']) })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.members).toHaveLength(8)
    const many = Array.from({ length: 11 }, (_, i) => cluster(`c${i}-`))
    expect(pickActive(matchClusters(many, []))).toHaveLength(8)
  })

  test('quotes: never sensitive, one per capture first, newest first; headline the most typical', () => {
    const v = (s: number) => normalize([s, Math.sqrt(1 - s * s)])
    const q = pickQuotes([
      {
        id: 'a',
        bulletId: 'b1',
        text: 'rent again',
        capturedAt: 1,
        sensitive: false,
        vector: v(0.9),
      },
      {
        id: 'b',
        bulletId: 'b1',
        text: 'rent rent',
        capturedAt: 2,
        sensitive: false,
        vector: v(0.95),
      },
      {
        id: 'c',
        bulletId: 'b2',
        text: 'landlord',
        capturedAt: 3,
        sensitive: false,
        vector: v(0.99),
      },
      { id: 'd', bulletId: 'b3', text: 'secret', capturedAt: 4, sensitive: true, vector: v(1) },
    ])
    expect(q?.quotes.map((x) => x.id)).toEqual(['c', 'b', 'a'])
    expect(q?.headline.id).toBe('b')
  })
})

describe('model calls', () => {
  test('answer check: yes/no/unsure; anything unusable is unsure', async () => {
    for (const [reply, want] of [
      ['{"answers":"yes"}', 'yes'],
      ['{"answers":"no"}', 'no'],
      ['nope', 'unsure'],
      ['{"answers":"maybe"}', 'unsure'],
    ] as const) {
      const llm = createScriptedLlmClient({ chatQueue: [reply] })
      expect(await answerCheck({ llm, config }, 'check the passport', 'valid until 2029')).toBe(
        want,
      )
    }
  })

  test('link review: null on bad output', async () => {
    const llm = createScriptedLlmClient({ chatQueue: ['{"relation":"same_entity"}', 'garbage'] })
    expect(await reviewLink({ llm, config }, 'a', 'b')).toBe('same_entity')
    expect(await reviewLink({ llm, config }, 'a', 'b')).toBeNull()
  })

  test('theme names are the user’s words, short, and never interpret', async () => {
    const notes = ['the rent is going up', 'rent money is tight', 'stressed about rent']
    expect(validThemeName('the rent', notes)).toBe('the rent')
    expect(validThemeName('«Rent»', notes)).toBe('Rent')
    expect(validThemeName('housing costs', notes)).toBeNull()
    expect(validThemeName('the rent is going up again', notes)).toBeNull()
    expect(validThemeName('stressed about rent', notes)).toBeNull()
    expect(fallbackThemeName(notes)).toBe('rent')
    const llm = createScriptedLlmClient({ chatQueue: ['{"name":"You seem worried about money"}'] })
    expect(await nameTheme({ llm, config }, notes)).toBe('rent')
  })
})

describe('Noticed copy denylist', () => {
  test('the words are the spec’s', () => {
    expect([...NOTICED_DENYLIST]).toEqual([
      'seem',
      'tend',
      'should',
      'pattern',
      'stress',
      'anxious',
      'always',
      'never',
    ])
    for (const w of [
      'You seem tired',
      'you tend to',
      'a Pattern',
      'stressed',
      'Anxiously',
      'never',
    ]) {
      expect(usesDeniedWord(w), w).toBe(true)
    }
    expect(usesDeniedWord('came up 4 times in 9 days')).toBe(false)
  })

  test('nothing the app writes on a card uses them', () => {
    // The template, with every count it can show (the quote is the user's own words).
    for (const [count, days] of [
      [1, 1],
      [4, 3],
      [12, 30],
    ] as const) {
      const headline = noticedHeadline('QUOTE', count, days)
      expect(headline).toMatch(/^«QUOTE» · came up .+ in .+ days?$/)
      expect(usesDeniedWord(headline.replace('«QUOTE»', ''))).toBe(false)
    }
    // Every name the app can put on a theme passed the check.
    for (const name of ['You seem stressed', 'a pattern of rent', 'always the rent']) {
      expect(validThemeName(name, [name])).toBeNull()
    }
    // The connection question template.
    expect(usesDeniedWord(connectionQuestionText('A', 'B').replace(/«[AB]»/g, ''))).toBe(false)
  })

  test('quotes are shortened on word boundaries', () => {
    expect(shortQuote('a'.repeat(10))).toBe('a'.repeat(10))
    const long = 'word '.repeat(40).trim()
    const q = shortQuote(long, 30)
    expect(q.length).toBeLessThanOrEqual(30)
    expect(q.endsWith('word…')).toBe(true)
  })
})

describe('review follow-ups', () => {
  test('the journal never weighs more than half of the centring mean', () => {
    const bg = { sum: Float32Array.from([10, 0]), count: 10 }
    const few = { sum: Float32Array.from([0, 2]), count: 2 }
    const many = { sum: Float32Array.from([0, 10_000]), count: 10_000 }
    expect([...(blendMeans(bg, few)?.sum ?? [])]).toEqual([
      expect.closeTo(10 / 12),
      expect.closeTo(2 / 12),
    ])
    expect([...(blendMeans(bg, many)?.sum ?? [])]).toEqual([
      expect.closeTo(0.5),
      expect.closeTo(0.5),
    ])
    expect(blendMeans(null, few)).toBe(few)
  })

  test('a mostly-sensitive theme never takes one of the 8 slots', () => {
    const sized = (prefix: string, sensitive: boolean) =>
      [0, 1, 2, 3].map((d) => ct(`${prefix}${d}`, d, `b-${prefix}${d}`, sensitive))
    const clusters = [
      ...Array.from({ length: 8 }, (_, i) => sized(`v${i}-`, false)),
      [...sized('s-', true), ...[4, 5].map((d) => ct(`s-${d}`, d, `b-s${d}`, true))],
    ]
    const active = pickActive(matchClusters(clusters, []))
    expect(active).toHaveLength(9)
    expect(active.filter((a) => a.stats.sensitiveShare < 0.5)).toHaveLength(8)
  })

  test('the headline is always one of the quotes', () => {
    const v = (s: number) => normalize([s, Math.sqrt(1 - s * s)])
    const t = (id: string, bulletId: string, at: number, s: number) => ({
      id,
      bulletId,
      text: id,
      capturedAt: at,
      sensitive: false,
      vector: v(s),
    })
    // The most typical thought ('old') is the oldest: it would not make the 3 newest.
    const q = pickQuotes([
      t('old', 'b0', 0, 0.5),
      t('n1', 'b1', 1, 0.95),
      t('n2', 'b2', 2, 0.05),
      t('n3', 'b3', 3, 0.9),
    ])
    expect(q?.headline.id).toBe('old')
    expect(q?.quotes.map((x) => x.id)).toEqual(['n3', 'n2', 'old'])
  })
})
