import { useLocalSearchParams, useRouter } from 'expo-router'
import { Fragment, useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Sparkline } from '@/components/journal/Sparkline'
import { ActivityHistorySheet, TrackerHistorySheet } from '@/components/journal/TrackerSheets'
import { Divider, EmptyNote, Group, journalStyles, SectionTitle } from '@/components/journal/parts'
import { Label } from '@/components/ui'
import { activityRows, loadTrackers, trackerRows } from '@/features/journal/trackers'
import { useLocalQuery } from '@/hooks'
import { deviceDeps } from '@/sync/runtime'
import { type } from '@/theme'

/**
 * Journal · trackers: each tracker's latest reading and last 14 days, then things done that
 * aren't tracked. Tap one for its history. No manual logging: say it on the capture page.
 * `?tracker=<id>` / `?activity=<name>` open that history.
 */
export default function Trackers() {
  const router = useRouter()
  const params = useLocalSearchParams<{ tracker?: string; activity?: string }>()
  const tz = deviceDeps.timezone()
  const now = Date.now()
  const data = useLocalQuery((db) => loadTrackers(db, Date.now(), tz))
  const rows = trackerRows({ ...data, now, tz })
  const done = activityRows(data.activities, now, tz)
  const [open, setOpen] = useState<{ tracker: string } | { activity: string } | null>(null)

  useEffect(() => {
    if (params.tracker) setOpen({ tracker: params.tracker })
    else if (params.activity) setOpen({ activity: params.activity })
    else return
    router.setParams({ tracker: undefined, activity: undefined })
  }, [params.tracker, params.activity])

  return (
    <>
      <ScrollView contentContainerStyle={journalStyles.screenBody}>
        {rows.length === 0 && done.length === 0 ? <EmptyNote>No trackers yet.</EmptyNote> : null}
        {rows.length > 0 ? (
          <Group>
            {rows.map((r, i) => (
              <Fragment key={r.id}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${r.name}, ${r.summary}`}
                  accessibilityHint="Shows its history"
                  onPress={() => setOpen({ tracker: r.id })}
                  style={({ pressed }) => [
                    journalStyles.row,
                    { minHeight: 64, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <View style={journalStyles.rowText}>
                    <Label>{r.name}</Label>
                    <Label tone={r.hasReadings ? 'secondary' : 'muted'} size={type.label}>
                      {r.summary}
                    </Label>
                  </View>
                  <Sparkline spark={r.spark} label={r.sparkLabel} />
                </Pressable>
              </Fragment>
            ))}
          </Group>
        ) : null}
        {done.length > 0 ? (
          <>
            <SectionTitle>Things you did</SectionTitle>
            <Group>
              {done.map((r, i) => (
                <Fragment key={r.key}>
                  {i > 0 ? <Divider /> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${r.name}, ${r.summary}`}
                    accessibilityHint="Shows its history"
                    onPress={() => setOpen({ activity: r.key })}
                    style={({ pressed }) => [
                      journalStyles.row,
                      { minHeight: 64, opacity: pressed ? 0.6 : 1 },
                    ]}
                  >
                    <View style={journalStyles.rowText}>
                      <Label>{r.name}</Label>
                      <Label tone="secondary" size={type.label}>
                        {r.summary}
                      </Label>
                    </View>
                    <Sparkline spark={r.spark} label={r.sparkLabel} />
                  </Pressable>
                </Fragment>
              ))}
            </Group>
          </>
        ) : null}
        <Label tone="muted" size={type.label} style={journalStyles.hint}>
          To log, just say it on the capture page, like “slept 7 hours” or “mood's a 4”. Tap a
          tracker to see its history and fix a reading.
        </Label>
      </ScrollView>
      {open && 'tracker' in open ? (
        <TrackerHistorySheet trackerId={open.tracker} onClose={() => setOpen(null)} />
      ) : null}
      {open && 'activity' in open ? (
        <ActivityHistorySheet name={open.activity} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}
