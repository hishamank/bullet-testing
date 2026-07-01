/**
 * extractCandidates — call the live model with structured output, parse the JSON content
 * (tolerating common small-model wrapping), validate it against {@link extractionResponseSchema},
 * make ONE repair retry on parse/validation failure, then throw a typed {@link AgentError}.
 *
 * The `format` we send is {@link extractionJsonSchema}, derived from the SAME zod schema we
 * validate with — so the model is constrained to (and we accept exactly) one shape.
 */

import type { AgentDeps } from '../deps'
import { AgentError } from '../errors'
import type { OllamaMessage } from '../ollama/types'
import { buildExtractionPrompt } from './prompt'
import { type Candidate, extractionJsonSchema, extractionResponseSchema } from './schema'
import type { ExtractionSnapshot } from './snapshot'

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
  error: AgentError | undefined,
): OllamaMessage[] {
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

/**
 * Run extraction for `bullet` against `snapshot`. Returns the validated candidates.
 *
 * On a parse/validation failure the SECOND attempt is a repair retry: it re-sends the original
 * messages plus the prior raw output and a correction instruction (still constrained by the
 * `format` schema). After the repair fails we throw the last typed error.
 *
 * @throws AgentError('OLLAMA_PARSE') if the content is not valid JSON after the repair.
 * @throws AgentError('EXTRACTION_INVALID') if the JSON does not satisfy the schema after repair.
 */
export async function extractCandidates(
  deps: Pick<AgentDeps, 'ollama' | 'config'>,
  bullet: string,
  snapshot: ExtractionSnapshot,
): Promise<Candidate[]> {
  const baseMessages = buildExtractionPrompt(bullet, snapshot)
  let lastError: AgentError | undefined
  let previousContent: string | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // On the repair attempt, append the prior raw output + a correction instruction so the model
    // gets a real repair SIGNAL instead of re-rolling the identical prompt.
    const messages =
      attempt === 1 || previousContent === undefined
        ? baseMessages
        : [...baseMessages, ...buildRepairMessages(previousContent, lastError)]

    const res = await deps.ollama.chat({
      model: deps.config.liveModel,
      messages,
      // Structured output: constrain decoding to the extraction schema (on every attempt).
      format: extractionJsonSchema,
    })
    previousContent = res.message.content

    // (1) Tolerantly extract the JSON object, then parse it.
    let json: unknown
    try {
      const candidate = extractJsonObject(res.message.content)
      if (candidate === undefined) throw new Error('no JSON object found in response')
      json = JSON.parse(candidate)
    } catch {
      lastError = new AgentError(
        'OLLAMA_PARSE',
        `Extraction response was not valid JSON (attempt ${attempt})`,
        res.message.content,
      )
      continue
    }

    // (2) Validate against the extraction schema.
    const parsed = extractionResponseSchema.safeParse(json)
    if (!parsed.success) {
      lastError = new AgentError(
        'EXTRACTION_INVALID',
        `Extraction response failed schema validation (attempt ${attempt})`,
        parsed.error.flatten(),
      )
      continue
    }

    return parsed.data.candidates
  }

  // Both attempts failed — surface the last typed error.
  throw lastError ?? new AgentError('EXTRACTION_INVALID', 'Extraction failed for an unknown reason')
}
