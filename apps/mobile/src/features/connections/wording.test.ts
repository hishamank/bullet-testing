/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { usesDeniedWord } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'

// The slice 3 models and copy live in @bullet/client; the screens that show them live here.
const CLIENT = '../../../../../packages/client/src/features/'

describe('wording', () => {
  test('no string in the slice 3 screens and components uses a denied word', () => {
    const files = [
      '../../components/connections/InboxCards.tsx',
      '../../components/connections/parts.tsx',
      '../../components/connections/RelatedList.tsx',
      '../../components/connections/ThemeSheets.tsx',
      '../../components/inbox/ThinkCard.tsx',
      '../../app/inbox/index.tsx',
      '../../app/theme/[id].tsx',
      '../../app/journal/loops.tsx',
      '../../app/capture/[id].tsx',
      '../../components/journal/CaptureCard.tsx',
      `${CLIENT}journal/loops.ts`,
      `${CLIENT}journal/stream.ts`,
      `${CLIENT}inbox/summary.ts`,
      `${CLIENT}inbox/model.ts`,
      './actions.ts',
      `${CLIENT}connections/model.ts`,
    ]
    for (const f of files) {
      const source = readFileSync(new URL(f, import.meta.url), 'utf8')
        // Comments are notes for developers, not words on screen.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      const strings = [
        ...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g),
        // JSX text between tags.
        ...source.matchAll(/>([^<>{}\n]+)</g),
      ].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
      for (const s of strings) expect(usesDeniedWord(s), `${f}: ${s}`).toBe(false)
    }
  })
})
