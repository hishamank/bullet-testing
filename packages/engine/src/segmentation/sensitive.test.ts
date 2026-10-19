import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import { createScriptedLlmClient } from '../llm/scripted'
import { SEGMENTATION_SYSTEM_PROMPT, segmentCapture } from './segment'
import { looksSensitive } from './sensitive'

const CTX = { capturedAt: Date.UTC(2026, 9, 15, 7, 12), timezone: 'Europe/Paris' }
const config = ENGINE_CONFIG_DEFAULTS

describe('sensitive thoughts', () => {
  test.each([
    'sometimes I want to die',
    "I don't want to wake up tomorrow",
    'thinking about killing myself',
    'je veux mourir',
    "j'ai plus envie de vivre",
    'bade moot',
    'بدي موت',
  ])('plain crisis words are flagged: %s', (text) => {
    expect(looksSensitive(text)).toBe(true)
  })

  test.each([
    "I'm worried about the rent",
    'so tired after work, bad day',
    'dying to see the new movie',
    'killed it at the gym today',
    'stressed about the exam',
  ])('ordinary worries are not: %s', (text) => {
    expect(looksSensitive(text)).toBe(false)
  })

  test('the prompt asks for the flag, conservatively, and the wire schema carries it', () => {
    expect(SEGMENTATION_SYSTEM_PROMPT).toMatch(/"sensitive": true when/)
    expect(SEGMENTATION_SYSTEM_PROMPT).toMatch(
      /If you are unsure whether it is that serious, use true/,
    )
  })

  test("the model's flag, or the backstop, marks the thought; others stay false", async () => {
    const text = 'Call the bank. Everything feels too much. I want to die.'
    const llm = createScriptedLlmClient({
      chat: () =>
        JSON.stringify({
          thoughts: [
            { quote: 'Call the bank.', text: 'Call the bank', kind: 'task', sensitive: false },
            {
              quote: 'Everything feels too much.',
              text: 'Everything feels too much',
              kind: 'note',
              sensitive: true,
            },
            // The model missed it; the words say it plainly.
            { quote: 'I want to die.', text: 'I want to die', kind: 'note', sensitive: false },
          ],
        }),
    })
    const thoughts = await segmentCapture({ llm, config }, { text, ...CTX })
    expect(thoughts.map((t) => [t.kind, t.sensitive])).toEqual([
      ['task', false],
      ['note', true],
      ['note', true],
    ])
  })

  test('an older model answer without the flag reads as not sensitive', async () => {
    const llm = createScriptedLlmClient({
      chat: () => JSON.stringify({ thoughts: [{ quote: 'hello', text: 'hello', kind: 'note' }] }),
    })
    const [t] = await segmentCapture({ llm, config }, { text: 'hello', ...CTX })
    expect(t?.sensitive).toBe(false)
  })
})
