/** One capture's waiting suggestions: its snippet, a row per suggestion, and "Accept both". */

import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import {
  logsLine,
  type CaptureGroup,
  type DecideItem,
  trackerNameOrNull,
} from '@/features/inbox/model'
import { radius, space, type, useTheme } from '@/theme'
import { Label, TextButton, touch } from '../ui'
import { CaptureLink, card, DecideButton, InboxPill } from './parts'

export interface DecideHandlers {
  onAccept: (item: DecideItem) => void
  onDismiss: (item: DecideItem) => void
  onEdit: (item: DecideItem) => void
  onUndo: (item: DecideItem) => void
  onAcceptAll: (items: DecideItem[]) => void
  /** "Start tracking" a new tracker, with the name as the user left it. */
  onStartTracking: (item: DecideItem, name: string) => void
}

/** Tiers shown as behaviour, never as numbers. */
function tierHint(item: DecideItem): string | null {
  if (item.isNewTracker) return null // the group's note says it
  return item.tier === 'ask' ? 'Not sure about this one: have a look.' : null
}

export function DecideGroup({ group, ...h }: { group: CaptureGroup } & DecideHandlers) {
  const t = useTheme()
  const all = group.pending.length === 2 ? 'Accept both' : 'Accept all'
  return (
    <View style={card(t.card)}>
      {group.snippet ? (
        <CaptureLink bulletId={group.bulletId} snippet={group.snippet} source={group.source} />
      ) : null}

      {group.items.map((item) => (
        <SuggestionRow key={item.id} item={item} {...h} />
      ))}

      {group.pending.length >= 2 ? (
        <View style={styles.allRow}>
          <TextButton
            title={all}
            accessibilityLabel={`${all}: ${group.pending.map((i) => i.summary.spoken).join('; ')}`}
            onPress={() => h.onAcceptAll(group.pending)}
          />
        </View>
      ) : null}

      {group.hasNewTracker ? (
        <Label tone="muted" size={type.caption}>
          New trackers always wait for your OK.
        </Label>
      ) : null}
    </View>
  )
}

/**
 * A new tracker: "Start tracking Mood?" with its name pre-filled and editable, and the reading it
 * logs. "Start tracking" accepts it (with the edited name); "Not now" dismisses it.
 */
function NewTrackerRow({
  item,
  onDismiss,
  onStartTracking,
}: { item: DecideItem } & DecideHandlers) {
  const t = useTheme()
  const [name, setName] = useState(item.trackerName ?? '')
  const clean = trackerNameOrNull(name)
  const shown = clean ?? item.trackerName ?? item.summary.name
  const logs = logsLine(item.logs)
  return (
    <View style={styles.tracker}>
      <View style={styles.pillLine}>
        <InboxPill kind={item.summary.pill.kind} label={item.summary.pill.label} />
      </View>
      <Label size={type.bodySmall} style={{ fontWeight: '600' }}>
        Start tracking {shown}?
      </Label>
      <TextInput
        value={name}
        onChangeText={setName}
        accessibilityLabel="Tracker name"
        returnKeyType="done"
        autoCapitalize="words"
        style={[styles.input, { backgroundColor: t.raised, color: t.text }]}
        placeholder={item.trackerName ?? 'Name'}
        placeholderTextColor={t.textMuted}
      />
      {logs ? (
        <Label tone="muted" size={type.caption}>
          {logs}
        </Label>
      ) : null}
      <View style={styles.trackerButtons}>
        <TextButton
          title="Not now"
          tone="secondary"
          accessibilityLabel={`Not now: don't track ${shown}`}
          accessibilityHint={item.logs.length > 0 ? 'Keeps the reading as an activity' : undefined}
          onPress={() => onDismiss(item)}
        />
        <TextButton
          title="Start tracking"
          accessibilityLabel={`Start tracking ${shown}`}
          disabled={clean === null}
          onPress={() => clean && onStartTracking(item, clean)}
        />
      </View>
    </View>
  )
}

function SuggestionRow(props: { item: DecideItem } & DecideHandlers) {
  const { item, onAccept, onDismiss, onEdit, onUndo } = props
  const { summary } = item
  const hint = tierHint(item)

  if (item.isNewTracker && !item.decision) return <NewTrackerRow {...props} />

  if (item.decision) {
    const word = item.decision === 'accepted' ? 'Added' : 'Dismissed'
    return (
      <View style={styles.row} accessibilityLiveRegion="polite">
        <View style={styles.text}>
          <InboxPill kind={summary.pill.kind} label={summary.pill.label} />
          <Label tone="muted" size={type.bodySmall}>
            {summary.text}
          </Label>
        </View>
        <View style={styles.buttons}>
          <Label tone="muted" size={type.label}>
            {word}
          </Label>
          <TextButton
            title="Undo"
            accessibilityLabel={`Undo ${item.decision === 'accepted' ? 'adding' : 'dismissing'} ${summary.spoken}`}
            onPress={() => onUndo(item)}
          />
        </View>
      </View>
    )
  }

  const body = (
    <>
      <View style={styles.pillLine}>
        <InboxPill kind={summary.pill.kind} label={summary.pill.label} />
        {item.editable ? (
          <Label tone="accent" size={type.caption}>
            Edit
          </Label>
        ) : null}
      </View>
      <Label size={type.bodySmall}>{summary.ask}</Label>
      {hint ? (
        <Label tone="muted" size={type.caption}>
          {hint}
        </Label>
      ) : null}
    </>
  )
  return (
    <View style={styles.row}>
      {item.editable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={summary.spoken}
          accessibilityHint="Double-tap to edit before adding"
          onPress={() => onEdit(item)}
          style={({ pressed }) => [styles.text, { opacity: pressed ? 0.6 : 1 }]}
        >
          {body}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={summary.spoken} style={styles.text}>
          {body}
        </View>
      )}
      <View style={styles.buttons}>
        <DecideButton
          variant="dismiss"
          label={`Dismiss ${summary.spoken}`}
          onPress={() => onDismiss(item)}
        />
        <DecideButton
          variant="accept"
          label={`Accept ${summary.spoken}`}
          onPress={() => onAccept(item)}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
    minHeight: touch.minHeight,
  },
  text: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 160,
    gap: space.xs,
    minHeight: touch.minHeight,
    justifyContent: 'center',
  },
  pillLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  allRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  tracker: { gap: space.sm },
  trackerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.lg },
  input: {
    minHeight: 44,
    borderRadius: radius.note,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: type.body,
  },
})
