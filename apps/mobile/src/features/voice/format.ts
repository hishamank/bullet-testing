/** Timer text for the recording screen, pure. */

/** "0:07", "3:12", "1:02:03". */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function unit(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** For VoiceOver: "3 minutes 12 seconds", "1 hour 2 minutes", "0 seconds". */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts = [
    h > 0 ? unit(h, 'hour') : null,
    m > 0 ? unit(m, 'minute') : null,
    s > 0 || total === 0 ? unit(s, 'second') : null,
  ]
  return parts.filter((p) => p !== null).join(' ')
}

/** Under the draft: what the draft is (design copy), or why there is none. */
export function draftHint(
  liveDraft: boolean,
  why: 'speech_denied' | 'no_on_device' | null,
): string {
  if (liveDraft) return 'Live draft. Your recording is kept and transcribed again at home.'
  if (why === 'speech_denied') {
    return 'No live draft: speech recognition is off. Your recording is kept and transcribed at home.'
  }
  return 'No live draft on this phone. Your recording is kept and transcribed at home.'
}

/** The line while paused by something other than the user's own Pause (design copy). */
export const PAUSED_NOTE = 'Recording paused. Everything so far is saved.'

/** A line while paused; null for a plain Pause. Always says the audio is safe. */
export function pauseNote(
  reason: 'user' | 'interrupted' | 'background' | 'limit' | 'error' | null,
): string | null {
  switch (reason) {
    case 'interrupted':
    case 'background':
    case 'error':
      return PAUSED_NOTE
    case 'limit':
      return 'This is as long as one voice note can be. Send to save it.'
    default:
      return null
  }
}
