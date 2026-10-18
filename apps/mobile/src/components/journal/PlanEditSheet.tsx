/**
 * The small edit sheet for a task or an event: rename, reschedule (quick days, or the system
 * date picker on iOS), delete. The checks and date math are in `features/journal/plans`.
 */

import { DatePicker, Host } from '@expo/ui/swift-ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native'
import { Chip, Sheet, SheetButton } from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { editEvent, editTask, removeEvent, removeTask } from '@/features/journal/actions'
import { fullWhen } from '@/features/journal/format'
import {
  cleanTitle,
  DAY_CHOICES,
  type DayChoice,
  eventMovePatch,
  moveToDay,
  type PlanEvent,
  type PlanTask,
} from '@/features/journal/plans'
import { deviceDeps } from '@/sync/runtime'
import { radius, space, type, useTheme } from '@/theme'

export type PlanItem = { kind: 'task'; task: PlanTask } | { kind: 'event'; event: PlanEvent }

export function PlanEditSheet({ item, onClose }: { item: PlanItem | null; onClose: () => void }) {
  return item ? (
    <EditBody
      key={item.kind === 'task' ? item.task.id : item.event.id}
      item={item}
      onClose={onClose}
    />
  ) : null
}

function EditBody({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const t = useTheme()
  const router = useRouter()
  const tz = deviceDeps.timezone()
  const now = Date.now()
  const isTask = item.kind === 'task'
  const original = isTask
    ? { title: item.task.title, at: item.task.due_at }
    : { title: item.event.title, at: item.event.starts_at as number | null }
  const [title, setTitle] = useState(original.title)
  const [at, setAt] = useState<number | null>(original.at)
  const [error, setError] = useState<string | null>(null)
  const sourceBullet = isTask ? item.task.source_bullet_id : item.event.source_bullet_id
  const noun = isTask ? 'task' : 'event'

  const choose = (c: DayChoice) => setAt(c === 'none' ? null : moveToDay(at, c, now, tz))

  const save = () => {
    const name = cleanTitle(title)
    if (!name) {
      setError('Give it a name.')
      return
    }
    try {
      if (item.kind === 'task') {
        const patch = {
          ...(name !== item.task.title ? { title: name } : {}),
          ...(at !== item.task.due_at ? { due_at: at } : {}),
        }
        if (Object.keys(patch).length > 0) editTask(item.task.id, patch)
      } else {
        const move = at !== null ? eventMovePatch(item.event, at) : null
        const patch = { ...(name !== item.event.title ? { title: name } : {}), ...move }
        if (Object.keys(patch).length > 0) editEvent(item.event.id, patch)
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const confirmDelete = () =>
    Alert.alert(`Delete this ${noun}?`, `“${original.title}” goes away. The capture stays.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (item.kind === 'task') removeTask(item.task.id)
          else removeEvent(item.event.id)
          onClose()
        },
      },
    ])

  const choices = isTask ? DAY_CHOICES : DAY_CHOICES.filter((c) => c.id !== 'none')
  return (
    <Sheet
      visible
      title={isTask ? 'Edit task' : 'Edit event'}
      onClose={onClose}
      action={{ title: 'Save', onPress: save }}
    >
      <Label tone="secondary" size={type.label}>
        Name
      </Label>
      <TextInput
        value={title}
        onChangeText={(s) => {
          setTitle(s)
          setError(null)
        }}
        accessibilityLabel={`${isTask ? 'Task' : 'Event'} name`}
        returnKeyType="done"
        onSubmitEditing={save}
        style={[styles.input, { backgroundColor: t.card, color: t.text }]}
        placeholderTextColor={t.textMuted}
      />
      <Label tone="secondary" size={type.label}>
        {isTask ? 'Due' : 'When'}
      </Label>
      <Label accessibilityLiveRegion="polite">
        {at === null ? 'No date' : fullWhen(at, now, tz)}
      </Label>
      <View style={styles.chips}>
        {choices.map((c) => (
          <Chip
            key={c.id}
            label={c.label}
            selected={c.id === 'none' && at === null}
            onPress={() => choose(c.id)}
            accessibilityLabel={c.id === 'none' ? 'No date' : `Move to ${c.label.toLowerCase()}`}
          />
        ))}
      </View>
      {Platform.OS === 'ios' ? (
        <Host matchContents colorScheme={t.scheme} seedColor={t.accent}>
          <DatePicker
            title={isTask ? 'Due' : 'Starts'}
            selection={new Date(at ?? moveToDay(null, 'today', now, tz))}
            displayedComponents={['date', 'hourAndMinute']}
            onDateChange={(d) => setAt(d.getTime())}
          />
        </Host>
      ) : null}
      {error ? (
        <Label accessibilityRole="alert" style={{ color: t.destructive }} size={type.bodySmall}>
          {error}
        </Label>
      ) : null}
      <View style={{ height: space.md }} />
      {sourceBullet ? (
        <SheetButton
          title="Open capture"
          onPress={() => {
            onClose()
            router.push({ pathname: '/capture/[id]', params: { id: sourceBullet } })
          }}
        />
      ) : null}
      <SheetButton title={`Delete ${noun}`} destructive onPress={confirmDelete} />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48,
    borderRadius: radius.note,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: type.body,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
})
