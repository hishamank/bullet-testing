/** Small Inbox pieces: the kind pill with its own word, section titles, and the round buttons. */

import type { BulletSource, ThoughtKind } from '@bullet/core'
import { Link } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { kindStyle, radius, size, space, type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, touch } from '../ui'

/**
 * The capture a row came from: its quoted snippet, linking to Capture detail. Nothing when the
 * capture isn't on the phone (there would be nothing to open).
 */
export function CaptureLink({
  bulletId,
  snippet,
  source,
  lines = 3,
}: {
  bulletId: string
  snippet: string
  source: BulletSource
  lines?: number
}) {
  const t = useTheme()
  const voice = source === 'voice'
  if (!snippet) return null
  return (
    <Link href={{ pathname: '/capture/[id]', params: { id: bulletId } }} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${voice ? 'Voice capture' : 'Capture'} ${snippet}`}
        accessibilityHint={voice ? 'Opens the capture, where you can play it' : 'Opens the capture'}
        style={({ pressed }) => [styles.source, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Icon name={voice ? 'play' : 'text'} color={t.textSecondary} size={14} />
        <Label tone="secondary" size={type.label} style={{ flex: 1 }} numberOfLines={lines}>
          {snippet}
        </Label>
      </Pressable>
    </Link>
  )
}

/** Like KindPill, but with the Inbox's own word ("new tracker", "mood"). */
export function InboxPill({ kind, label }: { kind: ThoughtKind; label: string }) {
  const t = useTheme()
  const k = kindStyle(kind, t.scheme)
  return (
    <View style={[styles.pill, { backgroundColor: k.background }]}>
      <Text style={{ color: k.text, fontSize: type.tiny, fontWeight: '600' }}>{label}</Text>
    </View>
  )
}

export function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <Label
      accessibilityRole="header"
      tone="muted"
      size={type.label}
      style={{ fontWeight: '600', marginTop: space.sm }}
    >
      {count === undefined ? title : `${title} · ${count}`}
    </Label>
  )
}

/** The 44pt round Dismiss (outlined ×) and Accept (filled ✓) buttons. */
export function DecideButton({
  variant,
  label,
  onPress,
}: {
  variant: 'accept' | 'dismiss'
  label: string
  onPress: () => void
}) {
  const t = useTheme()
  const accept = variant === 'accept'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => [
        styles.round,
        accept
          ? { backgroundColor: t.accent }
          : { borderWidth: 1, borderColor: t.textMuted, backgroundColor: 'transparent' },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Icon
        name={accept ? 'check' : 'close'}
        color={accept ? t.onAccent : t.textSecondary}
        size={18}
        weight={accept ? 'semibold' : 'regular'}
      />
    </Pressable>
  )
}

/** A rounded quick-option button (question answers). */
export function OptionButton({
  title,
  label,
  onPress,
  selected,
}: {
  title: string
  label: string
  onPress: () => void
  /** For choice lists: shown with an accent border and announced as selected. */
  selected?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: t.raised,
          borderColor: selected ? t.accent : t.textMuted,
          borderWidth: selected ? 2 : 1,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Label size={type.bodySmall}>{title}</Label>
    </Pressable>
  )
}

export const card = (bg: string) => ({
  backgroundColor: bg,
  borderRadius: radius.card,
  paddingVertical: space.md,
  paddingHorizontal: 14,
  gap: 10,
})

const styles = StyleSheet.create({
  source: { ...touch, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  round: {
    width: size.touch,
    height: size.touch,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  option: {
    minHeight: size.touch,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
  },
})
