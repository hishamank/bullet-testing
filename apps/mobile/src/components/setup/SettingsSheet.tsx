/** Settings, kept minimal: the home server's status, pair/change it, and what waits on the phone. */

import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { Sheet, SheetButton } from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { useServerStatus } from '@/hooks'
import { radius, size, space, type, useTheme } from '@/theme'

export function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme()
  const router = useRouter()
  const s = useServerStatus()
  return (
    <Sheet visible={visible} title="Settings" closeLabel="Done" onClose={onClose}>
      <Label accessibilityRole="header" tone="secondary" size={type.label}>
        Home server
      </Label>
      <Label accessibilityLiveRegion="polite">{s.statusLine}</Label>
      <SheetButton
        title={s.rowTitle}
        onPress={() => {
          onClose()
          router.push(s.paired ? '/server' : '/setup')
        }}
      />
      <View accessible style={[styles.row, { backgroundColor: t.card }]}>
        <Label tone="secondary">{s.pendingLine}</Label>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: size.touch,
    borderRadius: radius.card,
    paddingHorizontal: 14,
    paddingVertical: space.sm,
    justifyContent: 'center',
  },
})
