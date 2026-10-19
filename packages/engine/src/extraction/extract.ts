/**
 * extractCandidates — call the live model with structured output, parse the JSON content
 * (tolerating common small-model wrapping), validate it against {@link extractionResponseSchema},
 * make ONE repair retry on parse/validation failure, then throw a typed {@link EngineError}.
 *
 * The `jsonSchema` we send is {@link extractionJsonSchema}, derived from the SAME zod schema we
 * validate with — so the model is constrained to (and we accept exactly) one shape.
 */

import type { EngineConfig } from '../config'
import type { LlmClient } from '../llm/types'
import { EngineError } from '../errors'
import type { LlmMessage } from '../llm/types'
import type { z } from 'zod'
import type { CaptureContext } from '../time/when'
import { buildExtractionPrompt } from './prompt'
import { type Candidate, extractionJsonSchema, extractionResponseSchema } from './schema'
import type { ExtractionSnapshot } from './snapshot'

/**
 * Generation cap for one extraction answer. A thought's candidates measured 36–176 tokens live; a
 * runaway (the model looping inside the JSON grammar) stops here instead of at the deadline.
 */
export const EXTRACTION_MAX_TOKENS = 1024

/** How many TOTAL attempts (1 initial + 1 repair retry). */
const MAX_ATTEMPTS = 2

/**
 * Strip a single leading/trailing Markdown code fence from `text` (```json … ``` or ``` … ```),
 * trimming surrounding whitespace. Small models often wrap JSON in fences even when told not to.
 * Returns the inner text (or the trimmed input when there is no fence).
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  // A leading fence is three backticks optionally followed by a language tag, then a newline.
  const leadingFence = /^```[^\n]*\n/
  if (!leadingFence.test(trimmed)) return trimmed
  return trimmed
    .replace(leadingFence, '')
    .replace(/\n?```$/, '')
    .trim()
}

/**
 * Return the first balanced top-level `{ … }` object substring of `text` (from the first `{` to
 * its matching `}`), or `undefined` if there is none. String literals (and their escapes) are
 * tracked so braces inside strings do not affect nesting. This lets us tolerate leading/trailing
 * prose like "Here is the JSON:" around an otherwise-valid object.
 */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      // A backslash only escapes inside a string literal.
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Tolerantly extract the JSON-object substring from a raw model response WITHOUT changing what
 * counts as success — this only salvages common wrapping (Markdown fences, surrounding prose).
 * The returned string is still handed to `JSON.parse` + schema validation unchanged.
 *
 * Returns the candidate JSON-object string, or `undefined` when no object can be found (treated
 * as a parse failure by the caller, i.e. the same `OLLAMA_PARSE` path).
 */
export function extractJsonObject(raw: string): string | undefined {
  const stripped = stripCodeFence(raw)
  // Always run the balanced-brace scanner: it round-trips a bare object AND salvages the first
  // balanced { … } object embedded in any surrounding prose (leading OR trailing), while tracking
  // string literals so braces inside strings do not affect nesting.
  return firstBalancedObject(stripped)
}

/**
 * Build the extra messages that turn the second attempt into a REPAIR attempt: echo the model's
 * previous raw output, then tell it exactly why it was rejected and to reply with ONLY the
 * corrected JSON object — no prose, no code fences. The original system+user messages are kept.
 */
function buildRepairMessages(
  previousContent: string,
  error: EngineError | undefined,
): LlmMessage[] {
  const reason =
    error?.code === 'EXTRACTION_INVALID' && error.details !== undefined
      ? `It did not match the schema. Validation errors: ${JSON.stringify(error.details)}.`
      : 'It was not valid JSON.'
  const repair = `Your previous reply was not accepted. ${reason} Reply with ONLY the corrected JSON object matching the schema — no prose, no commentary, and no Markdown code fences.`
  return [
    { role: 'assistant', content: previousContent },
    { role: 'user', content: repair },
  ]
}

/** What extraction needs to know about a bullet: its text and when/where it was captured. */
export interface ExtractionInput extends CaptureContext {
  text: string
}

/**
 * Run extraction for `bullet` against `snapshot`. Returns the validated candidates.
 *
 * On a parse/validation failure the SECOND attempt is a repair retry: it re-sends the original
 * messages plus the prior raw output and a correction instruction (still constrained by the
 * `jsonSchema`). After the repair fails we throw the last typed error.
 *
 * @throws EngineError('LLM_PARSE') if the content is not valid JSON after the repair.
 * @throws EngineError('EXTRACTION_INVALID') if the JSON does not satisfy the schema after repair.
 */
export async function extractCandidates(
  deps: { llm: LlmClient; config: EngineConfig },
  bullet: ExtractionInput,
  snapshot: ExtractionSnapshot,
): Promise<Candidate[]> {
  const baseMessages = buildExtractionPrompt(bullet.text, snapshot, bullet)
  const res = await requestStructured(
    deps,
    baseMessages,
    extractionResponseSchema,
    extractionJsonSchema,
    'Extraction',
  )
  return res.candidates
}

/**
 * One structured-output LLM call with tolerant parsing and ONE repair retry. On a parse/validation
 * failure the second attempt re-sends the original messages plus the prior raw output and a
 * correction instruction (still constrained by `jsonSchema`); then the last typed error is thrown.
 *
 * @throws EngineError('LLM_PARSE') if the content is not valid JSON after the repair.
 * @throws EngineError('EXTRACTION_INVALID') if the JSON does not satisfy `schema` after repair.
 */
export async function requestStructured<T>(
  deps: { llm: LlmClient; config: EngineConfig },
  baseMessages: LlmMessage[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  jsonSchema: Record<string, unknown>,
  label: string,
  maxTokens: number = EXTRACTION_MAX_TOKENS,
): Promise<T> {
  let lastError: EngineError | undefined
  let previousContent: string | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // On the repair attempt, append the prior raw output + a correction instruction so the model
    // gets a real repair SIGNAL instead of re-rolling the identical prompt.
    const messages =
      attempt === 1 || previousContent === undefined
        ? baseMessages
        : [...baseMessages, ...buildRepairMessages(previousContent, lastError)]

    // Structured output: constrain decoding to the schema (on every attempt).
    const res = await deps.llm.chat({ model: deps.config.model, messages, jsonSchema, maxTokens })
    previousContent = res.message.content

    // (1) Tolerantly extract the JSON object, then parse it.
    let json: unknown
    try {
      const candidate = extractJsonObject(res.message.content)
      if (candidate === undefined) throw new Error('no JSON object found in response')
      json = JSON.parse(candidate)
    } catch {
      lastError = new EngineError(
        'LLM_PARSE',
        `${label} response was not valid JSON (attempt ${attempt})`,
        res.message.content,
      )
      continue
    }

    // (2) Validate against the schema.
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      lastError = new EngineError(
        'EXTRACTION_INVALID',
        `${label} response failed schema validation (attempt ${attempt})`,
        parsed.error.flatten(),
      )
      continue
    }

    return parsed.data
  }

  // Both attempts failed — surface the last typed error.
  throw lastError ?? new EngineError('EXTRACTION_INVALID', `${label} failed for an unknown reason`)
}
