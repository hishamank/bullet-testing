import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from './config'
import type { Candidate } from './extraction/schema'
import { createScriptedLlmClient } from './llm/scripted'
import type { LlmChatRequest } from './llm/types'
import { processCapture } from './pipeline'
import { chunkText, SEGMENTATION_SYSTEM_PROMPT, segmentCapture } from './segmentation/segment'

const config = ENGINE_CONFIG_DEFAULTS
// Thursday 2026-10-15 09:12 in Paris.
const CTX = { capturedAt: Date.UTC(2026, 9, 15, 7, 12), timezone: 'Europe/Paris' }
const EMPTY = { trackers: [], openTasks: [] }

type Seg = { text: string; quote?: string; kind: string }

const isSegmentation = (req: LlmChatRequest) =>
  req.messages[0]?.content === SEGMENTATION_SYSTEM_PROMPT
const body = (req: LlmChatRequest) =>
  /"""\n([\s\S]*?)\n"""/.exec(req.messages[1]?.content ?? '')?.[1] ?? ''

/** A scripted model: segmentation answers by chunk text, extraction by thought text. */
function scripted(
  seg: (chunk: string) => Seg[],
  extract: (thought: string) => Partial<Candidate>[] = () => [],
) {
  return createScriptedLlmClient({
    chat: (req) =>
      isSegmentation(req)
        ? JSON.stringify({ thoughts: seg(body(req)) })
        : JSON.stringify({
            candidates: extract(body(req)).map((c) => ({
              kind: 'task',
              orientation: 'future_oneoff',
              text: body(req),
              fields: {},
              confidence: 0.9,
              ...c,
            })),
          }),
  })
}

describe('chunkText', () => {
  test('short text is one chunk', () => {
    expect(chunkText('hello there')).toEqual([{ text: 'hello there', offset: 0 }])
  })

  test('long text is cut at sentence ends; chunks cover it exactly', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i}.`)
    const text = sentences.join(' ')
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(200)
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text)
      expect(c.text.trimEnd().endsWith('.')).toBe(true)
    }
  })
})

describe('segmentCapture', () => {
  test('splits into ordered thoughts with kinds and spans into the capture text', async () => {
    const text = "Um I'm worried about the rent. Call the landlord tomorrow. Should I move?"
    const llm = scripted(() => [
      { text: "I'm worried about the rent", quote: "I'm worried about the rent.", kind: 'worry' },
      { text: 'Call the landlord tomorrow', quote: 'Call the landlord tomorrow.', kind: 'task' },
      { text: 'Should I move?', quote: 'Should I move?', kind: 'question' },
    ])
    const thoughts = await segmentCapture({ llm, config }, { text, ...CTX })
    expect(thoughts.map((t) => [t.position, t.kind])).toEqual([
      [0, 'worry'],
      [1, 'task'],
      [2, 'question'],
    ])
    for (const t of thoughts) {
      expect(t.span).not.toBeNull()
      expect(text.slice(t.span?.start, t.span?.end)).toMatch(/rent|landlord|move/)
    }
    expect(llm.chatCalls[0]?.messages[1]?.content).toContain('Written on Thursday 2026-10-15 09:12')
  })

  test('a paraphrased quote that cannot be found gets span null (the thought is still kept)', async () => {
    const llm = scripted(() => [{ text: 'cleaned', quote: 'not in the text', kind: 'note' }])
    const [t] = await segmentCapture({ llm, config }, { text: 'something else entirely', ...CTX })
    expect(t).toMatchObject({ text: 'cleaned', span: null })
  })

  test('nothing is lost: a chunk with no thoughts becomes one note', async () => {
    const llm = scripted(() => [])
    const thoughts = await segmentCapture(
      { llm, config },
      { text: '  hmm, nothing much  ', ...CTX },
    )
    expect(thoughts).toEqual([
      { position: 0, text: 'hmm, nothing much', kind: 'note', span: { start: 2, end: 19 } },
    ])
  })

  test('a long ramble is segmented chunk by chunk; positions and spans stay global', async () => {
    const parts = Array.from(
      { length: 12 },
      (_, i) => `Thought number ${i} about something important.`,
    )
    const text = parts.join(' ')
    const llm = scripted((chunk) =>
      chunk
        .split(/(?<=\.)\s*/)
        .filter((s) => s.trim())
        .map((s) => ({ text: s.trim(), quote: s.trim(), kind: 'note' })),
    )
    const thoughts = await segmentCapture({ llm, config }, { text, ...CTX }, { chunkChars: 120 })
    expect(llm.chatCalls.length).toBeGreaterThan(3)
    expect(llm.chatCalls[1]?.messages[1]?.content).toMatch(/part 2 of \d+ of a long capture/)
    expect(thoughts.map((t) => t.position)).toEqual(thoughts.map((_, i) => i))
    expect(thoughts).toHaveLength(12)
    for (const [i, t] of thoughts.entries()) {
      expect(text.slice(t.span?.start, t.span?.end)).toBe(parts[i])
    }
  })
})

describe('processCapture: capture → thoughts → things', () => {
  test('things are extracted per actionable thought only, tagged with their thought', async () => {
    const llm = scripted(
      () => [
        { text: 'worried about the rent', kind: 'worry' },
        { text: 'call the landlord tomorrow', kind: 'task' },
        { text: 'an idea for a garden', kind: 'idea' },
        { text: 'check if the lease ends in March', kind: 'to_check' },
      ],
      (thought) => [
        { fields: { title: thought, when: thought.includes('tomorrow') ? 'tomorrow' : undefined } },
      ],
    )
    const out = await processCapture({ llm, config }, { text: 'a long ramble', ...CTX }, EMPTY)
    expect(out.thoughts).toHaveLength(4)
    // 1 segmentation call + extraction for the task and the to_check thoughts only.
    expect(llm.chatCalls).toHaveLength(3)
    expect(out.things.map((t) => [t.thoughtPosition, t.target_kind, t.payload.title])).toEqual([
      [1, 'task', 'call the landlord tomorrow'],
      [3, 'task', 'check if the lease ends in March'],
    ])
  })

  test('clarifying questions: an ambiguous weekday asks "Which Thursday?" about its thing', async () => {
    const llm = scripted(
      () => [{ text: 'dentist Thursday', kind: 'event' }],
      () => [{ kind: 'event', fields: { title: 'dentist', when: 'Thursday' } }],
    )
    const out = await processCapture({ llm, config }, { text: 'dentist Thursday', ...CTX }, EMPTY)
    expect(out.questions).toEqual([
      {
        topic: 'date',
        text: 'Which Thursday for "dentist"?',
        options: ['Today', 'Next Thursday'],
        thoughtPosition: 0,
        thingIndex: 0,
      },
    ])
  })

  test('an unreadable date asks; a clear one does not', async () => {
    const llm = scripted(
      () => [
        { text: 'pay the plumber when he is back', kind: 'task' },
        { text: 'gym tomorrow 7am', kind: 'event' },
      ],
      (t) =>
        t.startsWith('pay')
          ? [{ fields: { title: 'pay the plumber', when: 'when he is back' } }]
          : [{ kind: 'event', fields: { title: 'gym', when: 'tomorrow 7am' } }],
    )
    const out = await processCapture({ llm, config }, { text: 'x', ...CTX }, EMPTY)
    expect(out.questions.map((q) => [q.topic, q.thingIndex])).toEqual([['date', 0]])
  })

  test('a reading with no tracker asks "Start tracking …?"', async () => {
    const llm = scripted(
      () => [{ text: 'slept 6 hours', kind: 'tracker' }],
      () => [
        { kind: 'tracker_entry', orientation: 'happened', fields: { name: 'sleep', value: 6 } },
      ],
    )
    const out = await processCapture({ llm, config }, { text: 'slept 6 hours', ...CTX }, EMPTY)
    expect(out.things[0]?.target_kind).toBe('activity')
    expect(out.questions[0]).toMatchObject({
      topic: 'new_tracker',
      text: 'Start tracking "sleep"?',
      options: ['Yes', 'No'],
    })
  })

  test('at most 3 questions per capture, date questions first', async () => {
    const llm = scripted(
      () => Array.from({ length: 5 }, (_, i) => ({ text: `reading ${i}`, kind: 'tracker' })),
      (t) => [{ kind: 'tracker_entry', orientation: 'happened', fields: { name: t, value: 1 } }],
    )
    const out = await processCapture({ llm, config }, { text: 'x', ...CTX }, EMPTY)
    expect(out.things).toHaveLength(5)
    expect(out.questions).toHaveLength(3)
  })
})

describe('processCapture: duplicate candidates within one thought', () => {
  test('two identical tasks from one thought become one thing', async () => {
    const garage = { fields: { title: 'take the car to the garage', when: 'tomorrow 10:00' } }
    const llm = scripted(
      () => [{ text: 'take the car to the garage tomorrow at 10', kind: 'task' }],
      () => [garage, garage],
    )
    const out = await processCapture({ llm, config }, { text: 'x', ...CTX }, EMPTY)
    expect(out.things).toHaveLength(1)
    expect(out.things[0]).toMatchObject({
      target_kind: 'task',
      payload: { title: 'take the car to the garage' },
    })
    expect(out.duplicates).toBe(1)
  })

  test('case, whitespace and key order do not make a duplicate distinct (Arabic too)', async () => {
    const llm = scripted(
      () => [{ text: 'اتصل بالبنك', kind: 'task' }],
      () => [
        { fields: { title: 'اتصل بالبنك' } },
        { fields: { title: '  اتصل  بالبنك ' } },
        { text: 'x', fields: { title: 'اتصل بالبنك' } },
      ],
    )
    const out = await processCapture({ llm, config }, { text: 'اتصل بالبنك', ...CTX }, EMPTY)
    expect(out.things.map((t) => t.payload.title)).toEqual(['اتصل بالبنك'])
    expect(out.duplicates).toBe(2)
  })

  test('three identical events collapse; their question points at the kept thing, once', async () => {
    const reunion: Partial<Candidate> = {
      kind: 'event',
      fields: { title: 'Réunion avec Karim', when: 'Thursday 15:00' },
    }
    const llm = scripted(
      () => [
        { text: 'call mom', kind: 'task' },
        { text: 'Demain réunion avec Karim à 15h', kind: 'event' },
      ],
      (t) => (t === 'call mom' ? [{ fields: { title: 'call mom' } }] : [reunion, reunion, reunion]),
    )
    const out = await processCapture({ llm, config }, { text: 'x', ...CTX }, EMPTY)
    expect(out.things.map((t) => [t.thoughtPosition, t.target_kind])).toEqual([
      [0, 'task'],
      [1, 'event'],
    ])
    expect(out.duplicates).toBe(2)
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0]).toMatchObject({ topic: 'date', thoughtPosition: 1, thingIndex: 1 })
  })

  test('different payloads and the same thing in two thoughts are both kept', async () => {
    const llm = scripted(
      () => [
        { text: 'buy milk', kind: 'task' },
        { text: 'buy milk', kind: 'task' },
      ],
      () => [
        { fields: { title: 'buy milk' } },
        { fields: { title: 'buy milk', when: 'tomorrow' } },
      ],
    )
    const out = await processCapture({ llm, config }, { text: 'x', ...CTX }, EMPTY)
    expect(out.things).toHaveLength(4)
    expect(out.duplicates).toBe(0)
  })
})
