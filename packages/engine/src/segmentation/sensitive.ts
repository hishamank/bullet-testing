/**
 * A deterministic backstop for the segmentation model's `sensitive` flag: plain phrases of
 * self-harm, suicidal thoughts or acute crisis, in English, French, Arabizi and Arabic. The flag
 * only keeps reflective questions away (it is never shown), so this errs on the side of flagging.
 * The model's own judgement still covers everything said less plainly.
 */

const PATTERNS: RegExp[] = [
  // English
  /\bkill(?:ing)? myself\b/,
  /\bend(?:ing)? (?:my life|it all)\b/,
  /\bsuicid/,
  /\bself[- ]?harm/,
  /\b(?:hurt|hurting|cut|cutting|harm|harming) myself\b/,
  /\bwant(?:ed)? to die\b/,
  /\bwish i (?:was|were) dead\b/,
  /\b(?:don'?t|do not) want to (?:live|be alive|exist|wake up)\b/,
  /\bno reason to (?:live|go on)\b/,
  /\bbetter off without me\b/,
  /\bcan'?t go on\b/,
  /\boverdos/,
  // French
  /\bme (?:suicider|tuer)\b/,
  /\bmettre fin à (?:mes jours|ma vie)/,
  /\ben finir avec (?:la vie|tout)\b/,
  /\b(?:envie de|veux) mourir\b/,
  /\bme faire du mal\b/,
  /\bplus envie de vivre\b/,
  // Arabizi (Lebanese)
  /\bbad+[ei]?\s*(?:2?mout|moot|mut)\b/,
  /\b(?:e|2e|i)?2tol (?:7ale|7ali|halle)\b/,
  /\bnt[ae]7[ae]r|\bente7er|\benta7er/,
  // Arabic
  /انتحر|انتحار|بدي موت|اقتل حالي|أقتل نفسي/,
]

/** True when `text` plainly speaks of self-harm, suicidal thoughts or acute crisis. */
export function looksSensitive(text: string): boolean {
  const t = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
  return PATTERNS.some((re) => re.test(t))
}
