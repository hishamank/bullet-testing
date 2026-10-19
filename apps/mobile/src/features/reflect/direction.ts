/** Text direction for reflective questions (pure; no imports, so UI building blocks can use it). */

/**
 * The text's direction from its first letter (quotes, digits and punctuation skipped): an Arabic
 * question ("بعدو عبالك؟ «…»") lays out right to left, with the quote on its left.
 */
export function textDirection(text: string): 'rtl' | 'ltr' {
  const m = /\p{L}/u.exec(text)
  return m && /[֐-ࣿיִ-﷿ﹰ-﻿]/u.test(m[0]) ? 'rtl' : 'ltr'
}
