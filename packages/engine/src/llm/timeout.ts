/**
 * A deadline for any {@link LlmClient}: the wrapped client rejects with
 * `EngineError('LLM_TIMEOUT')` when the inner call has not settled within `timeoutMs`, so a hung
 * model can never wedge the processing queue. The inner call is abandoned, not cancelled (the
 * interface has no abort signal); adapters with their own timeout should use a longer one.
 */

import { EngineError } from '../errors'
import type { LlmClient } from './types'

export function withLlmTimeout(llm: LlmClient, timeoutMs: number): LlmClient {
  return {
    chat(req) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new EngineError('LLM_TIMEOUT', `LLM did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        )
        llm.chat(req).then(
          (res) => {
            clearTimeout(timer)
            resolve(res)
          },
          (err: unknown) => {
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      })
    },
  }
}
