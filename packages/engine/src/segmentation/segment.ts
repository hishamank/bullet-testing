/**
 * Segmentation: capture text → ordered thoughts with kinds ("capture → thoughts → things").
 *
 * Long captures (a minutes-long voice ramble) are cut into chunks at sentence boundaries, each
 * segmented by its own structured LLM call; thoughts are then concatenated in order. The model
 * returns, per thought, a verbatim `quote` (located in the chunk to compute the span), a cleaned
 * `text` and a `kind`. The text stays in the user's own words: one that drifted from them
 * (translated to English, rewritten) falls back to the verbatim words. Nothing is dropped: a chunk
 * the model returns no thoughts for becomes one `note` thought, so every word of the capture lives
 * in some thought.
 */

import { type TextSpan, type ThoughtKind, thoughtKindSchema } from '@bullet/core'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { EngineConfig } from '../config'
import { requestStructured } from '../extraction/extract'
import { renderCaptureContext } from '../extraction/prompt'
import type { LlmClient, LlmMessage } from '../llm/types'
import type { CaptureContext } from '../time/when'
import { looksSensitive } from './sensitive'

export const segmentationResponseSchema = z.object({
  thoughts: z.array(
    z.object({
      /** The exact words from the capture this thought covers (for locating it). */
      quote: z.string().default(''),
      /** The thought, lightly cleaned (fillers, false starts removed), same language(s). */
      text: z.string(),
      kind: thoughtKindSchema,
      /** Reads as self-harm, crisis or acute distress (see the prompt). */
      sensitive: z.boolean().default(false),
    }),
  ),
})

/**
 * What the model is constrained to. `quote` is required and comes FIRST: llama-server decodes
 * keys in schema order, so the model copies the user's words before it writes the cleaned text.
 * Asked for `text` first, small models (Qwen3.5-4B) translated mixed Arabizi/French to English.
 */
export const segmentationJsonSchema: Record<string, unknown> = zodToJsonSchema(
  z.object({
    thoughts: z.array(
      z.object({
        quote: z.string(),
        text: z.string(),
        kind: thoughtKindSchema,
        sensitive: z.boolean(),
      }),
    ),
  }),
  { target: 'openApi3', $refStrategy: 'none' },
) as Record<string, unknown>

export const SEGMENTATION_SYSTEM_PROMPT = `You split one journal capture into separate THOUGHTS, in order.

A capture may be one line or minutes of rambling speech that mixes English, Lebanese Arabic (in Arabic script, or in Latin letters with digits like 2, 3, 7: "Arabizi") and French. Split it wherever the subject changes. Keep EVERY thought: nothing the user said may be lost, even small or emotional things.

NEVER TRANSLATE. Every thought stays in the user's own words, language and script: Arabizi stays Arabizi, Arabic stays Arabic, French stays French, a sentence that mixes them stays mixed.

For each thought give, in this order:
- "quote": the EXACT words from the capture this thought covers, copied character for character.
- "text": the quote, lightly cleaned: remove filler words, repetitions and false starts. Same words, same language(s), same script as the quote. Do not summarise away details.
- "kind", one of:
  - "worry": something weighing on the user.
  - "to_check": something to look into or verify.
  - "question": a question the user asks themself.
  - "idea": an idea worth keeping.
  - "note": anything else worth keeping (a fact, a feeling, a memory, a reflection).
  - "task": something the user intends or needs to do, even with a deadline ("before 10am", "by Friday").
  - "event": something happening at a set time that the user attends (appointment, meeting, dinner).
  - "tracker": a measurement or reading (mood 4, slept 6h, weight 72), or wanting to track something.
  - "activity": something the user did.
- "sensitive": true when the thought reads as self-harm, suicidal thoughts, wanting to disappear or not wake up, a crisis, or acute distress. If you are unsure whether it is that serious, use true. Ordinary worries, stress, tiredness, sadness or a bad day are false. This never changes the kind or the text.

Example capture: "um bade jib ghaz lal sayyara, w demain j'ai rdv chez le médecin à 11h. Feeling tired"
Example answer: {"thoughts":[{"quote":"um bade jib ghaz lal sayyara","text":"bade jib ghaz lal sayyara","kind":"task","sensitive":false},{"quote":"w demain j'ai rdv chez le médecin à 11h","text":"demain j'ai rdv chez le médecin à 11h","kind":"event","sensitive":false},{"quote":"Feeling tired","text":"Feeling tired","kind":"note","sensitive":false}]}

Output ONLY the JSON object matching the schema. No Markdown code fences, no commentary.`

/**
 * Generation cap for segmenting one chunk: the answer quotes the chunk and repeats it cleaned
 * (two copies of it) plus JSON per thought. Arabizi tokenizes at ~3 characters a token, but Arabic
 * script can take about one token per character, so two copies need ~2 tokens per character.
 */
export function segmentationMaxTokens(chunk: string): number {
  return Math.max(1024, Math.ceil(chunk.length * 2))
}

/** Thoughts per chunk: about a minute of speech. */
export const DEFAULT_CHUNK_CHARS = 1500

export interface TextChunk {
  text: string
  /** Offset of the chunk in the full text. */
  offset: number
}

/**
 * Cut `text` into chunks of at most `maxChars`, preferring sentence ends, then whitespace. Chunks
 * cover the text exactly (concatenated they give it back), so offsets stay true.
 */
export function chunkText(text: string, maxChars = DEFAULT_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const window = text.slice(start, end)
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('\n'),
      )
      const space = window.lastIndexOf(' ')
      const cut = sentence > maxChars / 3 ? sentence + 1 : space > maxChars / 3 ? space : -1
      if (cut > 0) end = start + cut + 1
    }
    chunks.push({ text: text.slice(start, end), offset: start })
    start = end
  }
  return chunks
}

export interface SegmentedThought {
  /** 0-based order in the capture. */
  position: number
  text: string
  kind: ThoughtKind
  span: TextSpan | null
  /**
   * Reads as self-harm, crisis or acute distress: the model's flag, or a plain phrase of it in the
   * words ({@link looksSensitive}). Never shown; it only keeps reflective questions away.
   */
  sensitive: boolean
}

/** Curly quotes the model may straighten (or the keyboard may curl). */
const QUOTE_CHARS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
}

/**
 * Lowercase, straighten quotes and collapse whitespace, keeping a map from each output index back
 * to its index in `s` so a match in the normalized text is a span in the original.
 */
function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? ''
    const space = /\s/.test(ch)
    if (space && text.endsWith(' ')) continue
    const out = space ? ' ' : (QUOTE_CHARS[ch] ?? ch.toLowerCase())
    for (let k = 0; k < out.length; k++) map.push(i)
    text += out
  }
  return { text, map }
}

/** Locate `quote` in `chunk`, searching from `from` (thoughts come in order). */
function locate(quote: string, chunk: TextChunk, from: number): TextSpan | null {
  const q = quote.trim()
  if (q === '') return null
  let i = chunk.text.indexOf(q, from)
  if (i < 0) i = chunk.text.indexOf(q)
  if (i >= 0) return { start: chunk.offset + i, end: chunk.offset + i + q.length }
  // Tolerate case, curly quotes, spacing and a trailing period the model added.
  const hay = normalizeWithMap(chunk.text)
  const fromN = hay.map.findIndex((m) => m >= from)
  for (const needle of [q, q.replace(/[.,;:!?…]+$/u, '')]) {
    const n = normalizeWithMap(needle).text
    if (n === '') continue
    let j = fromN < 0 ? -1 : hay.text.indexOf(n, fromN)
    if (j < 0) j = hay.text.indexOf(n)
    if (j < 0) continue
    const start = hay.map[j] ?? 0
    const end = (hay.map[j + n.length - 1] ?? start) + 1
    return { start: chunk.offset + start, end: chunk.offset + end }
  }
  return null
}

/** Words, lowercased and without accents ("réunion" and "reunion" are one word). */
function words(s: string): string[] {
  return (
    s
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/**
 * Below this share of its words found in the source, a cleaned text is a rewrite, not a cleanup.
 * Cleaning only drops words; a respelled Arabizi word ("kont" → "kunt") counts as not found.
 */
const MIN_OWN_WORDS = 0.8

/**
 * True when `text` no longer reads as the user's own words in `source`: most of its words are not
 * in the source, as with a translation (which also catches Arabic ↔ Latin script changes) or a
 * paraphrase. Light cleaning only removes words, so a cleaned thought keeps nearly all of them.
 */
export function driftedFrom(text: string, source: string): boolean {
  const own = new Set(words(source))
  const w = words(text)
  if (w.length === 0) return false
  return w.filter((x) => own.has(x)).length / w.length < MIN_OWN_WORDS
}

function buildSegmentationPrompt(chunk: string, ctx: CaptureContext, part: string): LlmMessage[] {
  return [
    { role: 'system', content: SEGMENTATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${renderCaptureContext(ctx)}${part}\nCapture:\n"""\n${chunk}\n"""\n\nSplit it into thoughts.`,
    },
  ]
}

/** Split a capture into ordered, classified thoughts. Throws EngineError like extraction does. */
export async function segmentCapture(
  deps: { llm: LlmClient; config: EngineConfig },
  input: CaptureContext & { text: string },
  opts: { chunkChars?: number } = {},
): Promise<SegmentedThought[]> {
  const chunks = chunkText(input.text, opts.chunkChars)
  const thoughts: SegmentedThought[] = []
  for (const [n, chunk] of chunks.entries()) {
    if (chunk.text.trim() === '') continue
    const part = chunks.length > 1 ? ` (part ${n + 1} of ${chunks.length} of a long capture)` : ''
    const res = await requestStructured(
      deps,
      buildSegmentationPrompt(chunk.text, input, part),
      segmentationResponseSchema,
      segmentationJsonSchema,
      'Segmentation',
      segmentationMaxTokens(chunk.text),
    )
    const found = res.thoughts.filter((t) => t.text.trim() !== '' || t.quote.trim() !== '')
    if (found.length === 0) {
      // Never lose words: an unsegmented chunk is kept whole as a note.
      const text = chunk.text.trim()
      const lead = chunk.text.indexOf(text)
      thoughts.push({
        position: thoughts.length,
        text,
        kind: 'note',
        span: { start: chunk.offset + lead, end: chunk.offset + lead + text.length },
        sensitive: looksSensitive(text),
      })
      continue
    }
    let cursor = 0
    for (const t of found) {
      const span = locate(t.quote, chunk, cursor) ?? locate(t.text, chunk, cursor)
      if (span) cursor = span.end - chunk.offset
      // The user's own words win: a text that drifted from them (translated, rewritten) is
      // replaced by the verbatim words. Unlocated, the quote is only trusted when it reads as the
      // chunk's own words.
      const quote = driftedFrom(t.quote, chunk.text) ? '' : t.quote.trim()
      const verbatim = span ? input.text.slice(span.start, span.end).trim() : quote
      let text = t.text.trim()
      if (verbatim !== '' && (text === '' || driftedFrom(text, verbatim))) text = verbatim
      const sensitive = t.sensitive || looksSensitive(text) || looksSensitive(verbatim)
      thoughts.push({ position: thoughts.length, text, kind: t.kind, span, sensitive })
    }
  }
  return thoughts
}
