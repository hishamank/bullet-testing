/** One capture's waiting suggestions: its snippet, a row per suggestion, and "Accept both". */

import { Link } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import type { CaptureGroup, DecideItem } from '@/features/inbox/model'
import { space, type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, TextButton, touch } from '../ui'
import { card, DecideButton, InboxPill } from './parts'

export interface DecideHandlers {
  onAccept: (item: DecideItem) => void
  onDismiss: (item: DecideItem) => void
  onEdit: (item: DecideItem) => void
  onUndo: (item: DecideItem) => void
  onAcceptAll: (items: DecideItem[]) => void
}

/** Tiers shown as behaviour, never as numbers. */
function tierHint(item: DecideItem): string | null {
  if (item.isNewTracker) return null // the group's note says it
  return item.tier === 'ask' ? 'Not sure about this one: have a look.' : null
}

export function DecideGroup({ group, ...h }: { group: CaptureGroup } & DecideHandlers) {
  const t = useTheme()
  const voice = group.source === 'voice'
  const all = group.pending.length === 2 ? 'Accept both' : 'Accept all'
  return (
    <View style={card(t.card)}>
      {group.snippet ? (
        <Link href={{ pathname: '/capture/[id]', params: { id: group.bulletId } }} asChild>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${voice ? 'Voice capture' : 'Capture'} ${group.snippet}`}
            accessibilityHint={
              voice ? 'Opens the capture, where you can play it' : 'Opens the capture'
            }
            style={({ pressed }) => [styles.source, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name={voice ? 'play' : 'text'} color={t.textSecondary} size={14} />
            <Label tone="secondary" size={type.label} style={{ flex: 1 }} numberOfLines={3}>
              {group.snippet}
            </Label>
          </Pressable>
        </Link>
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

function SuggestionRow({
  item,
  onAccept,
  onDismiss,
  onEdit,
  onUndo,
}: { item: DecideItem } & DecideHandlers) {
  const { summary } = item
  const hint = tierHint(item)

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
      <Label size={type.bodySmall}>{summary.text}</Label>
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
  source: { ...touch, flexDirection: 'row', alignItems: 'center', gap: space.sm },
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
})
