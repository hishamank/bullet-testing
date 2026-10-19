/**
 * Decision 5: titles are a short phrase in the user's own words, with date and time moved into
 * the structured fields. English, French and Arabizi; all sample content is made up.
 */
import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import type { Candidate } from '../extraction/schema'
import { zonedToEpoch } from '../time/zoned'
import { resolveCandidates } from './resolve'
import { cleanTitle, stripTrailingPunctuation } from './title'

const PARIS = 'Europe/Paris'
// Thursday 2026-10-15 09:12 in Paris.
const CTX = { capturedAt: Date.UTC(2026, 9, 15, 7, 12), timezone: PARIS }
const paris = (day: number, hour = 0) =>
  zonedToEpoch({ year: 2026, month: 10, day, hour, minute: 0 }, PARIS)

describe('cleanTitle', () => {
  test.each([
    // English
    ['Dentist Thursday at 3pm.', 'Dentist'],
    ['Pay the electricity bill.', 'Pay the electricity bill'],
    ['call mom tomorrow', 'Call mom'],
    ['Call mom tomorrow about the trip!', 'Call mom about the trip'],
    ['Remind me to buy olive oil tomorrow.', 'Buy olive oil'],
    [
      'Need to check whether the car insurance covers windscreen damage.',
      'Check whether the car insurance covers windscreen damage',
    ],
    ['send the report to Nadine by Friday', 'Send the report to Nadine'],
    ['dinner with Sam on Saturday at 8pm', 'Dinner with Sam'],
    ['renew passport in 2 weeks', 'Renew passport'],
    ['meeting Oct 22 at 10:30', 'Meeting'],
    ['take the car to the garage before 10am', 'Take the car to the garage'],
    // French
    ['RDV chez le coiffeur jeudi 15h', 'RDV chez le coiffeur'],
    ['Demain réunion avec Karim à 15h', 'Réunion avec Karim'],
    ["Il faut appeler le plombier aujourd'hui.", 'Appeler le plombier'],
    ['acheter du pain ce soir', 'Acheter du pain'],
    ['dîner chez Léa vendredi prochain', 'Dîner chez Léa'],
    // Arabizi
    ['bukra lazem eb3at el report la Nadine', 'Eb3at el report la Nadine'],
    ['lazem eb3at el report la Nadine bukra', 'Eb3at el report la Nadine'],
    ['3azime 3and Rami el khamis', '3azime 3and Rami'],
    ['jib ghaz lal sayyara ba3d bukra', 'Jib ghaz lal sayyara'],
  ])('%s → %s', (title, want) => {
    expect(cleanTitle(title, CTX)).toBe(want)
  })

  test('keeps what no field holds: an unreadable date, a duration, the user’s casing', () => {
    // "this weekend" has no date in slice 1, so it stays in the title.
    expect(cleanTitle('Buy running shoes this weekend.', CTX)).toBe(
      'Buy running shoes this weekend',
    )
    expect(cleanTitle('practice piano 2h', CTX)).toBe('Practice piano 2h')
    expect(cleanTitle('iPhone screen repair tomorrow', CTX)).toBe('iPhone screen repair')
    expect(cleanTitle('Turn the lights on', CTX)).toBe('Turn the lights on')
    expect(cleanTitle('Call mom (about the trip)', CTX)).toBe('Call mom (about the trip)')
    expect(cleanTitle('اتصل بالبنك بكرا', CTX)).toBe('اتصل بالبنك')
  })

  test('never empty: a title that is only a date falls back to the thought, then itself', () => {
    expect(cleanTitle('tomorrow', CTX, { fallback: 'gym tomorrow' })).toBe('Gym')
    expect(cleanTitle('tomorrow.', CTX)).toBe('tomorrow')
  })

  test('trailing punctuation goes, in any script', () => {
    expect(stripTrailingPunctuation('Pay the bill...')).toBe('Pay the bill')
    expect(stripTrailingPunctuation('شو بدي اعمل؟')).toBe('شو بدي اعمل')
  })
})

describe('titles on extracted things', () => {
  const candidate = (c: Partial<Candidate>): Candidate => ({
    kind: 'task',
    orientation: 'future_oneoff',
    text: '',
    fields: {},
    confidence: 0.9,
    ...c,
  })

  test('"Dentist Thursday at 3pm." → "Dentist" with Thu 15:00 in the event', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'event',
          text: 'Dentist Thursday at 3pm.',
          fields: { title: 'Dentist Thursday at 3pm.', when: 'Thursday at 3pm' },
        }),
      ],
      { trackers: [], openTasks: [] },
      ENGINE_CONFIG_DEFAULTS,
      CTX,
    )
    expect(suggestions[0]).toMatchObject({
      target_kind: 'event',
      payload: { title: 'Dentist', starts_at: paris(15, 15) },
    })
  })

  test('the date moves to due_at, in French and Arabizi', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({ text: 'acheter du pain demain', fields: { title: 'acheter du pain demain' } }),
        candidate({
          text: 'bukra lazem eb3at el report la Nadine',
          fields: { title: 'bukra lazem eb3at el report la Nadine', when: 'bukra' },
        }),
      ],
      { trackers: [], openTasks: [] },
      ENGINE_CONFIG_DEFAULTS,
      CTX,
    )
    expect(suggestions.map((s) => [s.payload.title, s.payload.due_at])).toEqual([
      ['Acheter du pain', paris(16)],
      ['Eb3at el report la Nadine', paris(16)],
    ])
  })

  test('an activity name loses its date too ("went for a walk yesterday")', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'activity',
          orientation: 'happened',
          text: 'went for a walk yesterday',
          fields: { name: 'went for a walk yesterday.' },
        }),
      ],
      { trackers: [], openTasks: [] },
      ENGINE_CONFIG_DEFAULTS,
      CTX,
    )
    expect(suggestions[0]?.payload.name).toBe('Went for a walk')
  })
})
