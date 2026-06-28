/**
 * extractCandidates — call the live model with structured output, parse the JSON content,
 * validate it against {@link extractionResponseSchema}, retry ONCE on parse/validation failure,
 * then throw a typed {@link AgentError}.
 *
 * The `format` we send is {@link extractionJsonSchema}, derived from the SAME zod schema we
 * validate with — so the model is constrained to (and we accept exactly) one shape.
 */

import type { AgentDeps } from '../deps'
import { AgentError } from '../errors'
import { buildExtractionPrompt } from './prompt'
import { type Candidate, extractionJsonSchema, extractionResponseSchema } from './schema'
import type { ExtractionSnapshot } from './snapshot'

/** How many TOTAL attempts (1 initial + 1 retry). */
const MAX_ATTEMPTS = 2

/**
 * Run extraction for `bullet` against `snapshot`. Returns the validated candidates.
 *
 * @throws AgentError('OLLAMA_PARSE') if the content is not valid JSON after the retry.
 * @throws AgentError('EXTRACTION_INVALID') if the JSON does not satisfy the schema after retry.
 */
export async function extractCandidates(
  deps: Pick<AgentDeps, 'ollama' | 'config'>,
  bullet: string,
  snapshot: ExtractionSnapshot,
): Promise<Candidate[]> {
  const messages = buildExtractionPrompt(bullet, snapshot)
  let lastError: AgentError | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await deps.ollama.chat({
      model: deps.config.liveModel,
      messages,
      // Structured output: constrain decoding to the extraction schema.
      format: extractionJsonSchema,
    })

    // (1) Parse the content as JSON.
    let json: unknown
    try {
      json = JSON.parse(res.message.content)
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
