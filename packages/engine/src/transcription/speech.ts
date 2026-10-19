/** What counts as speech in a transcript. */

/**
 * Whether a transcript holds any words: not empty, not only punctuation, not only non-speech
 * markers. whisper.cpp answers a tone or room noise with "." or "[BLANK_AUDIO]". A transcript
 * without speech must never become a capture's text: the transcription stage treats it as
 * `TRANSCRIPTION_FAILED`.
 */
export function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' '))
}
