/** A capture in the stream: source, time, state, and its thoughts with kind labels. */

import { Pressable, StyleSheet, View } from 'react-native'
import { Icon } from '@/components/Icon'
import { KindPill, Label, TextButton } from '@/components/ui'
import {
  AUDIO_READ_ERROR_TEXT,
  type CaptureCard as Card,
  cardAccessibilityLabel,
  cardState,
  type StateTone,
  sourceLine,
} from '@/features/journal/stream'
import { plural } from '@/features/journal/format'
import { radius, space, type, useTheme } from '@/theme'

export function CaptureCard({
  card,
  onOpen,
  onRetry,
}: {
  card: Card
  onOpen: () => void
  onRetry: () => void
}) {
  const t = useTheme()
  const state = cardState(card)
  const toneColor: Record<StateTone, string> = {
    muted: t.textMuted,
    secondary: t.textSecondary,
    warning: t.warning,
    accent: t.accentText,
  }
  const color = toneColor[state.tone]
  const showThoughts = card.thoughts.length > 0
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardAccessibilityLabel(card)}
      accessibilityHint="Opens the capture"
      accessibilityActions={state.retry ? [{ name: 'retry', label: 'Retry' }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'retry') onRetry()
      }}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: t.card, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={styles.top}>
        <View style={styles.source}>
          {card.source === 'voice' ? <Icon name="play" color={t.textSecondary} size={14} /> : null}
          <Label tone="secondary" size={type.label}>
            {sourceLine(card)}
          </Label>
        </View>
        <View style={styles.state}>
          {state.onPhone ? <Icon name="offline" color={color} size={14} /> : null}
          {state.tone === 'warning' ? (
            <View style={[styles.dot, { backgroundColor: t.warning }]} />
          ) : null}
          <Label size={type.label} style={{ color }}>
            {state.label === 'Done' && showThoughts
              ? plural(card.thoughts.length, 'thought')
              : state.label}
          </Label>
        </View>
      </View>
      {showThoughts ? (
        card.thoughts.map((th) => (
          <View key={th.id} style={styles.thought}>
            <KindPill kind={th.kind} />
            <Label size={type.bodySmall} style={styles.thoughtText}>
              {th.text}
            </Label>
          </View>
        ))
      ) : (
        <Label numberOfLines={4}>{card.text}</Label>
      )}
      {card.audioReadError ? (
        <Label tone="secondary" size={type.label}>
          {AUDIO_READ_ERROR_TEXT}
        </Label>
      ) : null}
      {state.retry ? (
        <View style={styles.failed}>
          <Label tone="secondary" size={type.label} style={{ flex: 1 }}>
            {state.reason}
          </Label>
          <TextButton title="Retry" onPress={onRetry} accessibilityLabel="Retry this capture" />
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: 14, gap: 10 },
  top: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  source: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  thought: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'baseline' },
  thoughtText: { flexShrink: 1, flexGrow: 1, flexBasis: 160 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
})
