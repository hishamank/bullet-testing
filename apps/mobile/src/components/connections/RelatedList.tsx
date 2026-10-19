/**
 * Capture detail · "Related · N": a date and the quoted thought with the link type as a small
 * word. Tapping a row opens that capture; "Not related" (or a long-press) removes the link for
 * good. Layout only. Nothing here is ever about sensitivity.
 */

import { Alert, Pressable, StyleSheet, View } from 'react-native'
import { Divider, Group, SectionTitle } from '@/components/journal/parts'
import { Label, TextButton } from '@/components/ui'
import { COPY, relatedHeading } from '@/features/connections/copy'
import type { RelatedItem } from '@/features/connections/model'
import { space, type } from '@/theme'
import { Quoted } from './parts'

export function RelatedList({
  items,
  onOpen,
  onNotRelated,
}: {
  items: readonly RelatedItem[]
  onOpen: (bulletId: string) => void
  onNotRelated: (linkId: string) => void
}) {
  if (items.length === 0) return null
  // Long-press asks first: it is easy to do by accident.
  const confirm = (r: RelatedItem) =>
    Alert.alert(COPY.notRelatedConfirm, COPY.notRelatedDetail, [
      { text: COPY.cancel, style: 'cancel' },
      { text: COPY.notRelated, style: 'destructive', onPress: () => onNotRelated(r.linkId) },
    ])
  return (
    <>
      <SectionTitle>{relatedHeading(items.length)}</SectionTitle>
      <Group>
        {items.map((r, i) => (
          <View key={r.linkId}>
            {i > 0 ? <Divider /> : null}
            <View style={styles.row}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={r.label}
                accessibilityHint={COPY.quoteHint}
                accessibilityActions={[{ name: 'notRelated', label: COPY.notRelated }]}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName === 'notRelated') onNotRelated(r.linkId)
                }}
                onPress={() => onOpen(r.bulletId)}
                onLongPress={() => confirm(r)}
                style={({ pressed }) => [styles.open, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Label tone="muted" size={type.caption}>
                  {r.meta}
                </Label>
                <Quoted text={r.text} rtl={r.rtl} tone="primary" size={type.bodySmall} lines={4} />
              </Pressable>
              <TextButton
                title={COPY.notRelated}
                tone="secondary"
                accessibilityLabel={`${COPY.notRelated}: ${r.label}`}
                onPress={() => onNotRelated(r.linkId)}
              />
            </View>
          </View>
        ))}
      </Group>
      <Label tone="muted" size={type.caption} style={{ paddingHorizontal: space.xs }}>
        {COPY.notRelatedNote}
      </Label>
    </>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: space.sm },
  open: {
    flex: 1,
    minHeight: 56,
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: space.sm,
  },
})
