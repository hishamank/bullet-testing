import type { ThoughtKind } from '@bullet/core'
import { describe, expect, it } from 'vite-plus/test'
import { contrastRatio, dark, KIND_LABELS, kindStyle, light } from './tokens'

const KINDS = Object.keys(KIND_LABELS) as ThoughtKind[]

describe('night calm contrast (WCAG AA)', () => {
  for (const p of [dark, light]) {
    describe(p.scheme, () => {
      it('body text passes 4.5:1 on every surface', () => {
        for (const surface of [p.background, p.card, p.note]) {
          for (const fg of [p.text, p.textSecondary, p.textSoft, p.accentText]) {
            expect(contrastRatio(fg, surface), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })

      it('muted text and status colours pass 4.5:1 on the background', () => {
        for (const fg of [p.textMuted, p.warning, p.destructive]) {
          expect(contrastRatio(fg, p.background), fg).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('the accent button label passes 4.5:1', () => {
        expect(contrastRatio(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5)
      })

      it('the theme pill passes 4.5:1, and the "again" dot 3:1 on a card', () => {
        expect(contrastRatio(p.again, p.againSoft)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(p.again, p.card)).toBeGreaterThanOrEqual(3)
      })

      it('every kind label passes 4.5:1 on its pill', () => {
        for (const kind of KINDS) {
          const k = kindStyle(kind, p.scheme)
          expect(contrastRatio(k.text, k.background), kind).toBeGreaterThanOrEqual(4.5)
        }
      })
    })
  }
})
