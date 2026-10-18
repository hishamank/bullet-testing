import { Slot, usePathname, useRouter } from 'expo-router'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { BackHeader, Label, Screen } from '@/components/ui'
import { radius, size, space, type, useTheme } from '@/theme'

const VIEWS = [
  { href: '/journal', label: 'Stream' },
  { href: '/journal/loops', label: 'Open loops' },
  { href: '/journal/plans', label: 'Plans' },
  { href: '/journal/trackers', label: 'Trackers' },
] as const

/** Journal: reached from the top-left corner. One header and the four-way view switch. */
export default function JournalLayout() {
  const t = useTheme()
  const router = useRouter()
  const pathname = usePathname()
  return (
    <Screen edges={['top', 'left', 'right']}>
      <BackHeader title="Journal" backLabel="Capture" side="right" onBack={() => router.back()} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.switch}
        accessibilityRole="tablist"
      >
        {VIEWS.map((v) => {
          const selected = pathname === v.href
          return (
            <Pressable
              key={v.href}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => {
                if (!selected) router.replace(v.href)
              }}
              style={[
                styles.tab,
                {
                  backgroundColor: selected ? t.raisedStrong : 'transparent',
                  borderColor: t.hairline,
                },
              ]}
            >
              <Label tone={selected ? 'primary' : 'secondary'} size={type.bodySmall}>
                {v.label}
              </Label>
            </Pressable>
          )
        })}
      </ScrollView>
      <View style={{ flex: 1 }}>
        <Slot />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  switch: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  tab: {
    minHeight: size.touch,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
