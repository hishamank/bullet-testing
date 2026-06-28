/**
 * The zod schema for the LLM's STRUCTURED extraction response — the single source of truth for
 * BOTH (a) validating what the model returns and (b) the Ollama `format` JSON-schema we send to
 * constrain decoding (derived via `zod-to-json-schema`). One schema, two uses.
 *
 * A Candidate is the model's reading of one segment of the bullet. It is intentionally LOOSE
 * (`fields` is a free draft object) — the model proposes raw fields; the resolver (resolution/)
 * maps each candidate to a concrete Suggestion INSERT draft and the apply engine re-validates
 * against the strict @bullet/core schemas. We never trust the model's shape.
 */

import { targetKindSchema } from '@bullet/core'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * The time-orientation of a candidate (CLAUDE.md §4.4). Drives the create-vs-append /
 * log-vs-plan routing in the resolver:
 *   - happened         → a record (tracker entry / activity), or a mark-done on an open task.
 *   - future_oneoff    → a Task.
 *   - future_recurring → a Tracker DEFINITION.
 *   - durable_fact     → a Note (OUT OF v1 SCOPE — skipped by the resolver, counted not lost).
 */
export const orientationSchema = z.enum([
  'happened',
  'future_oneoff',
  'future_recurring',
  'durable_fact',
])
export type Orientation = z.infer<typeof orientationSchema>

/** One extracted segment of the bullet. */
export const candidateSchema = z.object({
  /** Which entity/record type this segment proposes. */
  kind: targetKindSchema,
  /** The time-orientation (see {@link orientationSchema}). */
  orientation: orientationSchema,
  /** The source span (the slice of the bullet this candidate came from). */
  text: z.string(),
  /**
   * A LOOSE draft of the proposed entity fields (e.g. `{ value: 5 }`, `{ title: '…' }`,
   * `{ name: 'run', input_type: 'number' }`). Normalised by the resolver — never trusted as-is.
   */
  fields: z.record(z.string(), z.unknown()).default({}),
  /**
   * An optional NAME to match against an existing definition/instance in the snapshot (for
   * append/update): e.g. the tracker name "mood" or an open task's title "call the dentist".
   */
  referenceName: z.string().optional(),
  /** The model's confidence in this candidate, 0..1. */
  confidence: z.number().min(0).max(1),
})
export type Candidate = z.infer<typeof candidateSchema>

/** The full structured response: a list of candidates (one bullet → many candidates). */
export const extractionResponseSchema = z.object({
  candidates: z.array(candidateSchema),
})
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>

/**
 * The Ollama `format` JSON-schema, derived ONCE from {@link extractionResponseSchema}. Passed as
 * `chat({ format })` so the model is constrained to emit exactly this shape (structured output).
 *
 * `target: 'openApi3'` keeps the schema to the plain JSON-schema subset Ollama's structured
 * output accepts (no `$ref`/`$schema` wrapper at the root via `$refStrategy: 'none'`).
 */
export const extractionJsonSchema: Record<string, unknown> = zodToJsonSchema(
  extractionResponseSchema,
  { target: 'openApi3', $refStrategy: 'none' },
) as Record<string, unknown>
