/** Vitest-only: sql.js loaded from node_modules, with its WebAssembly handed over directly. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'

let loading: Promise<SqlJsStatic> | null = null

export function loadSqlForTests(): Promise<SqlJsStatic> {
  const require = createRequire(import.meta.url)
  // Under jsdom sql.js believes it runs in a page and would fetch the file; give it the bytes.
  const file = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
  const wasmBinary = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer
  loading ??= initSqlJs({ wasmBinary })
  return loading
}
