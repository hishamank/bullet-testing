import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import { inboxCornerLabel, journalCornerLabel } from '@bullet/client'
import { useTheme, type } from '@/theme'
import { Icon } from '../Icon'
import { IconButton, Label, touch } from '../ui'

/** The capture page's two corners: Journal (top-left) and Inbox with its count (top-right). */
export function Corners({ failedCount, inboxCount }: { failedCount: number; inboxCount: number }) {
  const t = useTheme()
  const router = useRouter()
  return (
    <View style={styles.row}>
      <IconButton
        icon="journal"
        label={journalCornerLabel(failedCount)}
        onPress={() => router.push('/journal')}
      >
        {failedCount > 0 ? <View style={[styles.dot, { backgroundColor: t.warning }]} /> : null}
      </IconButton>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={inboxCornerLabel(inboxCount)}
        onPress={() => router.push('/inbox')}
        hitSlop={4}
        style={({ pressed }) => [styles.inbox, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Icon name="inbox" color={inboxCount > 0 ? t.accentText : t.textSecondary} size={22} />
        {inboxCount > 0 ? (
          <Label tone="accent" size={type.bodySmall} style={{ fontVariant: ['tabular-nums'] }}>
            {String(inboxCount)}
          </Label>
        ) : null}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dot: { position: 'absolute', top: 8, right: 7, width: 8, height: 8, borderRadius: 4 },
  inbox: { ...touch, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
})
