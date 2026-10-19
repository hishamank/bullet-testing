/**
 * Rename a theme, and "Merge with…": the two sheets behind the theme pill and the card's "···".
 * Layout only: the screen passes the theme and what each choice does.
 */

import { useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Divider, Group, Sheet } from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { cleanThemeName, COPY, type MergeChoice } from '@bullet/client'
import { useMergeChoices } from '@/hooks'
import { radius, space, type, useTheme } from '@/theme'

export type ThemeSheet = { mode: 'rename' | 'merge'; themeId: string; name: string | null }

/** The "···" menu: Rename / Merge with… (a native action list). */
export function showThemeMenu(open: (mode: 'rename' | 'merge') => void): void {
  Alert.alert(COPY.more, undefined, [
    { text: COPY.rename, onPress: () => open('rename') },
    { text: COPY.mergeWith, onPress: () => open('merge') },
    { text: COPY.cancel, style: 'cancel' },
  ])
}

/** Both sheets for one theme; the merge list is read only while "Merge with…" is open. */
export function ThemeSheets({
  sheet,
  onRename,
  onMerge,
  onClose,
}: {
  sheet: ThemeSheet | null
  onRename: (themeId: string, name: string) => void
  onMerge: (themeId: string, intoThemeId: string) => void
  onClose: () => void
}) {
  const choices = useMergeChoices(sheet?.mode === 'merge' ? sheet.themeId : null)
  return (
    <>
      <RenameSheet sheet={sheet} onSave={onRename} onClose={onClose} />
      <MergeSheet sheet={sheet} choices={choices} onPick={onMerge} onClose={onClose} />
    </>
  )
}

export function RenameSheet({
  sheet,
  onSave,
  onClose,
}: {
  sheet: ThemeSheet | null
  onSave: (themeId: string, name: string) => void
  onClose: () => void
}) {
  const t = useTheme()
  const visible = sheet?.mode === 'rename'
  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (visible) setDraft(sheet?.name ?? '')
  }, [visible, sheet?.name])
  const clean = cleanThemeName(draft)
  const save = () => {
    if (sheet && clean) onSave(sheet.themeId, clean)
  }
  return (
    <Sheet
      visible={visible}
      title={COPY.renameTitle}
      onClose={onClose}
      closeLabel={COPY.cancel}
      action={{ title: COPY.save, onPress: save, disabled: !clean || clean === sheet?.name }}
    >
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        maxLength={60}
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={COPY.renameField}
        placeholder={COPY.renameField}
        placeholderTextColor={t.textMuted}
        style={[styles.field, { backgroundColor: t.card, color: t.text }]}
      />
    </Sheet>
  )
}

export function MergeSheet({
  sheet,
  choices,
  onPick,
  onClose,
}: {
  sheet: ThemeSheet | null
  choices: readonly MergeChoice[]
  onPick: (themeId: string, intoThemeId: string) => void
  onClose: () => void
}) {
  const t = useTheme()
  return (
    <Sheet
      visible={sheet?.mode === 'merge'}
      title={COPY.mergeWith}
      onClose={onClose}
      closeLabel={COPY.cancel}
    >
      <Label tone="secondary" size={type.bodySmall}>
        {choices.length > 0 ? COPY.mergeIntro : COPY.mergeEmpty}
      </Label>
      {choices.length > 0 ? (
        <Group>
          {choices.map((c, i) => (
            <View key={c.id}>
              {i > 0 ? <Divider /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${COPY.mergeWith} ${c.title}, ${c.detail}`}
                onPress={() => sheet && onPick(sheet.themeId, c.id)}
                style={({ pressed }) => [
                  styles.row,
                  pressed ? { backgroundColor: t.raised } : null,
                ]}
              >
                <Label size={type.body} numberOfLines={2}>
                  {c.title}
                </Label>
                <Label tone="muted" size={type.label}>
                  {c.detail}
                </Label>
              </Pressable>
            </View>
          ))}
        </Group>
      ) : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  field: {
    minHeight: 50,
    borderRadius: radius.note,
    paddingHorizontal: 14,
    fontSize: type.body,
  },
  row: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: space.md,
  },
})
