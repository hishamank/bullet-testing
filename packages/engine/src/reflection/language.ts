/**
 * Which language a short quote is in, for templated reflective questions ("Still on your mind?"
 * worded like the thought it quotes). A small deterministic guess over the user's languages:
 * Arabic script, Arabizi (Lebanese Arabic in Latin letters, digits for sounds: "3a", "7ali"),
 * French and English. Unsure means English.
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

const ARABIZI = new Set([
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
  'law',
  'lezem',
  'lazem',
  'lezim',
  'ktir',
  'kteer',
  'hayda',
  'hayde',
  'hek',
  'hal',
  'kenet',
  'kent',
  'bukra',
  'bokra',
  'mbere7',
  'lyom',
  'elyom',
  'khayfe',
  'khayef',
  'shuf',
  'chouf',
  'ma3',
  'yalla',
  'habibi',
  'ma',
  'mish',
  'msh',
  'mesh',
  'wala',
  'aw',
  'shi',
  'chi',
  'ba3d',
  'ba3ed',
  'lessa',
  'bass',
  'ya3ne',
  'ya3ni',
  'ido',
  'ida',
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
])

/** A Latin word written with digits for Arabic sounds ("3a", "7ali", "su2al", "ba3d"). */
const ARABIZI_DIGITS = /^(?=.*[a-z])(?=.*[235789])[a-z235789']+$/

const ACCENTED = /[àâçéèêëîïôûùüÿœæ]/

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
    if (ARABIZI_DIGITS.test(w)) az += 2
    else if (ARABIZI.has(w)) az += 1
    if (FRENCH.has(w)) fr += 1
    if (ACCENTED.test(w)) fr += 1
    if (ENGLISH.has(w)) en += 1
  }
  const best = Math.max(fr, az, en)
  if (best === 0 || en === best) return 'en'
  return az >= fr ? 'arabizi' : 'fr'
}
