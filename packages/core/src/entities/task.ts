import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { taskPrioritySchema, taskStatusSchema } from '../enums'
import { nonEmptyString, timestampMs } from '../primitives'

/**
 * Task — an actionable. Projects / subtasks / recurrence are explicitly later.
 */
export const taskSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...sourceBulletIdNullable,
  status: taskStatusSchema,
  title: nonEmptyString(),
  notes: z.string().nullable(),
  due_at: timestampMs().nullable(),
  priority: taskPrioritySchema.nullable(),
})
export type Task = z.infer<typeof taskSelectSchema>

export const taskInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  ...sourceBulletIdNullable,
  // `status` is server-defaultable on insert; default to the natural starting state.
  status: taskStatusSchema.default('todo'),
  title: nonEmptyString(),
  notes: z.string().nullable(),
  due_at: timestampMs().nullable(),
  priority: taskPrioritySchema.nullable(),
})
export type TaskInsert = z.infer<typeof taskInsertSchema>
