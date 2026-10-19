/**
 * Slice 3 building blocks: the user's quoted words (laid out right to left for Arabic script), a
 * quote row that opens its capture, the editable theme pill and the "again" dot. Layout only.
 */

import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Label } from '@/components/ui'
import { COPY, pillLabel, pillText, quote, type QuoteRow } from '@bullet/client'
import { radius, readingFont, size, space, type, useTheme } from '@/theme'

const rtlStyle = { writingDirection: 'rtl', textAlign: 'right' } as const

/** «the user's words», in the reading face; right to left when they read that way. */
export function Quoted({
  text,
  rtl,
  size: fontSize = type.bodySmall,
  tone = 'soft',
  lines,
}: {
  text: string
  rtl: boolean
  size?: number
  tone?: 'primary' | 'soft' | 'secondary'
  lines?: number
}) {
  return (
    <Label
      tone={tone}
      size={fontSize}
      numberOfLines={lines}
      style={[{ fontFamily: readingFont, lineHeight: fontSize * 1.4 }, rtl ? rtlStyle : null]}
    >
      {quote(text)}
    </Label>
  )
}

/** A quoted thought with its day, opening its capture (44pt, hairline above). */
export function QuoteLink({
  row,
  onOpen,
  first,
}: {
  row: QuoteRow
  onOpen: (bulletId: string) => void
  first?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={row.label}
      accessibilityHint={COPY.quoteHint}
      onPress={() => onOpen(row.bulletId)}
      style={({ pressed }) => [
        styles.quoteRow,
        first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.hairline },
        { opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Quoted text={row.text} rtl={row.rtl} lines={3} />
      </View>
      {row.when ? (
        <Label tone="muted" size={type.label}>
          {row.when}
        </Label>
      ) : null}
    </Pressable>
  )
}

/** The theme as an editable pill: its name with a pencil; tapping it renames. */
export function ThemePill({ name, onPress }: { name: string | null; onPress: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pillLabel(name)}
      onPress={onPress}
      style={({ pressed }) => [styles.pillHit, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.pill, { backgroundColor: t.againSoft }]}>
        <Text style={{ color: t.again, fontSize: type.caption, fontWeight: '600' }}>
          {pillText(name)} ✎
        </Text>
      </View>
    </Pressable>
  )
}

/**
 * The Stream's small "again" dot on a thought in an active theme. The dot is 7pt; its touch area
 * is 44pt. Tapping it opens the theme.
 */
export function AgainDot({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.dotHit}
    >
      <View style={[styles.dot, { backgroundColor: t.again }]} />
    </Pressable>
  )
}

/** A rounded card for the slice 3 sections. */
export function ConnectionCard({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <View style={[styles.card, { backgroundColor: t.card }]}>{children}</View>
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: 14, gap: 10 },
  quoteRow: {
    minHeight: size.touch,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  pillHit: { minHeight: size.touch, justifyContent: 'center', alignSelf: 'flex-start' },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  // A full 44pt column: the row it sits in is at least 44pt tall and centred (CaptureCard).
  dotHit: {
    width: size.touch,
    height: size.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
})
