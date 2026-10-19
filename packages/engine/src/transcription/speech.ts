/** What counts as speech in a transcript, and when a transcript (or the phone's draft) is usable. */

/**
 * Whether a transcript holds any words: not empty, not only punctuation, not only non-speech
 * markers. whisper.cpp answers a tone or room noise with "." or "[BLANK_AUDIO]". A transcript
 * without speech must never become a capture's text: the transcription stage treats it as
 * `TRANSCRIPTION_NO_SPEECH`.
 */
export function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' '))
}

/** Lowercase, no punctuation or markers, single spaces: how phrases are compared. */
function bare(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What Whisper is known to "hear" in silence or noise (training-data captions), in English,
 * French and Arabic, compared after {@link bare}. Only a transcript made ENTIRELY of these counts
 * (see {@link isSilenceHallucination}): a real sentence that contains "thank you" never does.
 */
const HALLUCINATIONS = new Set(
  [
    'you',
    'thank you',
    'thank you very much',
    'thank you so much',
    'thanks',
    'thank you for watching',
    'thanks for watching',
    'thank you for listening',
    'thanks for listening',
    'please subscribe',
    'like and subscribe',
    'bye',
    'bye bye',
    'subtitles by the amara org community',
    'merci',
    'merci beaucoup',
    "merci d'avoir regardé",
    'merci de votre attention',
    'sous titres réalisés par la communauté d amara org',
    "sous titres réalisés par la communauté d'amara org",
    'شكرا',
    'شكرا لكم',
    'شكرا جزيلا',
    'شكرا للمشاهدة',
    'اشتركوا في القناة',
    'ترجمة نانسي قنقر',
  ].map(bare),
)

/**
 * Is this transcript only Whisper's silence hallucination ("Thank you.", "Thanks for watching!",
 * "you", "Merci.", "شكرا", or one of them repeated)? Conservative: every sentence must be one of
 * the known phrases, and a transcript of more than a few sentences is never one.
 */
export function isSilenceHallucination(text: string): boolean {
  if (!hasSpeech(text)) return false
  const sentences = text
    .split(/[.!?؟。\n]+/u)
    .map(bare)
    .filter((s) => s !== '')
  if (sentences.length === 0 || sentences.length > 4) return false
  return sentences.every((s) => HALLUCINATIONS.has(s))
}

/** Hesitations that carry no content (English, French, Lebanese Arabic). */
const FILLERS = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  'erm',
  'hmm',
  'mm',
  'like',
  'so',
  'euh',
  'heu',
  'ben',
  'bah',
  'yaane',
  'ya3ne',
  'ya3ni',
  'yaani',
  'ahh',
  'ah',
  'eh',
])

/** Drop a phrase repeated back to back ("thank you thank you thank you" → "thank you"). */
function collapseRepeats(words: string[]): string[] {
  const out = [...words]
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + 2 * n <= out.length;) {
      const a = out.slice(i, i + n).join(' ')
      const b = out.slice(i + n, i + 2 * n).join(' ')
      if (a === b) out.splice(i + n, n)
      else i++
    }
  }
  return out
}

/** Content words in a text (any script): no punctuation, markers, fillers or back-to-back repeats. */
function contentWords(text: string): string[] {
  const b = bare(text)
  if (b === '') return []
  return collapseRepeats(b.split(' ').filter((w) => !FILLERS.has(w)))
}

/** Words in a text (any script), ignoring punctuation and non-speech markers. */
export function wordCount(text: string): number {
  const b = bare(text)
  return b === '' ? 0 : b.split(' ').length
}

/**
 * Is the phone's live draft good enough to stand in for a missing server transcript? It needs
 * real content: more than three words, some speech, and not just a filler/hallucination phrase.
 */
export function isUsableDraft(draft: string | null | undefined): boolean {
  if (!draft) return false
  const words = contentWords(draft)
  return (
    hasSpeech(draft) &&
    words.length > 3 &&
    !isSilenceHallucination(draft) &&
    !isSilenceHallucination(words.join(' '))
  )
}

/** Recordings up to this long are "short": a hallucination there is almost surely silence. */
export const SHORT_RECORDING_MS = 10_000

/**
 * Should a server transcript be read as "no speech"? Yes when it has no words, or when it is only
 * a silence hallucination and either the recording is short, the phone's draft has no words, or
 * the draft does not say the same thing (the phone heard something else entirely). A long
 * recording whose draft agrees ("thank you" both times) keeps its transcript.
 */
export function transcriptIsNoSpeech(
  transcript: string,
  opts: { durationMs: number | null; draft: string | null },
): boolean {
  if (!hasSpeech(transcript)) return true
  if (!isSilenceHallucination(transcript)) return false
  const short = opts.durationMs === null || opts.durationMs <= SHORT_RECORDING_MS
  const draft = opts.draft ?? ''
  if (short || !hasSpeech(draft)) return true
  return bare(draft) !== bare(transcript)
}
