/**
 * "To think about": a reflective question with Journal about it, Later and Not this one; the
 * empty card with "Pick a question"; and the collapsed "Answered · N" list with Add more.
 * Layout only: the screen passes what each tap does.
 */

import { CONNECTION_OPTIONS } from '@bullet/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Disclosure } from '@/components/journal/parts'
import type { AnsweredCard, ThinkCard as Card } from '@bullet/client'
import { space, type, useTheme } from '@/theme'
import { Label, QuestionText, TextButton, touch } from '../ui'
import { card, OptionButton } from './parts'

/** The accent pill "Journal about it" (44pt). */
function JournalButton({
  title,
  label,
  onPress,
}: {
  title: string
  label: string
  onPress: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.journal,
        { backgroundColor: t.accent, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={{ color: t.onAccent, fontSize: type.bodySmall, fontWeight: '600' }}>
        {title}
      </Text>
    </Pressable>
  )
}

export function ThinkCard({
  question,
  onJournal,
  onLater,
  onNotThisOne,
  onSame,
}: {
  question: Card
  onJournal: () => void
  onLater: () => void
  onNotThisOne: () => void
  /** A connection question's "Same thing" (true) / "Different" (false). */
  onSame?: (same: boolean) => void
}) {
  const t = useTheme()
  const connection = question.origin === 'connection' && onSame
  return (
    <View style={[card(t.card), styles.card]}>
      <QuestionText size={type.body} accessibilityRole="header">
        {question.text}
      </QuestionText>
      {question.sourceLine ? (
        <Label tone="secondary" size={type.label}>
          {question.sourceLine}
        </Label>
      ) : null}
      {connection ? (
        <View style={styles.actions}>
          <OptionButton
            title={CONNECTION_OPTIONS[0]}
            label={`${CONNECTION_OPTIONS[0]}: ${question.text}`}
            onPress={() => onSame(true)}
          />
          <OptionButton
            title={CONNECTION_OPTIONS[1]}
            label={`${CONNECTION_OPTIONS[1]}: ${question.text}`}
            onPress={() => onSame(false)}
          />
        </View>
      ) : null}
      <View style={styles.actions}>
        <JournalButton
          title="Journal about it"
          label={`Journal about it: ${question.text}`}
          onPress={onJournal}
        />
        <TextButton
          title="Later"
          tone="secondary"
          accessibilityLabel={`Later: ${question.text}`}
          accessibilityHint="Hides it for a week"
          onPress={onLater}
        />
        <TextButton
          title="Not this one"
          tone="muted"
          accessibilityLabel={`Not this one: ${question.text}`}
          accessibilityHint="Removes it for good"
          onPress={onNotThisOne}
        />
      </View>
    </View>
  )
}

export function ThinkEmpty({ onPick }: { onPick: () => void }) {
  const t = useTheme()
  return (
    <View style={[card(t.card), styles.card]}>
      <Label size={16}>Nothing to think about right now.</Label>
      <View style={{ alignItems: 'flex-start' }}>
        <TextButton
          title="Pick a question"
          accessibilityHint="Choose a question to write or talk about"
          onPress={onPick}
        />
      </View>
    </View>
  )
}

/** "Answered · N", collapsed until tapped; each answered question offers "Add more". */
export function AnsweredList({
  items,
  onAddMore,
}: {
  items: readonly AnsweredCard[]
  onAddMore: (item: AnsweredCard) => void
}) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <View style={{ gap: space.sm }}>
      <Disclosure
        title={`Answered · ${items.length}`}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open
        ? items.map((q) => (
            <View key={q.id} style={[card(t.card), styles.card]}>
              <QuestionText size={type.bodySmall}>{q.text}</QuestionText>
              <Label tone="muted" size={type.label}>
                {[q.sourceLine, q.answers === 1 ? '1 answer' : `${q.answers} answers`]
                  .filter(Boolean)
                  .join(' · ')}
              </Label>
              <View style={{ alignItems: 'flex-start' }}>
                <TextButton
                  title="Add more"
                  accessibilityLabel={`Add more: ${q.text}`}
                  onPress={() => onAddMore(q)}
                />
              </View>
            </View>
          ))
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { paddingVertical: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  journal: {
    ...touch,
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: space.lg,
  },
})
