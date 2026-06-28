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
 * (note, event, habit, goal, …) will be added later — but v1 ships exactly these four.
 */
export const targetKindSchema = z.enum(['task', 'tracker', 'tracker_entry', 'activity'])
export type TargetKind = z.infer<typeof targetKindSchema>
