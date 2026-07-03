/**
 * Prompt construction for extraction. A clear SYSTEM prompt explaining the four entity kinds
 * and the four orientations (CLAUDE.md §4.4), instructing the model to reference EXISTING
 * trackers/open-tasks by name (so the resolver can append/update rather than duplicate), and to
 * split one bullet into multiple candidates; plus a USER prompt embedding the bullet text and
 * the inlined snapshot.
 */

import type { OllamaMessage } from '../ollama/types'
import type { ExtractionSnapshot } from './snapshot'

/** The system prompt: stable instructions independent of the specific bullet. */
export const EXTRACTION_SYSTEM_PROMPT = `You extract structured productivity entities from a single journal bullet.

The four entity KINDS:
- "tracker": a DEFINITION of something measured repeatedly (e.g. mood, weight, sleep). input_type is one of scale | number | single_select | multi_select | boolean | text.
- "tracker_entry": a single value LOGGED against an existing tracker definition.
- "task": an actionable thing the user intends to do.
- "activity": a record of something the user DID (ran, smoked, meditated). It may link to a tracker or stay free.

Each candidate also has an ORIENTATION (its time sense):
- "happened": something already occurred or a state was observed -> becomes a RECORD (a tracker_entry if it logs a value under a known tracker, otherwise an activity), OR marks an existing open task done if it clearly completes one.
- "future_oneoff": a one-off intention -> a task.
- "future_recurring": an intention to track/do something repeatedly -> a tracker DEFINITION.
- "durable_fact": a standing fact about the user (not an action, not a plan). v1 has no place for these; still emit it so it is counted.

State vs action — a state/feeling you REPORT is a "happened" RECORD, NOT a task; only a thing you intend to DO is a task:
- "feeling overwhelmed" -> tracker_entry if a matching tracker exists, else an activity; orientation "happened". NOT a task.
- "energy is low today" / "pretty stressed" -> a state reading; orientation "happened". NOT a task.
- "need to call the plumber" / "finish the report" -> task; orientation "future_oneoff".

Rules:
- Split the bullet into ONE OR MORE candidates: a single bullet may contain several things ("ran 5k and felt great, remember to call mom").
- When a candidate refers to an EXISTING tracker or open task in the provided state, set "referenceName" to that exact name/title so it can be appended/updated instead of duplicated.
- "fields" MUST be FLAT: each value is a PRIMITIVE (string/number/boolean), or an ARRAY of primitives for a multi-select value — NEVER nest objects inside it.
  CORRECT: { "title": "call mom" }            WRONG: { "title": { "name": "call mom" } }
  CORRECT: { "name": "running", "value": 5 }   WRONG: { "name": { "name": "running" }, "value": { "value": 5 } }
  Typical shapes: { "value": 5 } for a tracker entry, { "value": ["cough", "fatigue"] } for a multi-select entry, { "title": "call mom" } for a task, { "name": "running", "input_type": "number" } for a tracker, { "name": "ran 5k" } for an activity.
- "text" is the slice of the bullet the candidate came from.
- "confidence" is your certainty in this candidate, 0..1.
- Output ONLY the JSON object matching the provided schema. No Markdown code fences, no commentary, no text before or after.`

/** Render the inlined snapshot as compact, model-readable text. */
function renderSnapshot(snapshot: ExtractionSnapshot): string {
  const trackers =
    snapshot.trackers.length === 0
      ? '(none)'
      : snapshot.trackers.map((t) => `- "${t.name}" (input_type: ${t.input_type})`).join('\n')
  const tasks =
    snapshot.openTasks.length === 0
      ? '(none)'
      : snapshot.openTasks.map((t) => `- "${t.title}" (status: ${t.status})`).join('\n')
  return `Existing trackers (definitions you can log against, by name):\n${trackers}\n\nOpen tasks (you can mark these done, by title):\n${tasks}`
}

/**
 * Build the chat messages for extracting `bullet` against the current `snapshot`.
 * Returns `[system, user]`.
 */
export function buildExtractionPrompt(
  bullet: string,
  snapshot: ExtractionSnapshot,
): OllamaMessage[] {
  const user = `Current state:\n${renderSnapshot(snapshot)}\n\nBullet:\n"""\n${bullet}\n"""\n\nExtract the candidates.`
  return [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}
