/** "Pick a question": the evergreen list, as a sheet over the Inbox. Layout only. */

import type { EvergreenQuestion } from '@bullet/core'
import { Pressable, StyleSheet, View } from 'react-native'
import { Divider, Group, Sheet } from '@/components/journal/parts'
import { Label, QuestionText } from '@/components/ui'
import { space, type, useTheme } from '@/theme'

export function PickQuestionSheet({
  visible,
  choices,
  canPick,
  onPick,
  onClose,
}: {
  visible: boolean
  choices: readonly EvergreenQuestion[]
  canPick: boolean
  onPick: (q: EvergreenQuestion) => void
  onClose: () => void
}) {
  const t = useTheme()
  return (
    <Sheet visible={visible} title="Pick a question" closeLabel="Close" onClose={onClose}>
      <Label tone="secondary" size={type.bodySmall}>
        Choose one to write or talk about. Your answer is saved like any capture.
      </Label>
      {canPick ? null : (
        <Label tone="soft" size={type.bodySmall}>
          A few questions are already waiting. Answer one, or let one go, to pick another.
        </Label>
      )}
      <Group>
        {choices.map((q, i) => (
          <View key={q.id}>
            {i > 0 ? <Divider /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={q.text}
              accessibilityHint="Opens it to write or talk about"
              accessibilityState={{ disabled: !canPick }}
              disabled={!canPick}
              onPress={() => onPick(q)}
              style={({ pressed }) => [
                styles.row,
                { opacity: !canPick ? 0.5 : pressed ? 0.7 : 1 },
                pressed ? { backgroundColor: t.raised } : null,
              ]}
            >
              <QuestionText size={type.body}>{q.text}</QuestionText>
            </Pressable>
          </View>
        ))}
      </Group>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: space.md,
  },
})
