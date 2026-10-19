import { REFLECTIVE_CAPS } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import { EngineError } from '../errors'
import { createScriptedLlmClient } from '../llm/scripted'
import { mayPickEvergreen, type ReflectiveState, reflectiveRefusal } from './caps'
import {
  REFLECT_SYSTEM_PROMPT,
  type ReflectableThought,
  reflectionJsonSchema,
  reflectOnThoughts,
  validateReflection,
} from './reflect'

const config = ENGINE_CONFIG_DEFAULTS
const WORRY: ReflectableThought = {
  position: 2,
  kind: 'worry',
  text: "I'm dreading Monday's meeting with Karim",
}
const IDEA: ReflectableThought = {
  position: 4,
  kind: 'idea',
  text: 'ouvrir un petit café à Beyrouth',
}

const answer = (o: Record<string, unknown>) => JSON.stringify(o)

describe('reflectOnThoughts', () => {
  test('one question quoting the user, about the right thought, after one model call', async () => {
    const llm = createScriptedLlmClient({
      chatQueue: [
        answer({
          ask: true,
          thought: 2,
          quote: 'un petit café',
          question: 'Tu as écrit «un petit café». Qu’est-ce qui t’attire dans cette idée ?',
        }),
      ],
    })
    const q = await reflectOnThoughts({ llm, config }, [WORRY, IDEA])
    expect(q).toEqual({
      thoughtPosition: 4,
      quote: 'un petit café',
      text: 'Tu as écrit «un petit café». Qu’est-ce qui t’attire dans cette idée ?',
    })
    expect(llm.chatCalls).toHaveLength(1)
    const req = llm.chatCalls[0]!
    expect(req.jsonSchema).toBe(reflectionJsonSchema)
    expect(req.messages[1]?.content).toContain(
      "1. [worry] I'm dreading Monday's meeting with Karim",
    )
    expect(req.messages[1]?.content).toContain('2. [idea] ouvrir un petit café à Beyrouth')
  })

  test('the prompt: about what they said, never what they should do; their words and language', () => {
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/Ask about what they said, never what they should do/)
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/same language as the words you quote/)
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/Never translate/)
    // The quote is decoded before the question.
    const props = Object.keys((reflectionJsonSchema as any).properties)
    expect(props.indexOf('quote')).toBeLessThan(props.indexOf('question'))
  })

  test('no reflectable thought: no model call, no question', async () => {
    const llm = createScriptedLlmClient({ chatQueue: [] })
    const q = await reflectOnThoughts({ llm, config }, [
      { position: 0, kind: 'task', text: 'call the bank' },
    ])
    expect(q).toBeNull()
    expect(llm.chatCalls).toHaveLength(0)
  })

  test.each([
    ['not JSON', 'Sure! Here is a question.'],
    ['wrong shape', answer({ ask: 'yes' })],
    ['declined', answer({ ask: false, thought: 0, quote: '', question: '' })],
    ['unknown thought', answer({ ask: true, thought: 7, quote: 'Monday', question: '«Monday»?' })],
    [
      'quote not their words',
      answer({
        ask: true,
        thought: 1,
        quote: 'fear of work',
        question: 'You wrote «fear of work». What is it?',
      }),
    ],
    [
      'question without the quote',
      answer({
        ask: true,
        thought: 1,
        quote: "dreading Monday's meeting",
        question: 'What feels heavy about it?',
      }),
    ],
    [
      'not a question',
      answer({
        ask: true,
        thought: 1,
        quote: "dreading Monday's meeting",
        question: "You wrote «dreading Monday's meeting».",
      }),
    ],
    [
      'advice',
      answer({
        ask: true,
        thought: 1,
        quote: "dreading Monday's meeting",
        question: "You wrote «dreading Monday's meeting». Have you tried preparing notes?",
      }),
    ],
    [
      'advice in French',
      answer({
        ask: true,
        thought: 1,
        quote: "dreading Monday's meeting",
        question: "«dreading Monday's meeting»: tu devrais en parler, non ?",
      }),
    ],
    [
      'too long',
      answer({
        ask: true,
        thought: 1,
        quote: "dreading Monday's meeting",
        question: `You wrote «dreading Monday's meeting», ${'and so on '.repeat(30)}?`,
      }),
    ],
  ])('bad output means no question: %s', async (_label, content) => {
    const llm = createScriptedLlmClient({ chatQueue: [content] })
    expect(await reflectOnThoughts({ llm, config }, [WORRY])).toBeNull()
  })

  test('the model being unreachable throws (the job retries later)', async () => {
    const llm = createScriptedLlmClient({ chatQueue: [] })
    await expect(reflectOnThoughts({ llm, config }, [WORRY])).rejects.toBeInstanceOf(EngineError)
  })

  test('the quote is matched leniently (case, spacing, trailing punctuation)', () => {
    expect(
      validateReflection(
        {
          ask: true,
          thought: 1,
          quote: "Dreading  Monday's meeting.",
          question: "You wrote «dreading Monday's meeting». What about it feels heavy?",
        },
        [WORRY],
      ),
    ).toMatchObject({ thoughtPosition: 2 })
  })
})

describe('reflective caps', () => {
  const NOW = 100 * 24 * 60 * 60 * 1000
  const DAY = 24 * 60 * 60 * 1000
  const fresh: ReflectiveState = {
    open: 0,
    createdLastDay: 0,
    lastCaptureAt: NOW - DAY,
    lastEvergreenAt: null,
    lastSensitiveAt: null,
  }

  test('at most 3 open and 2 new a day, for every origin', () => {
    for (const origin of ['capture', 'open_loop', 'evergreen'] as const) {
      expect(reflectiveRefusal(origin, fresh, NOW), origin).toBeNull()
      expect(reflectiveRefusal(origin, { ...fresh, open: 3 }, NOW), origin).toBe('open_cap')
      expect(reflectiveRefusal(origin, { ...fresh, createdLastDay: 2 }, NOW), origin).toBe(
        'daily_cap',
      )
    }
    expect(reflectiveRefusal('capture', { ...fresh, open: 2, createdLastDay: 1 }, NOW)).toBeNull()
  })

  test('nothing after 14 days without a capture', () => {
    const quiet = { ...fresh, lastCaptureAt: NOW - REFLECTIVE_CAPS.quietAfterMs }
    expect(reflectiveRefusal('capture', quiet, NOW)).toBe('quiet')
    expect(reflectiveRefusal('open_loop', { ...fresh, lastCaptureAt: null }, NOW)).toBe('quiet')
    expect(reflectiveRefusal('capture', { ...quiet, lastCaptureAt: NOW - 13 * DAY }, NOW)).toBe(
      null,
    )
  })

  test('evergreen: only alone, every 3 days, paused 7 days after a sensitive thought', () => {
    expect(reflectiveRefusal('evergreen', { ...fresh, open: 1 }, NOW)).toBe('evergreen_not_alone')
    expect(reflectiveRefusal('evergreen', { ...fresh, lastEvergreenAt: NOW - 2 * DAY }, NOW)).toBe(
      'evergreen_too_soon',
    )
    expect(
      reflectiveRefusal('evergreen', { ...fresh, lastEvergreenAt: NOW - 3 * DAY }, NOW),
    ).toBeNull()
    expect(reflectiveRefusal('evergreen', { ...fresh, lastSensitiveAt: NOW - 6 * DAY }, NOW)).toBe(
      'sensitive_pause',
    )
    expect(
      reflectiveRefusal('evergreen', { ...fresh, lastSensitiveAt: NOW - 7 * DAY }, NOW),
    ).toBeNull()
    // The pause is for evergreen questions only.
    expect(reflectiveRefusal('capture', { ...fresh, lastSensitiveAt: NOW }, NOW)).toBeNull()
  })

  test('a picked evergreen question may go one over the open cap', () => {
    expect(mayPickEvergreen(3)).toBe(true)
    expect(mayPickEvergreen(4)).toBe(false)
  })
})
