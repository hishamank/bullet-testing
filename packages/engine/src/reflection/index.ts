/** Reflective questions (slice 2): the model call for a capture's worries, self-questions, ideas. */

export {
  isReflectable,
  REFLECT_MAX_TOKENS,
  REFLECT_SYSTEM_PROMPT,
  type ReflectableThought,
  reflectionJsonSchema,
  type ReflectionResponse,
  reflectionResponseSchema,
  type ReflectiveQuestionDraft,
  reflectOnThoughts,
  validateReflection,
} from './reflect'
export { quoteLanguage } from './language'
export {
  mayPickEvergreen,
  type ReflectiveRefusal,
  reflectiveRefusal,
  type ReflectiveState,
} from './caps'
