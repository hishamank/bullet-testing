/**
 * Which language a short quote is in, for templated reflective questions ("Still on your mind?"
 * worded like the thought it quotes). A small deterministic guess over the user's languages:
 * Arabic script, Arabizi (Lebanese Arabic in Latin letters, digits for sounds: "3a", "7abibi"),
 * French and English. Unsure means English: a non-English language needs at least two signals,
 * so one ambiguous word ("ma", "law") or a time ("3pm") never flips it.
 */

import type { ReflectiveLanguage } from '@bullet/core'

const FRENCH = new Set([
  'le',
  'la',
  'les',
  'un',
  'une',
  'des',
  'du',
  'de',
  'est',
  'et',
  'je',
  'tu',
  'il',
  'elle',
  'nous',
  'vous',
  'pas',
  'pour',
  'avec',
  'que',
  'qui',
  'si',
  'mon',
  'ma',
  'mes',
  'sur',
  'dans',
  'ce',
  'cette',
  'au',
  'aux',
  'ou',
  'mais',
  'demain',
  'faut',
  'quand',
  'appeler',
  'vérifier',
  'verifier',
  'acheter',
  'pourquoi',
  'comment',
  'chez',
])

/** Arabizi words that are not also common English words or names. */
const ARABIZI = new Set([
  '3a',
  '3al',
  '3am',
  '2al',
  'ma3',
  'ana',
  'enta',
  'enti',
  'shu',
  'sho',
  'chou',
  'kif',
  'keef',
  'baddi',
  'badde',
  'bade',
  'bidde',
  'eza',
  'iza',
  'lezem',
  'lazem',
  'lezim',
  'ktir',
  'kteer',
  'hayda',
  'hayde',
  'hek',
  'kenet',
  'bukra',
  'bokra',
  'mbere7',
  'lyom',
  'elyom',
  'khayfe',
  'khayef',
  'shuf',
  'chouf',
  'yalla',
  'habibi',
  'mish',
  'msh',
  'wala',
  'chi',
  'ba3d',
  'ba3ed',
  'lessa',
  'ya3ne',
  'ya3ni',
])

const ENGLISH = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'if',
  'my',
  'is',
  'for',
  'with',
  'i',
  'it',
  'on',
  'in',
  'what',
  'why',
  'how',
  'should',
  'check',
  'call',
  'about',
  'whether',
  'before',
  'this',
  'that',
  'by',
])

/**
 * A Latin word written with digits for Arabic sounds ("7abibi", "su2al", "ba3do", "sale7"): a
 * vowel, one of 2 3 5 7 8 9, no run of digits, three characters or more. Short forms ("3a",
 * "ma3") are in the word list; "b2b", "mp3", "v2" have no vowel and never count.
 */
const ARABIZI_DIGITS = /^(?=.*[aeiouy])(?=.*[235789])(?!.*\d\d)[a-z235789']{3,}$/

/** Times, ordinals and units ("3pm", "9am", "5k", "2nd", "5th"): never Arabizi. */
const UNIT = /^\d+(?:am|pm|h|k|km|kg|g|m|x|st|nd|rd|th)$/

const ACCENTED = /[àâçéèêëîïôûùüÿœæ]/

/** A non-English language needs at least this score: one weak hit never flips it. */
const MIN_SCORE = 2

/** Guess the language of `text` (a thought or a quote). Unsure means English. */
export function quoteLanguage(text: string): ReflectiveLanguage {
  const t = text.normalize('NFC').toLowerCase()
  const arabic = (t.match(/[؀-ۿ]/g) ?? []).length
  const latin = (t.match(/[a-zà-ÿœæ]/g) ?? []).length
  if (arabic > 0 && arabic >= latin) return 'ar'

  const words = t.split(/[^a-zà-ÿœæ0-9']+/).filter(Boolean)
  let fr = 0
  let az = 0
  let en = 0
  for (const raw of words) {
    // "j'ai", "l'école", "qu'il": French elisions count as French.
    const elided = /^(?:j|l|d|qu|n|s|c|m)'(.+)$/.exec(raw)
    if (elided) fr += 1
    const w = elided?.[1] ?? raw
    if (UNIT.test(w)) continue
    if (ARABIZI.has(w) || ARABIZI_DIGITS.test(w)) az += 1
    if (FRENCH.has(w)) fr += 1
    if (ACCENTED.test(w)) fr += 1
    if (ENGLISH.has(w)) en += 1
  }
  if (az >= MIN_SCORE && az > en && az >= fr) return 'arabizi'
  if (fr >= MIN_SCORE && fr > en) return 'fr'
  return 'en'
}
