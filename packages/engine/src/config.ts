/**
 * Engine configuration: the model name plus the tier thresholds and gates. A plain value — the
 * engine never reads `process.env`; the server builds this at startup, tests use literals.
 *
 *  - `model`            — the model name sent with each chat request.
 *  - `autoThreshold`    — confidence at/above which an eligible RECORD/UPDATE suggestion is
 *                         tier `auto` (and gets auto-applied). Definitions are never `auto`.
 *  - `suggestThreshold` — confidence at/above which a suggestion is at least `suggest`
 *                         (below it is `ask`).
 *  - `autoCreateTasks`  — when false (default), task CREATEs are capped at `suggest`.
 *  - `autoCreateEvents` — when false (default), event CREATEs are capped at `suggest`.
 *  - `autoApplyValueRecords` — when false (default), value-bearing records (a `tracker_entry`,
 *                         or an `activity` with a `quantity`) are capped at `suggest`, so a wrong
 *                         value or mislinked reading is never written silently.
 */
export interface EngineConfig {
  model: string
  autoThreshold: number
  suggestThreshold: number
  autoCreateTasks: boolean
  autoCreateEvents: boolean
  autoApplyValueRecords: boolean
}

export const ENGINE_CONFIG_DEFAULTS: EngineConfig = {
  model: 'default',
  autoThreshold: 0.85,
  suggestThreshold: 0.5,
  autoCreateTasks: false,
  autoCreateEvents: false,
  autoApplyValueRecords: false,
}
