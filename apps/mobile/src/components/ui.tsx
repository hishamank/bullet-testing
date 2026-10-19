/** Small building blocks in the night-calm style. Layout only; no domain logic. */

import type { ThoughtKind } from '@bullet/core'
import type { ReactNode } from 'react'
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { textDirection } from '@/features/reflect/direction'
import { kindStyle, radius, readingFont, size, space, type, useTheme } from '@/theme'
import { Icon, type IconName } from './Icon'

export function Screen({
  children,
  style,
  edges = ['top', 'bottom', 'left', 'right'],
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  edges?: ('top' | 'bottom' | 'left' | 'right')[]
}) {
  const t = useTheme()
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: t.background }, style]}>
      {children}
    </SafeAreaView>
  )
}

type Tone = 'primary' | 'secondary' | 'muted' | 'accent' | 'warning' | 'soft'

export function Label({
  tone = 'primary',
  size: fontSize = type.body,
  style,
  ...rest
}: TextProps & { tone?: Tone; size?: number }) {
  const t = useTheme()
  const color = {
    primary: t.text,
    secondary: t.textSecondary,
    muted: t.textMuted,
    accent: t.accentText,
    warning: t.warning,
    soft: t.textSoft,
  }[tone]
  return <Text {...rest} style={[{ color, fontSize, lineHeight: fontSize * 1.35 }, style]} />
}

/**
 * A reflective question, in the serif reading face (scales with Dynamic Type like any Label). An
 * Arabic question is laid out right to left and right-aligned, its quote on the correct side.
 */
export function QuestionText({
  size: fontSize = type.body,
  style,
  children,
  ...rest
}: Omit<TextProps, 'children'> & { size?: number; children: string }) {
  const rtl = textDirection(children) === 'rtl'
  return (
    <Label
      {...rest}
      size={fontSize}
      style={[
        { fontFamily: readingFont, lineHeight: fontSize * 1.4 },
        rtl ? { writingDirection: 'rtl', textAlign: 'right' } : null,
        style,
      ]}
    >
      {children}
    </Label>
  )
}

/** An icon-only button: always 44pt and always labelled for VoiceOver. */
export function IconButton({
  icon,
  label,
  color,
  iconSize = 24,
  style,
  children,
  ...rest
}: Omit<PressableProps, 'children' | 'style'> & {
  icon: IconName
  label: string
  color?: string
  iconSize?: number
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }, style]}
      {...rest}
    >
      <Icon name={icon} color={color ?? t.textSecondary} size={iconSize} />
      {children}
    </Pressable>
  )
}

/** The round accent button (mic 84pt, Send 48pt). */
export function RoundButton({
  icon,
  label,
  diameter,
  disabled,
  onPress,
}: {
  icon: IconName
  label: string
  diameter: number
  disabled?: boolean
  onPress?: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        {
          width: diameter,
          height: diameter,
          backgroundColor: t.accent,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Icon name={icon} color={t.onAccent} size={Math.round(diameter * 0.4)} weight="medium" />
    </Pressable>
  )
}

export function TextButton({
  title,
  onPress,
  tone = 'accent',
  accessibilityLabel,
  accessibilityHint,
  disabled,
}: {
  title: string
  onPress: () => void
  tone?: Tone
  accessibilityLabel?: string
  accessibilityHint?: string
  disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.textButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Label tone={tone} size={type.body}>
        {title}
      </Label>
    </Pressable>
  )
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
  busy,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: t.accent, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={{ color: t.onAccent, fontSize: type.body, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  )
}

export function KindPill({ kind }: { kind: ThoughtKind }) {
  const t = useTheme()
  const k = kindStyle(kind, t.scheme)
  return (
    <View style={[styles.pill, { backgroundColor: k.background }]}>
      <Text style={{ color: k.text, fontSize: type.tiny, fontWeight: '600' }}>{k.label}</Text>
    </View>
  )
}

/** A quiet note card (e.g. "Home server unreachable"), optionally dismissible. */
export function Note({
  icon,
  text,
  onDismiss,
  action,
}: {
  icon: IconName
  text: string
  onDismiss?: () => void
  action?: ReactNode
}) {
  const t = useTheme()
  return (
    <View
      accessibilityRole="alert"
      style={[styles.note, { backgroundColor: t.note, borderRadius: radius.note }]}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} color={t.warning} size={18} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <Label tone="soft" size={14}>
          {text}
        </Label>
        {action}
      </View>
      {onDismiss ? (
        <IconButton icon="close" label="Dismiss" iconSize={16} onPress={onDismiss} />
      ) : null}
    </View>
  )
}

/** Header with a back button and a title, for pushed screens. */
export function BackHeader({
  title,
  backLabel,
  onBack,
  side = 'left',
  right,
  accessory,
}: {
  title?: string
  backLabel: string
  onBack: () => void
  side?: 'left' | 'right'
  /** An action on the far side (e.g. Edit), when the back button is on the left. */
  right?: ReactNode
  /** A small action just before the back button, when it is on the right (e.g. Settings). */
  accessory?: ReactNode
}) {
  const t = useTheme()
  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${backLabel}`}
      onPress={onBack}
      hitSlop={4}
      style={({ pressed }) => [styles.back, { opacity: pressed ? 0.6 : 1 }]}
    >
      {side === 'left' ? <Icon name="back" color={t.accentText} size={20} /> : null}
      <Label tone="accent">{backLabel}</Label>
      {side === 'right' ? <Icon name="forward" color={t.accentText} size={20} /> : null}
    </Pressable>
  )
  return (
    <View style={styles.header}>
      {side === 'left' ? back : null}
      {title ? (
        <Label accessibilityRole="header" size={type.title} style={{ fontWeight: '600', flex: 1 }}>
          {title}
        </Label>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {side === 'right' ? accessory : null}
      {side === 'right' ? back : (right ?? null)}
    </View>
  )
}

/** Stand-in body for screens other sessions are building. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  const t = useTheme()
  return (
    <View style={[styles.placeholder, { backgroundColor: t.card, borderRadius: radius.card }]}>
      <Label tone="secondary" size={type.bodySmall}>
        {title}
      </Label>
      {children}
    </View>
  )
}

export const touch = { minHeight: size.touch, minWidth: size.touch }

const styles = StyleSheet.create({
  iconButton: { ...touch, alignItems: 'center', justifyContent: 'center' },
  round: { borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  textButton: { ...touch, justifyContent: 'center', paddingHorizontal: space.xs },
  primary: {
    minHeight: 50,
    borderRadius: radius.note,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  note: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: space.md,
    paddingLeft: 14,
    paddingRight: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    minHeight: size.touch,
  },
  back: { ...touch, flexDirection: 'row', alignItems: 'center', gap: 2 },
  placeholder: { padding: space.lg, gap: space.md },
})
