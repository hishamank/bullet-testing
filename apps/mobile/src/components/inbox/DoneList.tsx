/** Done for you today: what was applied automatically or by a tapped answer, each with Undo. */

import { StyleSheet, View } from 'react-native'
import type { DoneItem } from '@/features/inbox/model'
import { radius, space, type, useTheme } from '@/theme'
import { Label, TextButton, touch } from '../ui'

/** "From your answer", "On this phone · will sync", or both. */
function doneNote(item: DoneItem): string {
  const parts = [
    item.viaQuestion ? 'From your answer' : null,
    item.confirmed ? null : 'on this phone · will sync',
  ]
  const text = parts.filter(Boolean).join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function DoneList({
  items,
  onUndo,
}: {
  items: DoneItem[]
  onUndo: (item: DoneItem) => void
}) {
  const t = useTheme()
  return (
    <View style={{ backgroundColor: t.card, borderRadius: radius.card }}>
      {items.map((item, i) => (
        <View
          key={item.suggestionId}
          style={[
            styles.row,
            i < items.length - 1 && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: t.hairline,
            },
          ]}
        >
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 180, gap: 2 }}>
            <Label tone="secondary" size={type.bodySmall}>
              {item.summary.done}
            </Label>
            {item.viaQuestion || !item.confirmed ? (
              <Label tone="muted" size={type.caption}>
                {doneNote(item)}
              </Label>
            ) : null}
          </View>
          <TextButton
            title="Undo"
            accessibilityLabel={`Undo: ${item.summary.done}`}
            onPress={() => onUndo(item)}
          />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    ...touch,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: 14,
  },
})
