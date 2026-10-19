/**
 * The model calls of slice 3, each one short structured question with a deterministic check of
 * the answer. A bad answer means the safe outcome (no link change, no suggestion, no name), never
 * an error; only a transport failure (the model is down or too slow) throws.
 *
 *  - {@link answerCheck} (live model, per capture): does a later thought answer an open loop?
 *  - {@link reviewLink} (nightly model): same person/place/project, same topic, or unrelated?
 *  - {@link nameTheme} (nightly model): a 1–4 word name taken from the user's own words.
 */

import { usesDeniedWord } from '@bullet/core'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { EngineConfig } from '../config'
import { extractJsonObject } from '../extraction/extract'
import type { LlmClient, LlmMessage } from '../llm/types'
import { FUNCTION_WORDS } from '../resolution/stopwords'

type Deps = { llm: LlmClient; config: EngineConfig }

const jsonSchemaOf = (schema: z.ZodTypeAny): Record<string, unknown> =>
  zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>

async function ask<T>(
  deps: Deps,
  messages: LlmMessage[],
  schema: z.ZodType<T>,
  jsonSchema: Record<string, unknown>,
  maxTokens: number,
): Promise<T | null> {
  const res = await deps.llm.chat({
    model: deps.config.model,
    messages,
    jsonSchema,
    maxTokens,
    temperature: 0,
  })
  const raw = extractJsonObject(res.message.content)
  if (raw === undefined) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// --- does it answer the open loop? ---

export const answerCheckSchema = z.object({ answers: z.enum(['yes', 'no', 'unsure']) })
export const answerCheckJsonSchema = jsonSchemaOf(answerCheckSchema)

export const ANSWER_CHECK_SYSTEM_PROMPT = `Two notes from one person's private journal. The FIRST was something they meant to check or a question they asked themself. The SECOND was written later.

Does the SECOND note answer or settle the FIRST one (they found out, decided, or did it)? Answer "yes" only when it clearly does. Answer "no" when it is only about the same subject, asks again, or is unrelated. Answer "unsure" otherwise.

The notes may mix English, French, Lebanese Arabic and Arabizi.

Output ONLY the JSON object {"answers":"yes"|"no"|"unsure"}.`

export type AnswerVerdict = 'yes' | 'no' | 'unsure'

/** Does `later` answer the open loop `loop`? Unusable output is `unsure`. */
export async function answerCheck(deps: Deps, loop: string, later: string): Promise<AnswerVerdict> {
  const res = await ask(
    deps,
    [
      { role: 'system', content: ANSWER_CHECK_SYSTEM_PROMPT },
      { role: 'user', content: `FIRST: ${loop}\nSECOND: ${later}` },
    ],
    answerCheckSchema,
    answerCheckJsonSchema,
    32,
  )
  return res?.answers ?? 'unsure'
}

// --- nightly: type and review a link ---

export const linkReviewSchema = z.object({
  relation: z.enum(['same_entity', 'same_topic', 'unrelated']),
})
export const linkReviewJsonSchema = jsonSchemaOf(linkReviewSchema)

export const LINK_REVIEW_SYSTEM_PROMPT = `Two notes from one person's private journal, written on different days.

How are they connected?
- "same_entity": both are about the same specific person, place, organisation or project (named or clearly the same one).
- "same_topic": both are about the same subject, but not one specific person, place or project.
- "unrelated": they only share a word or a mood, or nothing at all.

The notes may mix English, French, Lebanese Arabic and Arabizi.

Output ONLY the JSON object {"relation":"same_entity"|"same_topic"|"unrelated"}.`

export type LinkReview = z.infer<typeof linkReviewSchema>['relation']

/** The model's reading of a link; null when its answer is unusable (leave the link as it is). */
export async function reviewLink(deps: Deps, a: string, b: string): Promise<LinkReview | null> {
  const res = await ask(
    deps,
    [
      { role: 'system', content: LINK_REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: `NOTE 1: ${a}\nNOTE 2: ${b}` },
    ],
    linkReviewSchema,
    linkReviewJsonSchema,
    32,
  )
  return res?.relation ?? null
}

// --- nightly: name a theme in the user's words ---

export const themeNameSchema = z.object({ name: z.string() })
export const themeNameJsonSchema = jsonSchemaOf(themeNameSchema)

export const THEME_NAME_SYSTEM_PROMPT = `A few notes from one person's private journal that keep coming back to the same thing.

Name that thing in 1 to 4 words, using ONLY words that appear in the notes (copy them, same language and spelling). A plain label, like "the rent", "Karim", "sleep", "le podcast". No judgement, no feelings you were not told, no advice.

Output ONLY the JSON object {"name":"..."}.`

const words = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}']+/gu) ?? []

/**
 * A usable theme name: 1–4 words, every word from the notes, at most 40 characters, and no word
 * Noticed copy never uses. Returns the cleaned name or null.
 */
export function validThemeName(name: string, notes: readonly string[]): string | null {
  const clean = name
    .trim()
    .replace(/^["«“']+|["»”'.!?]+$/gu, '')
    .replace(/\s+/g, ' ')
  const w = words(clean)
  if (w.length === 0 || w.length > 4 || clean.length > 40) return null
  const own = new Set(notes.flatMap(words))
  if (!w.every((x) => own.has(x))) return null
  if (w.every((x) => FUNCTION_WORDS.has(x) || x.length < 3)) return null
  if (usesDeniedWord(clean)) return null
  return clean
}

/** Words never worth naming a theme by (on top of the shared function words). */
const NAME_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'about',
  'again',
  'today',
  'this',
  'that',
  'what',
  'should',
  'would',
  'could',
  'need',
  'want',
  'have',
  'from',
  'some',
  'more',
  'les',
  'des',
  'une',
  'pour',
  'avec',
])

/**
 * The fallback name: the word the notes share most (in at least two of them), as written in the
 * first note that has it. Null when they share none.
 */
export function fallbackThemeName(notes: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const n of notes) {
    for (const w of new Set(words(n))) {
      if (w.length < 3 || FUNCTION_WORDS.has(w) || NAME_STOPWORDS.has(w) || /^\d+$/.test(w)) {
        continue
      }
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  const best = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0]
  if (!best) return null
  // Keep the user's spelling (accents, case) of that word.
  for (const n of notes) {
    for (const raw of n.match(/[\p{L}\p{N}']+/gu) ?? []) {
      if (words(raw)[0] === best && !usesDeniedWord(raw)) return raw.toLowerCase()
    }
  }
  return null
}

/** A theme's name from the model (validated), else from the words its notes share, else null. */
export async function nameTheme(deps: Deps, notes: readonly string[]): Promise<string | null> {
  const sample = notes.slice(0, 6)
  if (sample.length === 0) return null
  const res = await ask(
    deps,
    [
      { role: 'system', content: THEME_NAME_SYSTEM_PROMPT },
      { role: 'user', content: `Notes:\n${sample.map((n) => `- ${n}`).join('\n')}` },
    ],
    themeNameSchema,
    themeNameJsonSchema,
    24,
  )
  return (res && validThemeName(res.name, sample)) ?? fallbackThemeName(sample)
}
