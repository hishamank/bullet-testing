/**
 * Segmentation: capture text → ordered thoughts with kinds ("capture → thoughts → things").
 *
 * Long captures (a minutes-long voice ramble) are cut into chunks at sentence boundaries, each
 * segmented by its own structured LLM call; thoughts are then concatenated in order. The model
 * returns, per thought, a cleaned `text`, a verbatim `quote` (located in the chunk to compute the
 * span) and a `kind`. Nothing is dropped: a chunk the model returns no thoughts for becomes one
 * `note` thought, so every word of the capture lives in some thought.
 */

import { type TextSpan, type ThoughtKind, thoughtKindSchema } from '@bullet/core'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { EngineConfig } from '../config'
import { requestStructured } from '../extraction/extract'
import { renderCaptureContext } from '../extraction/prompt'
import type { LlmClient, LlmMessage } from '../llm/types'
import type { CaptureContext } from '../time/when'

export const segmentationResponseSchema = z.object({
  thoughts: z.array(
    z.object({
      /** The thought, lightly cleaned (fillers, false starts removed), same language(s). */
      text: z.string(),
      /** The exact words from the capture this thought covers (for locating it). */
      quote: z.string().default(''),
      kind: thoughtKindSchema,
    }),
  ),
})

export const segmentationJsonSchema: Record<string, unknown> = zodToJsonSchema(
  segmentationResponseSchema,
  { target: 'openApi3', $refStrategy: 'none' },
) as Record<string, unknown>

export const SEGMENTATION_SYSTEM_PROMPT = `You split one journal capture into separate THOUGHTS, in order.

A capture may be one line or minutes of rambling speech that mixes English, Lebanese Arabic and French. Split it wherever the subject changes. Keep EVERY thought: nothing the user said may be lost, even small or emotional things.

For each thought give:
- "text": the thought, lightly cleaned (remove filler words, repetitions and false starts), in the language(s) used. Do not summarise away details.
- "quote": the EXACT words from the capture this thought covers, copied character for character.
- "kind", one of:
  - "worry": something weighing on the user.
  - "to_check": something to look into or verify.
  - "question": a question the user asks themself.
  - "idea": an idea worth keeping.
  - "note": anything else worth keeping (a fact, a feeling, a memory, a reflection).
  - "task": something the user intends to do.
  - "event": something happening at a time (appointment, meeting, dinner).
  - "tracker": a measurement or reading (mood 4, slept 6h, weight 72), or wanting to track something.
  - "activity": something the user did.

Output ONLY the JSON object matching the schema. No Markdown code fences, no commentary.`

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
}

/** Locate `quote` in `chunk`, searching from `from` (thoughts come in order). */
function locate(quote: string, chunk: TextChunk, from: number): TextSpan | null {
  const q = quote.trim()
  if (q === '') return null
  let i = chunk.text.indexOf(q, from)
  if (i < 0) i = chunk.text.toLowerCase().indexOf(q.toLowerCase(), from)
  if (i < 0) i = chunk.text.indexOf(q)
  if (i < 0) return null
  return { start: chunk.offset + i, end: chunk.offset + i + q.length }
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
    )
    const found = res.thoughts.filter((t) => t.text.trim() !== '')
    if (found.length === 0) {
      // Never lose words: an unsegmented chunk is kept whole as a note.
      const text = chunk.text.trim()
      const lead = chunk.text.indexOf(text)
      thoughts.push({
        position: thoughts.length,
        text,
        kind: 'note',
        span: { start: chunk.offset + lead, end: chunk.offset + lead + text.length },
      })
      continue
    }
    let cursor = 0
    for (const t of found) {
      const span = locate(t.quote || t.text, chunk, cursor)
      if (span) cursor = span.end - chunk.offset
      thoughts.push({ position: thoughts.length, text: t.text.trim(), kind: t.kind, span })
    }
  }
  return thoughts
}
