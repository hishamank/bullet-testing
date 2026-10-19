/**
 * Titles (decision 5): a short phrase in the user's own words — "Dentist" (Thu 15:00 is in the
 * event's fields), "Pay the electricity bill" — never a paraphrase or a translation.
 *
 * Deterministic, after extraction, with the model's title as input:
 *  - date and time phrases are removed, but only ones the date reader (time/when.ts) can read, so
 *    nothing the structured fields don't hold is ever dropped ("this weekend" stays);
 *  - a reminder lead-in ("Remind me to", "Need to", "Il faut") goes;
 *  - dangling connectors and trailing punctuation go;
 *  - the first letter is capitalised when the phrase starts in lowercase Latin letters.
 * The user's spelling, language and script are kept. Works on English, French and Arabizi.
 */

import { type CaptureContext, resolveWhen, type WhenDirection } from '../time/when'

const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'

const WEEKDAYS =
  'monday|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sunday|' +
  'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|' +
  "(?:(?:e|e?l|nhar)[ ']?)?(?:tanein|taneyn|tleteh|telet|tlete|arb3a|arba3a|khamis|5amis|jum3a|jem3a|jom3a|sabt|a7ad|ahad)|" +
  'الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت|الأحد'

const PART_OF_DAY = 'morning|afternoon|evening|night|matin|soir|après-midi|apres-midi'

const DAY_WORDS = [
  'the day after tomorrow',
  'day after tomorrow',
  "aujourd['’]hui",
  'après[- ]demain',
  'apres[- ]demain',
  'avant[- ]hier',
  'tomorrow',
  'tmrw',
  'tmr',
  'tonight',
  'today',
  'yesterday',
  'last night',
  'demain',
  'hier',
  'ce soir',
  'ce matin',
  'cet après-midi',
  'cette nuit',
  'ba3e?d bu?o?kra',
  'bu?o?krah?',
  'bkra',
  "(?:e?l[ ']?)?y(?:o|ou|aw)m",
  "(?:e?l[ ']?)?leyle",
  "(?:e?l[ ']?)?sob7",
  'e?mb[ae]re?7',
  'mberi7',
  'بكرا',
  'بكرة',
  'اليوم',
  'مبارح',
  'الليلة',
  `(?:(?:next|this|coming|last|on)\\s+)?(?:${WEEKDAYS})(?:\\s+(?:prochaine?|derni[eè]re?|${PART_OF_DAY}))?`,
].join('|')

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|' +
  'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre'

const DATES = [
  '\\d{4}-\\d{2}-\\d{2}',
  `(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?`,
  `\\d{1,2}(?:st|nd|rd|th|er)?\\s+(?:of\\s+)?(?:${MONTHS})`,
].join('|')

const TIMES = [
  '\\d{1,2}(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)',
  '(?:[01]?\\d|2[0-3])[:h][0-5]\\d',
  'noon',
  'midday',
  'midnight',
  'midi',
  'minuit',
  "\\d{1,2}\\s*o['’]clock",
].join('|')

/** French "15h": a time only after "à"/"vers"/… or a day ("slept 6h" is not). */
const HOUR_H = '(?:[01]?\\d|2[0-3])h'

const RELATIVE =
  '(?:in|dans|ba3d)\\s+(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|une?|deux|trois)\\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?|heures?|jours?|semaines?|da2aye2|se3at|iyyem|jem3a)'

/** A connector that only introduced the date/time: "at", "on", "by", "à", "le", "3al", "abel". */
const LEAD = `(?:(?:at|on|by|before|from|until|till|around|for|à|a|le|la|vers|avant|pour|jusqu'à|dès|3al|3a|abel|2abel|abl|2abl|qabl|l|el)\\s+)*`

const DAY_RE = new RegExp(
  `${B}${LEAD}(?:${DAY_WORDS}|${DATES})(?:\\s*,?\\s*${LEAD}(?:${TIMES}|${HOUR_H}))?${E}`,
  'giu',
)
const TIME_RE = new RegExp(`${B}${LEAD}(?:${TIMES})${E}`, 'giu')
const TIME_H_RE = new RegExp(
  `${B}(?:at|à|a|vers|avant|before|by|3al|3a|abel|2abel)\\s+${HOUR_H}${E}`,
  'giu',
)
const RELATIVE_RE = new RegExp(`${B}${RELATIVE}${E}`, 'giu')
/** "at 3" (a bare hour): only after "at", and only at the end of the phrase. */
const BARE_AT_RE = new RegExp(`${B}(?:at|à|3al)\\s+\\d{1,2}\\s*$`, 'iu')

const LEAD_INS = new RegExp(
  `^\\s*(?:${[
    'remind me to',
    'reminder to',
    'reminder:',
    "don'?t forget to",
    'do not forget to',
    'remember to',
    'i need to',
    'need to',
    'i have to',
    'have to',
    'i must',
    'i should',
    'i want to',
    'todo:?',
    'to do:?',
    'il faut que je',
    'il faut',
    'je dois',
    "n'oublie pas de",
    'rappelle[- ]moi de',
    'lazem',
    'lezem',
    'lezim',
  ].join('|')})\\s+`,
  'iu',
)

const DANGLING = new RegExp(`(?:\\s*[,;:–-])+\\s*$`, 'iu')

/** The phrase without any trailing punctuation (". ! ? , ; : …" and closing quotes). */
export function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s.,;:!?…。،؟"”-]+$/u, '').trim()
}

/** Upper-case the first letter of a phrase that starts in lowercase Latin ("call mom" → "Call mom"). */
function capitalise(s: string): string {
  return /^[a-zàâçéèêëîïôûùüÿñæœ]/.test(s) && !/^[a-z]+[A-Z]/.test(s)
    ? s.charAt(0).toUpperCase() + s.slice(1)
    : s
}

/**
 * Remove every date/time phrase in `text` that the date reader understands. Phrases it can't
 * read stay (they carry information no field holds).
 */
export function stripWhenPhrases(
  text: string,
  ctx: CaptureContext,
  direction: WhenDirection,
): string {
  // Nothing in it reads as a date or time: nothing to move into a field.
  if (resolveWhen(text, ctx, direction) === null) return text.trim()
  const readable = (phrase: string) => resolveWhen(phrase, ctx, direction) !== null
  let out = text
  for (const re of [DAY_RE, RELATIVE_RE, TIME_H_RE, TIME_RE]) {
    out = out.replace(re, (m) => (readable(m) ? ' ' : m))
  }
  const bare = BARE_AT_RE.exec(out)
  if (bare && readable(bare[0])) out = out.slice(0, bare.index)
  return out
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A short title in the user's own words: `title` (the model's) without its date/time phrases,
 * reminder lead-in and trailing punctuation. Falls back to `fallback` (the thought's words),
 * cleaned the same way, then to the input as written, so a title is never empty.
 */
export function cleanTitle(
  title: string,
  ctx: CaptureContext,
  opts: { direction?: WhenDirection; fallback?: string } = {},
): string {
  const direction = opts.direction ?? 'future'
  const clean = (s: string) => {
    let out = stripWhenPhrases(s, ctx, direction)
    out = out.replace(LEAD_INS, '')
    out = stripTrailingPunctuation(out)
    for (let i = 0; i < 3; i++) out = stripTrailingPunctuation(out.replace(DANGLING, ''))
    out = out.replace(/^[\s,;:–-]+/, '')
    return out === '' ? null : capitalise(out)
  }
  return (
    clean(title) ??
    (opts.fallback ? clean(opts.fallback) : null) ??
    (stripTrailingPunctuation(title) || title.trim())
  )
}
