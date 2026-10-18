/**
 * How the recording screen was left, for the capture page underneath (pure; no device imports,
 * so the Composer can listen without loading the recorder).
 */

import { createStore } from '../store'

/**
 * `saved` shows the page's quiet "Saved"; `type` starts typing ("Type instead"). `context` is the
 * question or loop being answered (null on the plain capture page), so only the page that opened
 * the recorder reacts.
 */
export interface VoiceReturn {
  kind: 'saved' | 'type'
  at: number
  context: string | null
}

export const voiceReturnStore = createStore<VoiceReturn | null>(null)

export function returnToCapture(kind: VoiceReturn['kind'], context: string | null): void {
  voiceReturnStore.set({ kind, at: Date.now(), context })
}
