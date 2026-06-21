import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import { createScriptedOllamaClient } from '../ollama/scripted'
import { extractCandidates } from './extract'
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
      trackers: [{ id: 't1', name: 'mood', input_type: 'scale' }],
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
})

describe('extractionResponseSchema', () => {
  test('defaults a missing fields object to {}', () => {
    const parsed = extractionResponseSchema.parse({
      candidates: [{ kind: 'task', orientation: 'future_oneoff', text: 'x', confidence: 0.5 }],
    })
    expect(parsed.candidates[0]?.fields).toEqual({})
  })
})
