import { z } from 'zod'

/**
 * Domain enums / closed unions, defined as Zod enums with the inferred TypeScript union
 * type derived from each schema (schemas are the single source of truth).
 */

/** Soft-delete lifecycle. We never hard-delete domain rows. */
export const recordStateSchema = z.enum(['active', 'deleted'])
export type RecordState = z.infer<typeof recordStateSchema>

/** Task lifecycle status. */
export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'migrated', 'cancelled'])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/** Task priority, P1 (highest) … P4 (lowest). */
export const taskPrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4'])
export type TaskPriority = z.infer<typeof taskPrioritySchema>

/** The kind of input a Tracker collects; drives the shape of its config and entry values. */
export const trackerInputTypeSchema = z.enum([
  'scale',
  'number',
  'single_select',
  'multi_select',
  'boolean',
  'text',
])
export type TrackerInputType = z.infer<typeof trackerInputTypeSchema>

/** Resolution status of a Suggestion. Suggestions never auto-expire. */
export const suggestionStatusSchema = z.enum(['pending', 'accepted', 'edited', 'rejected'])
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>

/** Behavior tier — what the UI does with a suggestion. Surfaced instead of a raw number. */
export const suggestionTierSchema = z.enum(['auto', 'suggest', 'ask'])
export type SuggestionTier = z.infer<typeof suggestionTierSchema>

/** Create-vs-append operation a suggestion proposes. */
export const suggestionOperationSchema = z.enum(['create', 'append', 'update'])
export type SuggestionOperation = z.infer<typeof suggestionOperationSchema>

/**
 * Which entity/record type a Suggestion proposes. Designed extensibly — more kinds
 * (note, habit, goal, …) will be added later. Slice 1 ships the five THINGS; slice 3 adds
 * `thought_resolve` ("Did this close it?"): an `update` of an open-loop thought, proposed when a
 * later capture answers it. Never `auto`.
 */
export const targetKindSchema = z.enum([
  'task',
  'event',
  'tracker',
  'tracker_entry',
  'activity',
  'thought_resolve',
])
export type TargetKind = z.infer<typeof targetKindSchema>

/** The target kinds that are things (entities extracted from a thought), not thought updates. */
export const THING_KINDS = ['task', 'event', 'tracker', 'tracker_entry', 'activity'] as const
export type ThingKind = (typeof THING_KINDS)[number]

/** Is this suggestion kind a thing (task, event, tracker, reading, activity)? */
export const isThingKind = (kind: TargetKind): kind is ThingKind =>
  (THING_KINDS as readonly TargetKind[]).includes(kind)

/** How a bullet was captured. Voice bullets carry the transcribed text. */
export const bulletSourceSchema = z.enum(['text', 'voice'])
export type BulletSource = z.infer<typeof bulletSourceSchema>
