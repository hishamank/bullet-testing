import { useLocalSearchParams, useRouter } from 'expo-router'
import { Fragment, useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { type PlanItem, PlanEditSheet } from '@/components/journal/PlanEditSheet'
import {
  Checkbox,
  Disclosure,
  Divider,
  EmptyNote,
  Group,
  journalStyles,
  SectionTitle,
} from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { setTaskDone } from '@/features/journal/actions'
import { clock } from '@/features/journal/format'
import { buildPlans, loadPlanItem, loadPlans, type PlanTask } from '@/features/journal/plans'
import { getDb } from '@/data/open'
import { useLocalQuery } from '@/hooks'
import { deviceDeps } from '@/sync/runtime'
import { kindStyle, type, useTheme } from '@/theme'

/**
 * Journal · plans: what's coming up, open tasks by due date, and tasks done recently. Check a
 * task off, or tap an item to rename, reschedule or delete it. `?item=<id>` opens that item.
 */
export default function Plans() {
  const t = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<{ item?: string }>()
  const tz = deviceDeps.timezone()
  const now = Date.now()
  const data = useLocalQuery((db) => loadPlans(db, Date.now()))
  const plans = buildPlans({ ...data, now, tz })
  const [editing, setEditing] = useState<PlanItem | null>(null)
  const [showDone, setShowDone] = useState(false)

  // Opened from Capture detail: show that item, even when it's outside the lists' window.
  useEffect(() => {
    if (!params.item) return
    const item = loadPlanItem(getDb(), params.item)
    if (item) setEditing(item)
    router.setParams({ item: undefined })
  }, [params.item])

  const eventColor = kindStyle('event', t.scheme).text
  const taskColor = kindStyle('task', t.scheme).text
  const dueColor = (urgency: 'overdue' | 'today' | null) => (urgency ? t.warning : t.textMuted)

  const taskRow = (
    task: PlanTask,
    due: { label: string; urgency: 'overdue' | 'today' | null } | null,
  ) => {
    const done = task.status === 'done'
    return (
      <View style={[journalStyles.row, { paddingLeft: 4 }]}>
        <Checkbox
          checked={done}
          label={`Done: ${task.title}`}
          onChange={(next) => setTaskDone(task.id, next)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[task.title, due?.label].filter(Boolean).join(', ')}
          accessibilityHint="Edit, reschedule or delete"
          onPress={() => setEditing({ kind: 'task', task })}
          style={({ pressed }) => [
            { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Label
            tone={done ? 'muted' : 'primary'}
            style={[
              { flex: 1, minWidth: 140 },
              done ? { textDecorationLine: 'line-through' } : null,
            ]}
          >
            {task.title}
          </Label>
          {due ? (
            <Label
              size={type.label}
              style={{ color: dueColor(due.urgency), fontWeight: due.urgency ? '600' : '400' }}
            >
              {due.label}
            </Label>
          ) : null}
        </Pressable>
      </View>
    )
  }

  const empty = plans.upcoming.length === 0 && plans.open.length === 0
  return (
    <>
      <ScrollView contentContainerStyle={journalStyles.screenBody}>
        {empty ? (
          <EmptyNote>
            Nothing planned yet. Events and tasks you mention in a capture show up here.
          </EmptyNote>
        ) : null}
        {plans.upcoming.length > 0 ? (
          <>
            <SectionTitle color={eventColor}>Coming up</SectionTitle>
            <Group>
              {plans.upcoming.flatMap((day, di) =>
                day.events.map((e, i) => (
                  <Fragment key={e.id}>
                    {di > 0 || i > 0 ? <Divider /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${day.title}, ${e.title}${e.all_day ? '' : `, ${clock(e.starts_at, tz)}`}`}
                      accessibilityHint="Edit, move or delete"
                      onPress={() => setEditing({ kind: 'event', event: e })}
                      style={({ pressed }) => [journalStyles.row, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Label tone="secondary" size={type.label} style={{ minWidth: 52 }}>
                        {i === 0 ? day.short : ''}
                      </Label>
                      <Label style={{ flex: 1 }}>{e.title}</Label>
                      {e.all_day ? null : (
                        <Label tone="secondary" size={type.bodySmall}>
                          {clock(e.starts_at, tz)}
                        </Label>
                      )}
                    </Pressable>
                  </Fragment>
                )),
              )}
            </Group>
          </>
        ) : null}
        {plans.open.length > 0 ? (
          <>
            <SectionTitle color={taskColor}>Tasks</SectionTitle>
            <Group>
              {plans.open.map((task, i) => (
                <Fragment key={task.id}>
                  {i > 0 ? <Divider /> : null}
                  {taskRow(task, task.due)}
                </Fragment>
              ))}
            </Group>
          </>
        ) : null}
        {plans.doneRecently.length > 0 ? (
          <>
            <Disclosure
              title={`Done recently · ${plans.doneRecently.length}`}
              open={showDone}
              onToggle={() => setShowDone((v) => !v)}
            />
            {showDone ? (
              <Group>
                {plans.doneRecently.map((task, i) => (
                  <Fragment key={task.id}>
                    {i > 0 ? <Divider /> : null}
                    {taskRow(task, null)}
                  </Fragment>
                ))}
              </Group>
            ) : null}
          </>
        ) : null}
        {!empty ? (
          <Label tone="muted" size={type.caption} style={journalStyles.hint}>
            Tap an item to reschedule, rename or delete it.
          </Label>
        ) : null}
      </ScrollView>
      <PlanEditSheet item={editing} onClose={() => setEditing(null)} />
    </>
  )
}
