/** Ollama client barrel — the interface, the HTTP implementation, and the scripted fake. */

export { HttpOllamaClient, type HttpOllamaClientOptions } from './http'
export {
  type ChatHandler,
  type ChatScriptValue,
  createScriptedOllamaClient,
  type EmbedHandler,
  type EmbedScriptValue,
  type OllamaScript,
  type RecordedCall,
  type ScriptedOllamaClient,
} from './scripted'
export type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaClient,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaFormat,
  OllamaMessage,
  OllamaModelInfo,
  OllamaOptions,
} from './types'
