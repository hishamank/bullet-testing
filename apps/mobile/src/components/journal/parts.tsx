/** Journal building blocks in the night-calm style. Layout only; no domain logic. */

import type { ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Icon } from '@/components/Icon'
import { Label, TextButton, touch } from '@/components/ui'
import { useReduceMotion } from '@/hooks'
import { radius, size, space, type, useTheme } from '@/theme'

/** A small heading over a group ("To check · 3"), optionally tinted. */
export function SectionTitle({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <Label
      accessibilityRole="header"
      tone="muted"
      size={type.label}
      style={[styles.sectionTitle, color ? { color } : null]}
    >
      {children}
    </Label>
  )
}

/** A rounded card holding rows separated by hairlines. */
export function Group({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <View style={[styles.group, { backgroundColor: t.card }]}>{children}</View>
}

export function Divider() {
  const t = useTheme()
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.hairline }} />
}

/** A 44pt checkbox (role checkbox, labelled). */
export function Checkbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      hitSlop={4}
      style={({ pressed }) => [styles.checkHit, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View
        style={[
          styles.box,
          checked
            ? { backgroundColor: t.accent, borderWidth: 0 }
            : { borderColor: t.textMuted, borderWidth: 1.5 },
        ]}
      >
        {checked ? <Icon name="check" color={t.onAccent} size={14} weight="semibold" /> : null}
      </View>
    </Pressable>
  )
}

/** "Done · 4" — a collapsed list's toggle. */
export function Disclosure({
  title,
  open,
  onToggle,
}: {
  title: string
  open: boolean
  onToggle: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      hitSlop={4}
      style={({ pressed }) => [styles.disclosure, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Label tone="secondary" size={type.bodySmall}>
        {title}
      </Label>
      <Icon name={open ? 'collapse' : 'expand'} color={t.textSecondary} size={14} />
    </Pressable>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <Label tone="secondary" size={type.bodySmall} style={styles.empty}>
      {children}
    </Label>
  )
}

/** A sheet over the current screen: a title, Cancel/Done-style actions and a scrolling body. */
export function Sheet({
  visible,
  title,
  onClose,
  closeLabel = 'Cancel',
  action,
  children,
}: {
  visible: boolean
  title: string
  onClose: () => void
  closeLabel?: string
  action?: { title: string; onPress: () => void; disabled?: boolean }
  children: ReactNode
}) {
  const t = useTheme()
  const reduceMotion = useReduceMotion()
  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? 'fade' : 'slide'}
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        edges={['bottom', 'left', 'right']}
        style={{ flex: 1, backgroundColor: t.background }}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.sheetHeader, { borderColor: t.hairline }]}>
            <TextButton title={closeLabel} tone="secondary" onPress={onClose} />
            <Label
              accessibilityRole="header"
              size={type.body}
              numberOfLines={2}
              style={styles.sheetTitle}
            >
              {title}
            </Label>
            {action ? (
              <TextButton
                title={action.title}
                onPress={action.onPress}
                disabled={action.disabled}
              />
            ) : (
              <View style={{ minWidth: size.touch }} />
            )}
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

/** A wide, plain row button inside a sheet (e.g. "Delete task", "Open capture"). */
export function SheetButton({
  title,
  onPress,
  destructive,
}: {
  title: string
  onPress: () => void
  destructive?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetButton,
        { backgroundColor: t.card, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Label style={{ color: destructive ? t.destructive : t.accentText }}>{title}</Label>
    </Pressable>
  )
}

/** A selectable chip (quick day choices, scale values, options). */
export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string
  selected: boolean
  onPress: () => void
  accessibilityLabel?: string
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? t.accent : t.raised,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Label size={type.bodySmall} style={{ color: selected ? t.onAccent : t.text }}>
        {label}
      </Label>
    </Pressable>
  )
}

export const journalStyles = StyleSheet.create({
  screenBody: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
  row: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowText: { flex: 1, gap: 3 },
  hint: { paddingHorizontal: space.xs },
})

const styles = StyleSheet.create({
  sectionTitle: { fontWeight: '600', marginTop: space.sm },
  group: { borderRadius: radius.card, overflow: 'hidden' },
  checkHit: { ...touch, alignItems: 'center', justifyContent: 'center' },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disclosure: {
    ...touch,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.xs,
  },
  empty: { paddingVertical: space.lg, paddingHorizontal: space.xs, lineHeight: 21 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { flex: 1, textAlign: 'center', fontWeight: '600' },
  sheetBody: { padding: space.lg, gap: space.md },
  sheetButton: {
    minHeight: 50,
    borderRadius: radius.note,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  chip: {
    minHeight: size.touch,
    minWidth: size.touch,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
