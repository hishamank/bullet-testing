import type { ThoughtKind } from '@bullet/core'

/** The CSS class that colours a kind pill (`--kind-*` variables from `theme-css.ts`). */
export const kindClass = (kind: ThoughtKind) => `kind-${kind.replace('_', '-')}`
