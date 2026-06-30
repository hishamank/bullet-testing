import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import { createScriptedOllamaClient } from '../ollama/scripted'
import { extractCandidates, extractJsonObject } from './extract'
import { buildExtractionPrompt } from './prompt'
import { extractionJsonSchema, extractionResponseSchema } from './schema'
import type { ExtractionSnapshot } from './snapshot'

const EMPTY_SNAPSHOT: ExtractionSnapshot = { trackers: [], openTasks: [] }
const config = AGENT_CONFIG_DEFAULTS

describe('extraction schema → format', () => {
  test('the Ollama format JSON-schema is derived from the zod schema', () => {
    // It is a plain object schema describing { candidates: [...] }.
    expect(extractionJsonSchema).toBeTypeOf('object')
    expect(JSON.stringify(extractionJsonSchema)).toContain('candidates')
  })
})

describe('buildExtractionPrompt', () => {
  test('embeds the bullet text and the inlined snapshot', () => {
    const messages = buildExtractionPrompt('ran 5k', {
      trackers: [
        {
          id: 't1',
          name: 'mood',
          input_type: 'scale',
          config: { input_type: 'scale', min: 1, max: 5 },
        },
      ],
      openTasks: [
        {
          id: 'k1',
          title: 'call dentist',
          status: 'todo',
          notes: null,
          due_at: null,
          priority: null,
        },
      ],
    })
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toContain('ran 5k')
    expect(messages[1]?.content).toContain('mood')
    expect(messages[1]?.content).toContain('call dentist')
  })
})

describe('extractCandidates', () => {
  test('parses and validates the structured response, sending the format schema', async () => {
    const ollama = createScriptedOllamaClient({
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'ran 5k',
              fields: { name: 'ran 5k' },
              confidence: 0.9,
            },
          ],
        }),
    })

    const candidates = await extractCandidates({ ollama, config }, 'ran 5k', EMPTY_SNAPSHOT)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'activity', orientation: 'happened' })

    // The chat call used the live model and passed the format JSON-schema (structured output).
    expect(ollama.chatCalls).toHaveLength(1)
    expect(ollama.chatCalls[0]?.model).toBe(config.liveModel)
    expect(ollama.chatCalls[0]?.format).toBe(extractionJsonSchema)
  })

  test('retries ONCE on malformed JSON then succeeds', async () => {
    const ollama = createScriptedOllamaClient({
      chatQueue: ['this is not json', JSON.stringify({ candidates: [] })],
    })
    const candidates = await extractCandidates({ ollama, config }, 'x', EMPTY_SNAPSHOT)
    expect(candidates).toEqual([])
    expect(ollama.chatCalls).toHaveLength(2)
  })

  test('throws a typed OLLAMA_PARSE error after the retry on persistent malformed JSON', async () => {
    const ollama = createScriptedOllamaClient({ chat: () => 'still not json' })
    const err = await extractCandidates({ ollama, config }, 'x', EMPTY_SNAPSHOT).catch((e) => e)
    expect(err.name).toBe('AgentError')
    expect(err.code).toBe('OLLAMA_PARSE')
    // 1 initial + 1 retry.
    expect(ollama.chatCalls).toHaveLength(2)
  })

  test('throws EXTRACTION_INVALID when valid JSON does not satisfy the schema', async () => {
    const ollama = createScriptedOllamaClient({
      // Valid JSON, but `candidates` is the wrong shape.
      chat: () => JSON.stringify({ candidates: [{ kind: 'not-a-kind' }] }),
    })
    const err = await extractCandidates({ ollama, config }, 'x', EMPTY_SNAPSHOT).catch((e) => e)
    expect(err.code).toBe('EXTRACTION_INVALID')
  })

  const VALID_RESPONSE = JSON.stringify({
    candidates: [
      {
        kind: 'task',
        orientation: 'future_oneoff',
        text: 'call mom',
        fields: { title: 'call mom' },
        confidence: 0.8,
      },
    ],
  })

  test('tolerates a response wrapped in a ```json code fence', async () => {
    const ollama = createScriptedOllamaClient({
      chat: () => `\`\`\`json\n${VALID_RESPONSE}\n\`\`\``,
    })
    const candidates = await extractCandidates({ ollama, config }, 'call mom', EMPTY_SNAPSHOT)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'task', orientation: 'future_oneoff' })
    // A single (successful) attempt — tolerant parsing did NOT trigger the repair retry.
    expect(ollama.chatCalls).toHaveLength(1)
  })

  test('tolerates prose around the JSON object', async () => {
    const ollama = createScriptedOllamaClient({
      chat: () => `Sure! Here is the JSON:\n${VALID_RESPONSE}\nHope that helps.`,
    })
    const candidates = await extractCandidates({ ollama, config }, 'call mom', EMPTY_SNAPSHOT)
    expect(candidates).toHaveLength(1)
    expect(ollama.chatCalls).toHaveLength(1)
  })

  test('still parses pure clean JSON (regression)', async () => {
    const ollama = createScriptedOllamaClient({ chat: () => VALID_RESPONSE })
    const candidates = await extractCandidates({ ollama, config }, 'call mom', EMPTY_SNAPSHOT)
    expect(candidates).toHaveLength(1)
    expect(ollama.chatCalls).toHaveLength(1)
  })

  test('the repair retry re-sends the prior bad output plus a correction instruction', async () => {
    const badContent = 'oops not json'
    const ollama = createScriptedOllamaClient({
      chatQueue: [badContent, VALID_RESPONSE],
    })
    const candidates = await extractCandidates({ ollama, config }, 'call mom', EMPTY_SNAPSHOT)
    expect(candidates).toHaveLength(1)
    expect(ollama.chatCalls).toHaveLength(2)

    // The SECOND request is a repair: it still constrains decoding with the format schema, …
    const repairMessages = ollama.chatCalls[1]?.messages ?? []
    expect(ollama.chatCalls[1]?.format).toBe(extractionJsonSchema)
    // … it echoes the model's prior bad output as an assistant turn, …
    expect(repairMessages.some((m) => m.role === 'assistant' && m.content === badContent)).toBe(
      true,
    )
    // … and it adds a user instruction to reply with ONLY corrected JSON (the repair signal).
    expect(
      repairMessages.some((m) => m.role === 'user' && /only the corrected json/i.test(m.content)),
    ).toBe(true)
    // The original system AND user/bullet prompt are still present (repair appends, never replaces).
    expect(repairMessages.some((m) => m.role === 'system')).toBe(true)
    expect(repairMessages.some((m) => m.role === 'user' && m.content.includes('call mom'))).toBe(
      true,
    )
  })
})

describe('extractJsonObject (tolerant parsing helper)', () => {
  test('returns a bare JSON object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  test('strips a ```json code fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('strips a bare ``` fence', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('salvages the first balanced object from surrounding prose', () => {
    expect(extractJsonObject('Here is the JSON: {"a":{"b":1}} thanks')).toBe('{"a":{"b":1}}')
  })

  test('ignores braces inside string literals', () => {
    expect(extractJsonObject('{"a":"}{"}')).toBe('{"a":"}{"}')
  })

  test('handles an escaped backslash before the closing quote', () => {
    // Source '{"a":"\\\\"}' is the 9-char JSON {"a":"\\"} — one escaped backslash, then a real
    // closing quote. The escape tracker must not let the backslash swallow that quote.
    expect(extractJsonObject('{"a":"\\\\"}')).toBe('{"a":"\\\\"}')
  })

  test('handles an escaped quote inside a string', () => {
    // Source '{"a":"\\""}' is {"a":"\""} — the escaped quote stays inside the string literal.
    expect(extractJsonObject('{"a":"\\""}')).toBe('{"a":"\\""}')
  })

  test('returns undefined for a truncated/unbalanced object (no throw, no hang)', () => {
    expect(extractJsonObject('{"a":1')).toBeUndefined()
  })

  test('returns undefined when there is no object', () => {
    expect(extractJsonObject('not json at all')).toBeUndefined()
  })
})

describe('extractionResponseSchema', () => {
  test('defaults a missing fields object to {}', () => {
    const parsed = extractionResponseSchema.parse({
      candidates: [{ kind: 'task', orientation: 'future_oneoff', text: 'x', confidence: 0.5 }],
    })
    expect(parsed.candidates[0]?.fields).toEqual({})
  })
})
