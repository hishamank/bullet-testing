import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { trackerInputTypeSchema } from '../enums'
import { nonEmptyString } from '../primitives'

/**
 * Tracker config modeling.
 *
 * A Tracker carries a top-level `input_type` and a `config` whose shape MUST match it. We
 * model `config` as a discriminated union on `input_type` (the discriminant key is repeated
 * inside config so Zod can pick the right member), then a top-level refinement asserts the
 * tracker's `input_type` equals `config.input_type`. Refinements that matter actually fire:
 *
 *   - scale            → { min, max, labels? } with min < max
 *   - number           → { unit?, min?, max? } (min <= max when both present)
 *   - single_select    → { options: non-empty string[] } (>= 1, each non-empty)
 *   - multi_select     → { options: non-empty string[] } (>= 1, each non-empty)
 *   - boolean          → {}
 *   - text             → {}
 */

export const scaleConfigSchema = z
  .object({
    input_type: z.literal('scale'),
    min: z.number().int(),
    max: z.number().int(),
    labels: z.array(z.string()).optional(),
  })
  .refine((c) => c.min < c.max, { message: 'scale config requires min < max', path: ['max'] })

export const numberConfigSchema = z
  .object({
    input_type: z.literal('number'),
    unit: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, {
    message: 'number config requires min <= max when both are present',
    path: ['max'],
  })

export const singleSelectConfigSchema = z.object({
  input_type: z.literal('single_select'),
  options: z.array(nonEmptyString()).min(1, 'select config requires at least one option'),
})

export const multiSelectConfigSchema = z.object({
  input_type: z.literal('multi_select'),
  options: z.array(nonEmptyString()).min(1, 'select config requires at least one option'),
})

export const booleanConfigSchema = z.object({ input_type: z.literal('boolean') })

export const textConfigSchema = z.object({ input_type: z.literal('text') })

/**
 * The full config union. Discriminated on `input_type`.
 *
 * `scale` and `number` need cross-field refinements (`min`/`max`). Zod v3's
 * `discriminatedUnion` cannot take `ZodEffects` (a `.refine`d schema) as a member, so the
 * union is built over the raw object schemas and the `min`/`max` checks are re-applied in a
 * single `superRefine` on the resulting union.
 */
export const trackerConfigSchema = z
  .discriminatedUnion('input_type', [
    z.object({
      input_type: z.literal('scale'),
      min: z.number().int(),
      max: z.number().int(),
      labels: z.array(z.string()).optional(),
    }),
    z.object({
      input_type: z.literal('number'),
      unit: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
    z.object({
      input_type: z.literal('single_select'),
      options: z.array(nonEmptyString()).min(1, 'select config requires at least one option'),
    }),
    z.object({
      input_type: z.literal('multi_select'),
      options: z.array(nonEmptyString()).min(1, 'select config requires at least one option'),
    }),
    z.object({ input_type: z.literal('boolean') }),
    z.object({ input_type: z.literal('text') }),
  ])
  .superRefine((c, ctx) => {
    if (c.input_type === 'scale' && !(c.min < c.max)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scale config requires min < max',
        path: ['max'],
      })
    }
    if (c.input_type === 'number' && c.min !== undefined && c.max !== undefined && c.min > c.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'number config requires min <= max when both are present',
        path: ['max'],
      })
    }
  })
export type TrackerConfig = z.infer<typeof trackerConfigSchema>

/**
 * Assert the tracker's top-level `input_type` matches its `config` discriminant, so the two
 * can never drift apart. Shared by SELECT and INSERT schemas.
 */
const matchInputTypeToConfig = (
  obj: { input_type: TrackerConfig['input_type']; config: TrackerConfig },
  ctx: z.RefinementCtx,
) => {
  if (obj.input_type !== obj.config.input_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `config.input_type ('${obj.config.input_type}') must match tracker input_type ('${obj.input_type}')`,
      path: ['config', 'input_type'],
    })
  }
}

export const trackerSelectSchema = z
  .object({
    ...ownedTimestampedStateFields,
    ...sourceBulletIdNullable,
    name: nonEmptyString(),
    input_type: trackerInputTypeSchema,
    config: trackerConfigSchema,
  })
  .superRefine(matchInputTypeToConfig)
export type Tracker = z.infer<typeof trackerSelectSchema>

export const trackerInsertSchema = z
  .object({
    ...ownedTimestampedStateInsertFields,
    ...sourceBulletIdNullable,
    name: nonEmptyString(),
    input_type: trackerInputTypeSchema,
    config: trackerConfigSchema,
  })
  .superRefine(matchInputTypeToConfig)
export type TrackerInsert = z.infer<typeof trackerInsertSchema>
