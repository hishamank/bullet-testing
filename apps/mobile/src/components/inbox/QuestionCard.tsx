/** A clarifying question: quick options, "Answer in words" and Skip. */

import { Link } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import type { QuestionItem } from '@/features/inbox/model'
import { space, type, useTheme } from '@/theme'
import { Label, TextButton, touch } from '../ui'
import { card, OptionButton } from './parts'

export function QuestionCard({
  question,
  onAnswer,
  onSkip,
}: {
  question: QuestionItem
  onAnswer: (option: string) => void
  onSkip: () => void
}) {
  const t = useTheme()
  return (
    <View style={card(t.card)}>
      <Label size={16}>{question.text}</Label>
      <View style={styles.options}>
        {question.options.map((o) => (
          <OptionButton
            key={o}
            title={o}
            label={`Answer ${o}, to: ${question.text}`}
            onPress={() => onAnswer(o)}
          />
        ))}
        <Link href={{ pathname: '/answer', params: { question: question.id } }} asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Answer in words: ${question.text}`}
            style={({ pressed }) => [styles.words, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Label tone="accent" size={type.bodySmall}>
              Answer in words
            </Label>
          </Pressable>
        </Link>
        <TextButton
          title="Skip"
          tone="muted"
          accessibilityLabel={`Skip: ${question.text}`}
          onPress={onSkip}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  words: { ...touch, justifyContent: 'center', paddingHorizontal: space.sm },
})
