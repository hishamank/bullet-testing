/**
 * Tracker names (decision 4): a short noun for the measured thing — 1–2 words, Title Case, in the
 * user's language ("Mood", "Sleep", "Sommeil") — never the reading, its unit or its value.
 *
 * The model's own name for the tracker (`{ tracker: "sleep" }`) is used when it gives one, cleaned
 * the same way; otherwise the name is derived from the reading's words deterministically: numbers,
 * units, date words and filler are stripped, and common verbs map to their noun (slept → Sleep,
 * ran → Run, j'ai dormi → Sommeil).
 */

/** Verbs (and verb-ish words) whose noun names the tracker, when nothing else is left. */
const VERB_NOUNS: [RegExp, string][] = [
  [/^(slept|sleeping|sleeps)$/, 'Sleep'],
  [/^(ran|running|runs|jogged|jogging)$/, 'Run'],
  [/^(walked|walking|walks)$/, 'Walk'],
  [/^(meditated|meditate|meditating)$/, 'Meditation'],
  [/^(weighed|weigh|weighing)$/, 'Weight'],
  [/^(read)$/, 'Reading'],
  [/^(studied|studying)$/, 'Study'],
  [/^(swam|swimming)$/, 'Swim'],
  [/^(cycled|biked|biking)$/, 'Cycling'],
  [/^(smoked|smoke)$/, 'Smoking'],
  [/^(drank|drink|drinking)$/, 'Drinks'],
  [/^(exercised|worked)$/, 'Workout'],
  [/^(felt|feel|feeling)$/, 'Mood'],
  // French
  [/^(dormi|dors|dormir)$/, 'Sommeil'],
  [/^(couru|courir)$/, 'Course'],
  [/^(marché|marcher)$/, 'Marche'],
  [/^(médité|méditer)$/, 'Méditation'],
  [/^(pesé|peser)$/, 'Poids'],
  [/^(lu|lire)$/, 'Lecture'],
  [/^(fumé|fumer)$/, 'Cigarettes'],
  [/^(bu|boire)$/, 'Boissons'],
  // Arabizi
  [/^(nemet|nimet|nmet|nimt|nemt)$/, 'Nom'],
  [/^(rkadet|rkodt|rakadt)$/, 'Rkad'],
]

/** Units of a reading: never part of a tracker's name. */
const UNITS = new Set(
  [
    'h',
    'hr',
    'hrs',
    'hour',
    'hours',
    'min',
    'mins',
    'minute',
    'minutes',
    'sec',
    'secs',
    'second',
    'seconds',
    'km',
    'k',
    'kms',
    'mi',
    'mile',
    'miles',
    'm',
    'meters',
    'metres',
    'kg',
    'kgs',
    'kilo',
    'kilos',
    'lb',
    'lbs',
    'pound',
    'pounds',
    'g',
    'l',
    'ml',
    'liter',
    'liters',
    'litre',
    'litres',
    'glass',
    'glasses',
    'cup',
    'cups',
    'bottle',
    'bottles',
    'steps',
    'step',
    'times',
    'time',
    'pages',
    'page',
    'reps',
    'sets',
    'heure',
    'heures',
    'verre',
    'verres',
    'tasse',
    'tasses',
    'pas',
    'fois',
    'sa3a',
    'sa3at',
    'se3a',
    'se3at',
    'saa',
    'de2i2a',
    'd2i2a',
    'da2aye2',
    'kubbeye',
    'kebbeye',
    'ساعة',
    'ساعات',
    'دقيقة',
    'دقائق',
  ].map((w) => w.toLowerCase()),
)

/** Words that never name a tracker: pronouns, articles, scale words, dates, generic verbs. */
const FILLER = new Set(
  [
    'i',
    "i'm",
    'im',
    'my',
    'me',
    'a',
    'an',
    'the',
    'of',
    'for',
    'about',
    'around',
    'roughly',
    'approximately',
    'like',
    'just',
    'only',
    'was',
    'is',
    'were',
    'am',
    'been',
    'be',
    'got',
    'get',
    'had',
    'have',
    'has',
    'did',
    'do',
    'went',
    'go',
    'out',
    'over',
    'today',
    'tonight',
    'yesterday',
    'last',
    'night',
    'this',
    'morning',
    'afternoon',
    'evening',
    'so',
    'far',
    'total',
    'level',
    'score',
    'rating',
    'tracker',
    'track',
    'tracking',
    'log',
    'reading',
    'value',
    'today’s',
    "today's",
    'pretty',
    'very',
    'really',
    'quite',
    'good',
    'bad',
    'ok',
    'okay',
    'great',
    'well',
    'poorly',
    'only',
    // French
    "j'ai",
    'jai',
    'je',
    'suis',
    'ai',
    'mon',
    'ma',
    'mes',
    'le',
    'la',
    'les',
    "l'",
    'de',
    'du',
    'des',
    "d'",
    'un',
    'une',
    'sur',
    'ce',
    'cette',
    'matin',
    'soir',
    'nuit',
    "aujourd'hui",
    'hier',
    'environ',
    'à',
    'peu',
    'près',
    'bien',
    'mal',
    'très',
    // Arabizi / Arabic
    'ana',
    'l',
    'el',
    'il',
    'w',
    'wa',
    'kel',
    'shi',
    'bas',
    'elyom',
    'lyom',
    'mbere7',
    'embare7',
    'إمبارح',
    'اليوم',
    'انا',
  ].map((w) => w.toLowerCase()),
)

/** A clause after these is detail, not the measured thing ("water with lemon", "run and stretch"). */
const CLAUSE_BREAK = new Set([
  'with',
  'and',
  'in',
  'at',
  'on',
  'before',
  'after',
  'during',
  'avec',
  'et',
  'pendant',
  'ma3',
  'wa2t',
])

/** "6", "6h", "7h30", "3/5", "5k", "20min", "72.5kg", "1,5": a number-ish token. */
const NUMBERISH = /^[~≈]?\d+(?:[.,:h]\d+)?(?:\/\d+)?[a-z%]*$/i

function titleCase(words: string[]): string {
  return words
    .map((w) => (w === '' ? w : w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase()))
    .join(' ')
}

/**
 * The tracker noun in `text`, or null when nothing nameable is left. Pure and deterministic:
 * strips numbers, units, scale phrases ("out of 5", "sur 5"), dates and filler, cuts at the first
 * clause break, keeps up to two words, and maps a lone verb to its noun.
 */
export function trackerNounFrom(text: string): string | null {
  const s = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    // Scale phrases and ratios: "3 out of 5", "2 sur 5", "3/5", "8 from 10".
    .replace(/\d+(?:[.,]\d+)?\s*(?:out of|sur|from|\/|over)\s*\d+/g, ' ')
    // "j'ai", "l'humeur", "d'eau": the elided article goes, the noun stays.
    .replace(/\b([ld])'(?=\p{L})/gu, '')
    .replace(/[^\p{L}\p{N}'./,:%~]+/gu, ' ')
    .trim()
  if (s === '') return null
  const words: string[] = []
  const verbs: string[] = []
  for (const raw of s.split(/\s+/)) {
    const w = raw.replace(/^[.',:]+|[.',:]+$/g, '')
    if (w === '') continue
    if (CLAUSE_BREAK.has(w) && (words.length > 0 || verbs.length > 0)) break
    if (NUMBERISH.test(w) || UNITS.has(w) || FILLER.has(w)) continue
    if (VERB_NOUNS.some(([re]) => re.test(w))) {
      verbs.push(w)
      continue
    }
    if (/^\p{N}+$/u.test(w)) continue
    words.push(w)
  }
  if (words.length > 0) return titleCase(words.slice(0, 2))
  for (const v of verbs) {
    const hit = VERB_NOUNS.find(([re]) => re.test(v))
    if (hit) return hit[1]
  }
  return null
}

/**
 * The name for a reading's tracker: the first of the model's own tracker name, the candidate's
 * name and the reading's text that yields a clean noun; `fallback` (e.g. "Tracker") otherwise.
 */
export function trackerName(sources: (string | null | undefined)[], fallback = 'Tracker'): string {
  for (const src of sources) {
    if (typeof src !== 'string' || src.trim() === '') continue
    const name = trackerNounFrom(src)
    if (name) return name
  }
  return fallback
}
