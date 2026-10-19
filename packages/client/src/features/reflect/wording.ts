/** Words spoken by VoiceOver after a reflective question's buttons (pure). */

/** After "Later": a first one saves it for a week, a second one lets it go. */
export function laterAnnouncement(outcome: 'snoozed' | 'dismissed' | 'unchanged'): string | null {
  if (outcome === 'snoozed') return 'Saved for later.'
  if (outcome === 'dismissed') return 'Let go.'
  return null
}
