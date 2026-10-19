/** Pick a thought's kind. Kinds are labels, not suggestions: the choice applies at once and sticks. */

import type { ThoughtKind } from '@bullet/core'
import { Pressable, StyleSheet, View } from 'react-native'
import { Icon } from '@/components/Icon'
import { Sheet } from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { THOUGHT_KINDS } from '@bullet/client'
import { kindStyle, radius, space, type, useTheme } from '@/theme'

export function KindPicker({
  thought,
  onPick,
  onClose,
}: {
  thought: { text: string; kind: ThoughtKind } | null
  onPick: (kind: ThoughtKind) => void
  onClose: () => void
}) {
  const t = useTheme()
  if (!thought) return null
  return (
    <Sheet visible title="Change kind" onClose={onClose}>
      <Label tone="secondary" size={type.bodySmall}>
        {thought.text}
      </Label>
      <View style={styles.list}>
        {THOUGHT_KINDS.map((k) => {
          const s = kindStyle(k, t.scheme)
          const selected = k === thought.kind
          return (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={s.label}
              accessibilityState={{ selected }}
              onPress={() => onPick(k)}
              style={({ pressed }) => [
                styles.option,
                { backgroundColor: t.card, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={[styles.pill, { backgroundColor: s.background }]}>
                <Label size={type.bodySmall} style={{ color: s.text, fontWeight: '600' }}>
                  {s.label}
                </Label>
              </View>
              <View style={{ flex: 1 }} />
              {selected ? <Icon name="check" color={t.accentText} size={18} /> : null}
            </Pressable>
          )
        })}
      </View>
      <Label tone="muted" size={type.caption}>
        Your choice sticks, even if the capture is read again.
      </Label>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  option: {
    minHeight: 52,
    borderRadius: radius.note,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
})
