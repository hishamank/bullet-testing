import { Link } from 'expo-router'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { Label, Placeholder } from '@/components/ui'
import { listBullets } from '@/data/queries'
import { captureStatusLabel } from '@/features/capture/notice'
import { useLocalQuery } from '@/hooks'
import { radius, space, type, useTheme } from '@/theme'

/**
 * Journal · stream. Minimal stand-in (text + state, linking to the capture); the real stream —
 * cards grouped by day with their thoughts and kind labels — is built in its own session.
 */
export default function JournalStream() {
  const t = useTheme()
  const captures = useLocalQuery((db) => listBullets(db, 100))
  return (
    <FlatList
      data={captures}
      keyExtractor={(b) => b.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Placeholder title="Your captures will show up here." />}
      renderItem={({ item }) => (
        <Link href={{ pathname: '/capture/[id]', params: { id: item.id } }} asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the capture"
            style={[styles.card, { backgroundColor: t.card }]}
          >
            <Label numberOfLines={3}>{item.text}</Label>
            <View style={styles.meta}>
              <Label tone={item.status === 'failed' ? 'warning' : 'muted'} size={type.label}>
                {captureStatusLabel(item.status)}
              </Label>
            </View>
          </Pressable>
        </Link>
      )}
    />
  )
}

const styles = StyleSheet.create({
  list: { padding: space.lg, gap: space.md },
  card: { borderRadius: radius.card, padding: space.lg, gap: space.sm },
  meta: { flexDirection: 'row', gap: space.sm },
})
