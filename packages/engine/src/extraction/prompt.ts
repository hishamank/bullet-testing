/**
 * Prompt construction for extraction. A clear SYSTEM prompt explaining the entity kinds and the
 * four orientations (CLAUDE.md §4.4), instructing the model to reference EXISTING
 * trackers/open-tasks by name (so the resolver can append/update rather than duplicate), to split
 * one bullet into multiple candidates, and to QUOTE date/time phrases rather than compute them;
 * plus a USER prompt embedding the capture time + zone, the bullet text and the inlined snapshot.
 *
 * The model never does calendar arithmetic: the resolver turns the quoted phrase into epoch ms
 * against the capture context (time/when.ts). The capture time is still shown so the model can
 * judge tense ("this morning" vs a plan) and so a phrase it must paraphrase stays anchored.
 */

import type { LlmMessage } from '../llm/types'
import type { CaptureContext } from '../time/when'
import { formatZoned, safeTimezone, zonedParts } from '../time/zoned'
import type { ExtractionSnapshot } from './snapshot'

/** The system prompt: stable instructions independent of the specific bullet. */
export const EXTRACTION_SYSTEM_PROMPT = `You extract structured productivity entities from a single journal bullet.

The entity KINDS:
- "tracker": a DEFINITION of something measured repeatedly (e.g. mood, weight, sleep). input_type is one of scale | number | single_select | multi_select | boolean | text.
- "tracker_entry": a single value LOGGED against an existing tracker definition.
- "task": an actionable thing the user intends to DO (call mom, buy milk, renew passport), including one with a deadline ("pay the rent by Friday", "send it before 6pm": a task due then, NOT an event).
- "event": something that HAPPENS to the user at a time (dentist appointment, meeting, dinner with Sam, flight). Use it for future plans that are fixed in time.
- "activity": a record of something the user DID (ran, smoked, meditated). It may link to a tracker or stay free.

Each candidate also has an ORIENTATION (its time sense):
- "happened": something already occurred or a state was observed -> becomes a RECORD (a tracker_entry if it logs a value under a known tracker, otherwise an activity), OR marks an existing open task done if it clearly completes one.
- "future_oneoff": a one-off intention -> a task, or an event if it is an appointment/happening at a time.
- "future_recurring": an intention to track/do something repeatedly -> a tracker DEFINITION.
- "durable_fact": a standing fact about the user (not an action, not a plan). v1 has no place for these; still emit it so it is counted.

Rules:
- Split the bullet into ONE OR MORE candidates: a single bullet may contain several things ("ran 5k and felt great, remember to call mom").
- When a candidate refers to an EXISTING tracker or open task in the provided state, set "referenceName" to that exact name/title so it can be appended/updated instead of duplicated.
- "fields" MUST be FLAT: each value is a PRIMITIVE (string/number/boolean), or an ARRAY of primitives for a multi-select value — NEVER nest objects inside it.
  CORRECT: { "title": "call mom" }            WRONG: { "title": { "name": "call mom" } }
  CORRECT: { "name": "running", "value": 5 }   WRONG: { "name": { "name": "running" }, "value": { "value": 5 } }
  Typical shapes: { "value": 5 } for a tracker entry, { "value": ["cough", "fatigue"] } for a multi-select entry, { "title": "call mom" } for a task, { "name": "running", "input_type": "number" } for a tracker, { "name": "ran 5k" } for an activity.
- Dates and times: copy the phrase EXACTLY as the user wrote it, in the user's language, into "when" (e.g. { "title": "dentist", "when": "Thursday 3pm" }, { "name": "ran 5k", "when": "yesterday morning" }). For an event's end use "end_when" (e.g. "until 5pm" -> "end_when": "5pm"); for a place use "location". NEVER compute dates, weekdays or timestamps yourself.
- The bullet may mix English, French and Lebanese Arabic (in Arabic script or Latin letters, "Arabizi"). Write task and event titles in the user's own words and language; NEVER translate them.
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

/** "Written on Thursday 2026-10-15 09:12 (time zone Europe/Paris)." */
export function renderCaptureContext(ctx: CaptureContext): string {
  const timezone = safeTimezone(ctx.timezone)
  return `Written on ${formatZoned(zonedParts(ctx.capturedAt, timezone))} (time zone ${timezone}).`
}

/**
 * Build the chat messages for extracting `bullet` (captured per `ctx`) against the current
 * `snapshot`. Returns `[system, user]`.
 */
export function buildExtractionPrompt(
  bullet: string,
  snapshot: ExtractionSnapshot,
  ctx: CaptureContext,
): LlmMessage[] {
  const user = `Current state:\n${renderSnapshot(snapshot)}\n\n${renderCaptureContext(ctx)}\nBullet:\n"""\n${bullet}\n"""\n\nExtract the candidates.`
  return [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}
