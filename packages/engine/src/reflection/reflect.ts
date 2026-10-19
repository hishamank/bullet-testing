/**
 * Reflective questions from a capture (slice 2): ONE model call over the capture's worries,
 * self-questions and ideas, which may offer at most one question to think about. It asks about
 * what the user said, never what they should do; it quotes their words, in their language.
 *
 * The answer is schema-validated and checked deterministically (the quote is really theirs, the
 * question carries it, it is a short question, not advice). Anything off means NO question: a
 * missing question costs nothing, a bad one costs trust. Only a transport failure (the model is
 * down or too slow) throws, so the caller may try again later.
 */

import { REFLECTIVE_THOUGHT_KINDS, type ThoughtKind } from '@bullet/core'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { EngineConfig } from '../config'
import { extractJsonObject } from '../extraction/extract'
import type { LlmClient, LlmMessage } from '../llm/types'

/** A thought the question may be about. `position` is its place in the capture. */
export interface ReflectableThought {
  position: number
  kind: ThoughtKind
  text: string
}

/** The question to store: its text and the thought (by capture position) it is about. */
export interface ReflectiveQuestionDraft {
  thoughtPosition: number
  text: string
  /** The user's words it quotes. */
  quote: string
}

/** Thoughts of these kinds may get a reflective question (worry, self-question, idea). */
export function isReflectable(kind: ThoughtKind): boolean {
  return (REFLECTIVE_THOUGHT_KINDS as readonly ThoughtKind[]).includes(kind)
}

export const reflectionResponseSchema = z.object({
  ask: z.boolean(),
  /** The thought's number as listed in the prompt (1-based). */
  thought: z.number().int().default(0),
  quote: z.string().default(''),
  question: z.string().default(''),
})
export type ReflectionResponse = z.infer<typeof reflectionResponseSchema>

/** Constrained decoding: `ask` first, then the quote BEFORE the question (copy, then write). */
export const reflectionJsonSchema: Record<string, unknown> = zodToJsonSchema(
  z.object({
    ask: z.boolean(),
    thought: z.number().int(),
    quote: z.string(),
    question: z.string(),
  }),
  { target: 'openApi3', $refStrategy: 'none' },
) as Record<string, unknown>

export const REFLECT_SYSTEM_PROMPT = `You read a few thoughts from someone's private journal. You may offer ONE gentle question for them to think about, or none.

Rules:
- Ask about what they said, never what they should do. No advice, no suggestions, no "you should", no "have you tried", no "try to".
- Quote their own words: "quote" is a short phrase (2 to 10 words) copied exactly, character for character, from ONE thought. The question contains that quote between « and ».
- Write the question in the same language as the words you quote: French words get a French question, Arabizi words an Arabizi question, Arabic words an Arabic question, English words an English one. Never translate their words.
- Curious and warm, one short sentence ending with a question mark. Not clinical: no diagnosis, no therapy words, no judgement.
- If no thought invites a question, answer {"ask":false,"thought":0,"quote":"","question":""}.

"thought" is the number of the thought you ask about.

Example thoughts:
1. [worry] I'm dreading Monday's meeting with Karim
Example answer: {"ask":true,"thought":1,"quote":"dreading Monday's meeting","question":"You wrote «dreading Monday's meeting». What about it feels heaviest?"}

Example thoughts:
1. [idea] un podcast sur les recettes de ma grand-mère
Example answer: {"ask":true,"thought":1,"quote":"les recettes de ma grand-mère","question":"Tu as écrit «les recettes de ma grand-mère». Qu'est-ce qu'elles représentent pour toi ?"}

Example thoughts:
1. [worry] ana khayfe men l interview bukra
Example answer: {"ask":true,"thought":1,"quote":"khayfe men l interview","question":"«khayfe men l interview»: shu l shi l aktar 3am ye2la2ak fiya?"}

Output ONLY the JSON object matching the schema. No Markdown code fences, no commentary.`

/** Generation cap: one short question and a quote. */
export const REFLECT_MAX_TOKENS = 256

/** The longest question we keep (characters). */
const MAX_QUESTION_CHARS = 240

/** Advice and instructions, which a reflective question never is (outside the quote). */
const ADVICE =
  /\b(you should|should you|you need to|you must|try to|have you tried|have you considered|why don'?t you|make sure|don'?t forget|remember to|tu devrais|il faut|essaie de|n'oublie pas|lazem|lezim)\b/i

/**
 * Compare quotes loosely: case, curly quotes, spacing, trailing punctuation (Latin and Arabic
 * `،` `؟`), and Arabic short-vowel marks (U+064B–U+0652) and tatweel (U+0640), which the model
 * may add or drop when copying.
 */
const norm = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/gu, '')
    .replace(/[’`]/g, "'")
    .replace(/[«»“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?…،؟]+$/u, '')

/**
 * Check a parsed answer against the thoughts it was asked about. Returns the question to store,
 * or null (with nothing else: no question is the safe outcome).
 */
export function validateReflection(
  res: ReflectionResponse,
  thoughts: readonly ReflectableThought[],
): ReflectiveQuestionDraft | null {
  if (!res.ask) return null
  const thought = thoughts[res.thought - 1]
  if (!thought) return null
  const quote = res.quote.trim()
  const question = res.question.trim().replace(/\s+/g, ' ')
  const q = norm(quote)
  // The quote is the user's own words, from that thought: at least a couple of characters.
  if (q.length < 3 || !norm(thought.text).includes(q)) return null
  // The question carries the quote, is one short question, and gives no advice.
  if (!norm(question).includes(q)) return null
  if (!/[?؟]\s*[»"”]?$/u.test(question)) return null
  if (question.length > MAX_QUESTION_CHARS) return null
  const outside = norm(question).replace(q, ' ')
  if (ADVICE.test(outside)) return null
  return { thoughtPosition: thought.position, text: question, quote }
}

function buildReflectPrompt(thoughts: readonly ReflectableThought[]): LlmMessage[] {
  const list = thoughts.map((t, i) => `${i + 1}. [${t.kind}] ${t.text}`).join('\n')
  return [
    { role: 'system', content: REFLECT_SYSTEM_PROMPT },
    { role: 'user', content: `Thoughts:\n${list}\n\nOffer one question, or none.` },
  ]
}

/**
 * Ask the model for at most one reflective question about `thoughts` (the caller passes only
 * reflectable, non-sensitive ones). Null when there is nothing to ask about, the model declines,
 * or its answer is unusable. Throws only what the LLM client throws (unreachable, timeout).
 */
export async function reflectOnThoughts(
  deps: { llm: LlmClient; config: EngineConfig },
  thoughts: readonly ReflectableThought[],
): Promise<ReflectiveQuestionDraft | null> {
  const usable = thoughts.filter((t) => isReflectable(t.kind) && t.text.trim() !== '')
  if (usable.length === 0) return null
  const res = await deps.llm.chat({
    model: deps.config.model,
    messages: buildReflectPrompt(usable),
    jsonSchema: reflectionJsonSchema,
    maxTokens: REFLECT_MAX_TOKENS,
  })
  const raw = extractJsonObject(res.message.content)
  if (raw === undefined) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = reflectionResponseSchema.safeParse(json)
  if (!parsed.success) return null
  return validateReflection(parsed.data, usable)
}
