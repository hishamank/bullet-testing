/**
 * The capture page's state machine (pure). Idle is mic-first with the keyboard down; focusing the
 * text (or having a draft) is typing; after Send the page clears and shows "Saved" for a moment.
 */

export const SAVED_MS = 2_000

export interface ComposerState {
  text: string
  focused: boolean
  /** When the last capture was saved, while "Saved" still shows. */
  savedAt: number | null
}

export type ComposerMode = 'idle' | 'typing' | 'saved'

export type ComposerEvent =
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'change'; text: string }
  | { type: 'sent'; at: number }
  | { type: 'saved_elapsed'; at: number }

export const initialComposer: ComposerState = { text: '', focused: false, savedAt: null }

export function composerReducer(s: ComposerState, e: ComposerEvent): ComposerState {
  switch (e.type) {
    case 'focus':
      return { ...s, focused: true, savedAt: null }
    case 'blur':
      return { ...s, focused: false }
    case 'change':
      return { ...s, text: e.text, savedAt: e.text === '' ? s.savedAt : null }
    case 'sent':
      return { text: '', focused: false, savedAt: e.at }
    case 'saved_elapsed':
      // Only the timer of the latest save clears it.
      return s.savedAt !== null && e.at - s.savedAt >= SAVED_MS ? { ...s, savedAt: null } : s
  }
}

export function composerMode(s: ComposerState): ComposerMode {
  if (s.focused || s.text !== '') return 'typing'
  return s.savedAt !== null ? 'saved' : 'idle'
}

export function canSend(text: string): boolean {
  return text.trim() !== ''
}
