/**
 * Browser edge: load sql.js with its WebAssembly file bundled by Vite (served from this app's own
 * `assets/`, never from a CDN). Kept apart from `open.ts` so tests can load sql.js from node.
 */

import initSqlJs, { type SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'

let loading: Promise<SqlJsStatic> | null = null

export function loadSqlJs(): Promise<SqlJsStatic> {
  loading ??= initSqlJs({ locateFile: () => wasmUrl })
  return loading
}
