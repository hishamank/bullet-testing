/**
 * The provider-neutral speech-to-text interface. The server injects a concrete implementation
 * (whisper.cpp on the home machine — a later step); tests inject {@link createScriptedTranscriber}.
 * Like the LLM, CI never needs a live model.
 *
 * Multilingual by design: the user mixes English, Lebanese Arabic and French in one note, so
 * implementations must auto-detect (never force one language). `languageHints` only biases.
 */

export interface TranscriptionRequest {
  audio: Uint8Array
  mimeType: string
  /** Optional hints, e.g. ['en', 'ar', 'fr']. Never a single forced language. */
  languageHints?: string[]
}

export interface TranscriptionResult {
  text: string
  /** Engine name, e.g. 'whisper.cpp'. */
  engine: string
  /** Model name, e.g. 'large-v3-turbo', when known. */
  model: string | null
  /** Languages detected (BCP-47 / ISO 639), possibly several; empty when unknown. */
  languages: string[]
}

export interface Transcriber {
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>
}
