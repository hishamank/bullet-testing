/**
 * Readings (decision 3): the value a "happened" thought carries — a number, a duration or a scale
 * ("slept 6 hours", "meditated 20 minutes", "mood 3", "mood 2 sur 5", "ran 5k"). A reading must
 * never be lost to a value-less activity: when the model dropped the value, or put it under a key
 * the resolver did not read (`duration`), it is recovered here deterministically.
 */

import { isNameFiller } from './naming'

export interface Reading {
  value: number
  /** Normalised unit ("h", "min", "km", "kg", "glasses", …), or null for a bare number / scale. */
  unit: string | null
  /** Set when the reading named its scale ("3/5", "2 sur 5", "3 out of 5"). */
  scale: { min: number; max: number } | null
  /** The words that said it ("6 hours"), when read from text. */
  phrase?: string
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 0.5,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
}
const NUM = `(?<![\\p{L}\\d.,])(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`

const toNumber = (s: string): number => NUMBER_WORDS[s] ?? Number(s.replace(',', '.'))

const UNIT_ALIASES: [RegExp, string][] = [
  [/^(h|hr|hrs|hour|hours|heure|heures|sa3a|sa3at|se3a|se3at|ساعة|ساعات)$/, 'h'],
  [/^(min|mins|minute|minutes|da2i2a|d2i2a|دقيقة|دقائق)$/, 'min'],
  [/^(k|km|kms|kilometers?|kilometres?)$/, 'km'],
  [/^(mi|mile|miles)$/, 'mi'],
  [/^(kg|kgs|kilos?)$/, 'kg'],
  [/^(lb|lbs|pounds?)$/, 'lb'],
  [/^(l|liters?|litres?)$/, 'l'],
  [/^(steps?|pas)$/, 'steps'],
]

/** "hours" → "h", "km" stays, "glasses" stays: a short, stable unit for the tracker config. */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (typeof unit !== 'string') return null
  const u = unit.trim().toLowerCase()
  if (u === '') return null
  for (const [re, canonical] of UNIT_ALIASES) if (re.test(u)) return canonical
  return u
}

/** Convert between duration units; null when the units are not both durations. */
export function convertDuration(
  value: number,
  from: string | null,
  to: string | null,
): number | null {
  if (from === to) return value
  if (from === 'h' && to === 'min') return value * 60
  if (from === 'min' && to === 'h') return Math.round((value / 60) * 100) / 100
  return null
}

const COUNT_NOUNS =
  'glass(?:es)?|cups?|bottles?|cigarettes?|clopes?|coffees?|cafés?|beers?|pages?|reps?|sets?|pills?|verres?|tasses?|bi[e]res?'

/** Plural nouns that are spans of time or filler, never a count of something done. */
const NOT_COUNTS =
  /^(fois|seconds|days|weeks|months|years|ages|jours|semaines|mois|ans|années|annees|nights|mornings|evenings|others|things|ones|minutes|hours|heures)$/

/** Words ending in s/x that are not things counted ("7 this morning", "3 was ok", "3 mais"). */
const FUNCTION_WORDS = new Set([
  'this',
  'was',
  'has',
  'yes',
  'thanks',
  'plus',
  'as',
  'us',
  'is',
  'its',
  'his',
  'hers',
  'ours',
  'yours',
  'theirs',
  'always',
  'perhaps',
  'besides',
  'afterwards',
  'towards',
  'mais',
  'pas',
  'puis',
  'alors',
  'dans',
  'sans',
  'sous',
  'très',
  'tres',
  'après',
  'apres',
  'depuis',
  'jamais',
  'toujours',
  'moins',
  'vers',
  'bas',
  'fois',
  'mes',
  'tes',
  'ses',
  'les',
  'des',
  'ces',
  'nous',
  'vous',
  'deux',
  'trois',
  'six',
  'dix',
  'mieux',
  'ailleurs',
  'parfois',
])

/** A date or part of day right after: "7 this morning" is not "7 this". */
const DATE_AFTER =
  /^\s*(?:morning|afternoon|evening|night|week|weekend|today|tonight|tomorrow|yesterday|matin|soir|nuit|semaine|aujourd|demain|hier)\b/

/** A plural noun that can be the unit of a count ("pushups", "pizzas", "emails"). */
function isCountNoun(word: string): boolean {
  const w = word.toLowerCase()
  return w.length >= 3 && !NOT_COUNTS.test(w) && !FUNCTION_WORDS.has(w) && !isNameFiller(w)
}

/** A clock time is not a duration: "at 11pm", "à 15h", "vers 7h". */
const AT_TIME = /(?:^|\s)(?:at|à|vers|3al|3a|@)\s*$/

/**
 * The reading in a text, or null. `allowBare` also accepts a lone number ("mood 3") — only when
 * the text is known to be a reading (a `tracker` thought or a tracker_entry candidate).
 */
export function readingFromText(text: string, opts: { allowBare: boolean }): Reading | null {
  const s = ` ${text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')} `

  const scale = new RegExp(
    `${NUM}\\s*(?:/|out of|over|sur|from|3a)\\s*(\\d+)(?![\\d/.:])`,
    'u',
  ).exec(s)
  if (scale) {
    const value = toNumber(scale[1] ?? '')
    const max = Number(scale[2])
    if (Number.isFinite(value) && max > 0 && max <= 100 && value <= max) {
      return {
        value,
        unit: null,
        scale: { min: value === 0 ? 0 : max === 100 ? 0 : 1, max },
        phrase: scale[0].trim(),
      }
    }
  }

  // Durations ("6 hours", "6h", "7h30", "20 minutes", "six hours", "2 heures"), measures ("5k",
  // "72 kg") and counts ("3 glasses"). "Ran 5k in 30 min" holds two: the first one said wins.
  const found: { at: number; reading: Reading }[] = []
  const hours = new RegExp(
    `${NUM}\\s*(?:hours?|hrs?|h|heures?|sa3at|sa3a|se3at|ساعات|ساعة)(?:\\s*(\\d{1,2})\\s*(?:min(?:ute)?s?|m)?)?(?![\\p{L}\\d])`,
    'u',
  ).exec(s)
  if (hours && !AT_TIME.test(s.slice(0, hours.index))) {
    const h = toNumber(hours[1] ?? '')
    const m = hours[2] ? Number(hours[2]) : 0
    if (Number.isFinite(h) && h <= 48) {
      found.push({
        at: hours.index,
        reading: {
          value: Math.round((h + m / 60) * 100) / 100,
          unit: 'h',
          scale: null,
          phrase: hours[0].trim(),
        },
      })
    }
  }
  const minutes = new RegExp(
    `${NUM}\\s*(?:minutes?|mins?|da2i2a|d2i2a|دقيقة|دقائق)(?![\\p{L}\\d])`,
    'u',
  ).exec(s)
  if (minutes) {
    found.push({
      at: minutes.index,
      reading: {
        value: toNumber(minutes[1] ?? ''),
        unit: 'min',
        scale: null,
        phrase: minutes[0].trim(),
      },
    })
  }
  const measured = new RegExp(
    `${NUM}\\s*(km|kms|k|miles?|mi|kgs?|kilos?|lbs?|pounds?|liters?|litres?|l|steps|pas)(?![\\p{L}\\d])`,
    'u',
  ).exec(s)
  if (measured && !AT_TIME.test(s.slice(0, measured.index))) {
    found.push({
      at: measured.index,
      reading: {
        value: toNumber(measured[1] ?? ''),
        unit: normalizeUnit(measured[2]),
        scale: null,
        phrase: measured[0].trim(),
      },
    })
  }
  const counted = new RegExp(`${NUM}\\s+(${COUNT_NOUNS})(?![\\p{L}\\d])`, 'u').exec(s)
  if (counted) {
    found.push({
      at: counted.index,
      reading: {
        value: toNumber(counted[1] ?? ''),
        unit: normalizeUnit(counted[2]),
        scale: null,
        phrase: counted[0].trim(),
      },
    })
  }
  // Any other counted thing ("did 30 pushups", "ate 2 pizzas"): the noun is the unit. Last, so a
  // known measure said at the same place wins; spans of time ("3 days ago") are not readings.
  const generic = new RegExp(`${NUM}\\s+(\\p{L}{2,}(?:s|x))(?![\\p{L}\\d])`, 'u').exec(s)
  if (
    generic &&
    isCountNoun(generic[2] ?? '') &&
    !AT_TIME.test(s.slice(0, generic.index)) &&
    !DATE_AFTER.test(s.slice(generic.index + generic[0].length))
  ) {
    found.push({
      at: generic.index,
      reading: {
        value: toNumber(generic[1] ?? ''),
        unit: normalizeUnit(generic[2]),
        scale: null,
        phrase: generic[0].trim(),
      },
    })
  }
  const first = found.sort((a, b) => a.at - b.at)[0]
  if (first) return first.reading

  if (opts.allowBare) {
    // A lone number that is not a clock time or a date ("mood 3", "weight 72.5").
    for (const m of s.matchAll(/(?<![\d/:.,])(\d+(?:[.,]\d+)?)(?![\d/:]|\s*(?:am|pm|h\d))/g)) {
      if (AT_TIME.test(s.slice(0, m.index))) continue
      return { value: toNumber(m[1] ?? ''), unit: null, scale: null, phrase: m[1] ?? '' }
    }
  }
  return null
}

/** Keys a model puts a reading's number under (Qwen3.5-4B: `value`, `quantity`, `duration`). */
const VALUE_KEYS = [
  'value',
  'quantity',
  'duration',
  'amount',
  'count',
  'number',
  'distance',
  'hours',
  'minutes',
] as const

/**
 * The reading in a candidate's fields: a number under any of {@link VALUE_KEYS} (or a numeric
 * string, or a phrase like "6 hours"), with its unit from `unit` or the key (`hours`, `minutes`).
 */
export function readingFromFields(fields: Record<string, unknown>): Reading | null {
  for (const key of VALUE_KEYS) {
    const v = fields[key]
    let value: number | null = null
    let unit = normalizeUnit(typeof fields.unit === 'string' ? fields.unit : null)
    if (typeof v === 'number' && Number.isFinite(v)) value = v
    else if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim().replace(',', '.'))
      if (Number.isFinite(n)) value = n
      else {
        const parsed = readingFromText(v, { allowBare: true })
        if (parsed) return unit ? { ...parsed, unit } : parsed
      }
    }
    if (value === null) continue
    if (key === 'hours') unit = 'h'
    if (key === 'minutes') unit = 'min'
    const max = typeof fields.max === 'number' && fields.max > value ? fields.max : null
    return {
      value,
      unit,
      scale:
        max !== null && max <= 100
          ? { min: typeof fields.min === 'number' ? fields.min : 1, max }
          : null,
    }
  }
  return null
}
