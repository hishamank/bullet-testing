import { useRouter } from 'expo-router'
import { Fragment, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import {
  Checkbox,
  Disclosure,
  Divider,
  EmptyNote,
  Group,
  journalStyles,
  SectionTitle,
} from '@/components/journal/parts'
import { IconButton, Label, TextButton } from '@/components/ui'
import { listLoops, type LoopItem, loopSourceLine } from '@/features/journal/loops'
import { reopenLoop, resolveLoop } from '@/features/journal/actions'
import { useLocalQuery } from '@/hooks'
import { kindStyle, type, useTheme } from '@/theme'

/**
 * Journal · open loops: things to check and questions asked to oneself, until closed. Check one
 * off, or long-press (or the note button) to close it with a note. Closed ones sit under Done.
 */
export default function OpenLoops() {
  const t = useTheme()
  const router = useRouter()
  const loops = useLocalQuery(listLoops)
  const [showDone, setShowDone] = useState(false)
  const now = Date.now()
  const open = (l: LoopItem) =>
    router.push({ pathname: '/capture/[id]', params: { id: l.bulletId } })
  const withNote = (l: LoopItem) => router.push({ pathname: '/answer', params: { thought: l.id } })

  const section = (title: string, items: LoopItem[], kind: 'to_check' | 'question') =>
    items.length === 0 ? null : (
      <>
        <SectionTitle color={kindStyle(kind, t.scheme).text}>
          {title} · {items.length}
        </SectionTitle>
        <Group>
          {items.map((l, i) => (
            <Fragment key={l.id}>
              {i > 0 ? <Divider /> : null}
              <View style={[journalStyles.row, { paddingLeft: 4, paddingRight: 4 }]}>
                <Checkbox
                  checked={false}
                  label={`Done: ${l.text}`}
                  onChange={() => resolveLoop(l.id)}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${l.text}. ${loopSourceLine(l, now)}`}
                  accessibilityHint="Opens the capture. Long-press to close it with a note."
                  accessibilityActions={[
                    { name: 'longpress', label: 'Close with a note' },
                    { name: 'resolve', label: 'Check off' },
                  ]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'longpress') withNote(l)
                    if (e.nativeEvent.actionName === 'resolve') resolveLoop(l.id)
                  }}
                  onPress={() => open(l)}
                  onLongPress={() => withNote(l)}
                  style={({ pressed }) => [journalStyles.rowText, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Label>{l.text}</Label>
                  <Label tone="muted" size={type.label}>
                    {loopSourceLine(l, now)}
                  </Label>
                </Pressable>
                <IconButton
                  icon="note"
                  label={`Close with a note: ${l.text}`}
                  iconSize={20}
                  onPress={() => withNote(l)}
                />
              </View>
            </Fragment>
          ))}
        </Group>
      </>
    )

  const nothingOpen = loops.toCheck.length === 0 && loops.questions.length === 0
  return (
    <ScrollView contentContainerStyle={journalStyles.screenBody}>
      <Label tone="secondary" size={type.bodySmall} style={journalStyles.hint}>
        Things you said you'd look into, and questions you asked yourself. They wait here until you
        come back to them.
      </Label>
      {nothingOpen ? <EmptyNote>Nothing open right now.</EmptyNote> : null}
      {section('To check', loops.toCheck, 'to_check')}
      {section('Questions you asked yourself', loops.questions, 'question')}
      {loops.done.length > 0 ? (
        <>
          <Disclosure
            title={`Done · ${loops.done.length}`}
            open={showDone}
            onToggle={() => setShowDone((v) => !v)}
          />
          {showDone ? (
            <Group>
              {loops.done.map((l, i) => (
                <Fragment key={l.id}>
                  {i > 0 ? <Divider /> : null}
                  <View style={journalStyles.row}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint="Opens the capture"
                      onPress={() =>
                        l.resolvedByBulletId
                          ? router.push({
                              pathname: '/capture/[id]',
                              params: { id: l.resolvedByBulletId },
                            })
                          : open(l)
                      }
                      style={({ pressed }) => [
                        journalStyles.rowText,
                        { opacity: pressed ? 0.6 : 1 },
                      ]}
                    >
                      <Label tone="secondary" style={{ textDecorationLine: 'line-through' }}>
                        {l.text}
                      </Label>
                      <Label tone="muted" size={type.label}>
                        {l.resolvedByBulletId ? 'Closed with a note' : 'Checked off'}
                      </Label>
                    </Pressable>
                    <TextButton
                      title="Reopen"
                      accessibilityLabel={`Reopen: ${l.text}`}
                      onPress={() => reopenLoop(l.id)}
                    />
                  </View>
                </Fragment>
              ))}
            </Group>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  )
}
