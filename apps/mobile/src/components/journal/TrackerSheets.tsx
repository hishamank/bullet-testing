/**
 * A tracker's history (fix or delete a reading), and an activity's history (read-only: things
 * done come from captures and are changed by editing the capture).
 */

import type { TrackerConfig, TrackerEntryValue } from '@bullet/core'
import { useRouter } from 'expo-router'
import { Fragment, useState } from 'react'
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native'
import {
  Chip,
  Divider,
  EmptyNote,
  Group,
  journalStyles,
  Sheet,
  SheetButton,
} from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { fixReading, removeReading } from '@/features/journal/actions'
import { whenLabel } from '@/features/journal/format'
import { entryValueText } from '@/features/journal/things'
import {
  activityText,
  type EntryData,
  loadActivityHistory,
  loadTrackerHistory,
  parseEntryValue,
  type ValueInput,
  valueToInput,
} from '@/features/journal/trackers'
import { useLocalQuery } from '@/hooks'
import { deviceDeps } from '@/sync/runtime'
import { radius, space, type, useTheme } from '@/theme'

export function TrackerHistorySheet({
  trackerId,
  onClose,
}: {
  trackerId: string
  onClose: () => void
}) {
  const router = useRouter()
  const tz = deviceDeps.timezone()
  const now = Date.now()
  const h = useLocalQuery((db) => loadTrackerHistory(db, trackerId), trackerId)
  const [fixing, setFixing] = useState<EntryData | null>(null)
  const openCapture = (id: string) => {
    onClose()
    router.push({ pathname: '/capture/[id]', params: { id } })
  }
  if (!h.tracker) return null
  const config = h.tracker.config
  const items = [
    ...h.entries.map((e) => ({ at: e.logged_at, entry: e, activity: null })),
    ...h.activities.map((a) => ({ at: a.occurred_at, entry: null, activity: a })),
  ].sort((a, b) => b.at - a.at)

  return (
    <Sheet visible title={h.tracker.name} onClose={onClose} closeLabel="Done">
      {fixing ? (
        <ReadingEditor
          entry={fixing}
          config={config}
          trackerName={h.tracker.name}
          onDone={() => setFixing(null)}
        />
      ) : (
        <>
          {items.length === 0 ? <EmptyNote>No readings yet.</EmptyNote> : null}
          {items.length > 0 ? (
            <Group>
              {items.map((it, i) => (
                <Fragment key={it.entry?.id ?? it.activity?.id}>
                  {i > 0 ? <Divider /> : null}
                  {it.entry ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${entryValueText(it.entry.value, config)}, ${whenLabel(it.at, now, tz)}${it.entry.user_edited_at ? ', edited by you' : ''}`}
                      accessibilityHint="Fix or delete this reading"
                      onPress={() => setFixing(it.entry)}
                      style={({ pressed }) => [journalStyles.row, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <View style={journalStyles.rowText}>
                        <Label>{entryValueText(it.entry.value, config)}</Label>
                        <Label tone="muted" size={type.label}>
                          {whenLabel(it.at, now, tz)}
                          {it.entry.user_edited_at ? ' · edited by you' : ''}
                        </Label>
                      </View>
                      <Label tone="accent" size={type.bodySmall}>
                        Fix
                      </Label>
                    </Pressable>
                  ) : it.activity ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint={
                        it.activity.source_bullet_id ? 'Opens the capture' : undefined
                      }
                      disabled={!it.activity.source_bullet_id}
                      onPress={() =>
                        it.activity?.source_bullet_id && openCapture(it.activity.source_bullet_id)
                      }
                      style={({ pressed }) => [journalStyles.row, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <View style={journalStyles.rowText}>
                        <Label>{activityText(it.activity) ?? it.activity.name}</Label>
                        <Label tone="muted" size={type.label}>
                          {whenLabel(it.at, now, tz)}
                        </Label>
                      </View>
                    </Pressable>
                  ) : null}
                </Fragment>
              ))}
            </Group>
          ) : null}
        </>
      )}
    </Sheet>
  )
}

function ReadingEditor({
  entry,
  config,
  trackerName,
  onDone,
}: {
  entry: EntryData
  config: TrackerConfig
  trackerName: string
  onDone: () => void
}) {
  const t = useTheme()
  const router = useRouter()
  const [input, setInput] = useState<ValueInput>(valueToInput(entry.value))
  const [error, setError] = useState<string | null>(null)
  const set = (v: ValueInput) => {
    setInput(v)
    setError(null)
  }
  const save = () => {
    const parsed = parseEntryValue(input, config)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    try {
      if (!sameValue(parsed.value, entry.value)) fixReading(entry.id, parsed.value)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const confirmDelete = () =>
    Alert.alert(
      'Delete this reading?',
      `The ${trackerName} reading goes away. The capture stays.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            removeReading(entry.id)
            onDone()
          },
        },
      ],
    )

  let field: React.ReactNode
  switch (config.input_type) {
    case 'scale':
      field =
        config.max - config.min <= 10 ? (
          <View style={styles.chips}>
            {range(config.min, config.max).map((n) => (
              <Chip
                key={n}
                label={String(n)}
                selected={input === String(n)}
                onPress={() => set(String(n))}
                accessibilityLabel={`${n} of ${config.max}`}
              />
            ))}
          </View>
        ) : (
          <NumberField value={String(input)} onChange={set} label={trackerName} />
        )
      break
    case 'number':
      field = (
        <NumberField
          value={String(input)}
          onChange={set}
          label={`${trackerName}${config.unit ? ` in ${config.unit}` : ''}`}
        />
      )
      break
    case 'boolean':
      field = (
        <View style={styles.chips}>
          <Chip label="Yes" selected={input === true} onPress={() => set(true)} />
          <Chip label="No" selected={input === false} onPress={() => set(false)} />
        </View>
      )
      break
    case 'single_select':
      field = (
        <View style={styles.chips}>
          {config.options.map((o) => (
            <Chip key={o} label={o} selected={input === o} onPress={() => set(o)} />
          ))}
        </View>
      )
      break
    case 'multi_select': {
      const chosen = Array.isArray(input) ? input : []
      field = (
        <View style={styles.chips}>
          {config.options.map((o) => (
            <Chip
              key={o}
              label={o}
              selected={chosen.includes(o)}
              onPress={() =>
                set(chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])
              }
            />
          ))}
        </View>
      )
      break
    }
    case 'text':
      field = (
        <TextInput
          value={typeof input === 'string' ? input : ''}
          onChangeText={set}
          multiline
          accessibilityLabel={trackerName}
          style={[styles.input, { backgroundColor: t.card, color: t.text }]}
        />
      )
      break
  }

  return (
    <>
      <Label tone="secondary" size={type.label}>
        Fix this reading
      </Label>
      {field}
      {error ? (
        <Label accessibilityRole="alert" size={type.bodySmall} style={{ color: t.destructive }}>
          {error}
        </Label>
      ) : null}
      <SheetButton title="Save" onPress={save} />
      <SheetButton title="Back" onPress={onDone} />
      {entry.source_bullet_id ? (
        <SheetButton
          title="Open capture"
          onPress={() => {
            onDone()
            router.push({
              pathname: '/capture/[id]',
              params: { id: entry.source_bullet_id as string },
            })
          }}
        />
      ) : null}
      <SheetButton title="Delete reading" destructive onPress={confirmDelete} />
    </>
  )
}

function NumberField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const t = useTheme()
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      keyboardType="decimal-pad"
      accessibilityLabel={label}
      style={[styles.input, { backgroundColor: t.card, color: t.text }]}
    />
  )
}

export function ActivityHistorySheet({ name, onClose }: { name: string; onClose: () => void }) {
  const router = useRouter()
  const tz = deviceDeps.timezone()
  const now = Date.now()
  const acts = useLocalQuery((db) => loadActivityHistory(db, name), name)
  return (
    <Sheet visible title={acts[0]?.name.trim() ?? name} onClose={onClose} closeLabel="Done">
      {acts.length === 0 ? <EmptyNote>Nothing logged.</EmptyNote> : null}
      {acts.length > 0 ? (
        <Group>
          {acts.map((a, i) => (
            <Fragment key={a.id}>
              {i > 0 ? <Divider /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityHint={a.source_bullet_id ? 'Opens the capture' : undefined}
                disabled={!a.source_bullet_id}
                onPress={() => {
                  if (!a.source_bullet_id) return
                  onClose()
                  router.push({ pathname: '/capture/[id]', params: { id: a.source_bullet_id } })
                }}
                style={({ pressed }) => [journalStyles.row, { opacity: pressed ? 0.6 : 1 }]}
              >
                <View style={journalStyles.rowText}>
                  <Label>{activityText(a) ?? a.name}</Label>
                  <Label tone="muted" size={type.label}>
                    {whenLabel(a.occurred_at, now, tz)}
                  </Label>
                </View>
              </Pressable>
            </Fragment>
          ))}
        </Group>
      ) : null}
      <Label tone="muted" size={type.caption}>
        To change one, edit the capture it came from.
      </Label>
    </Sheet>
  )
}

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

function sameValue(a: TrackerEntryValue, b: TrackerEntryValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  input: {
    minHeight: 48,
    borderRadius: radius.note,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: type.body,
  },
})
