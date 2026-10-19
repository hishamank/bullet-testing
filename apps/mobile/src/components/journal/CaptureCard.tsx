/** A capture in the stream: source, time, state, and its thoughts with kind labels. */

import { Pressable, StyleSheet, View } from 'react-native'
import { Icon } from '@/components/Icon'
import { KindPill, Label, QuestionText, TextButton } from '@/components/ui'
import {
  AUDIO_READ_ERROR_TEXT,
  type CaptureCard as Card,
  cardAccessibilityLabel,
  cardState,
  type StateTone,
  sourceLine,
} from '@/features/journal/stream'
import { plural } from '@/features/journal/format'
import { thinkingAboutLabel } from '@/features/reflect/model'
import { kindStyle, radius, size, space, type, useTheme } from '@/theme'

export function CaptureCard({
  card,
  onOpen,
  onRetry,
  onWriteDown,
  onKeepAudio,
  onOpenSource,
}: {
  card: Card
  onOpen: () => void
  /** An answer's "Thinking about" header: open the capture the question is about. */
  onOpenSource: (bulletId: string) => void
  onRetry: () => void
  /** The recording can't be transcribed: type it instead (opens the capture's text edit). */
  onWriteDown: () => void
  /** The recording can't be transcribed: keep it as audio only (phone-local). */
  onKeepAudio: () => void
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
  const about = card.thinkingAbout
  const sourceId = about?.sourceBulletId ?? null
  const actions = [
    ...(state.retry ? [{ name: 'retry', label: 'Retry' }] : []),
    ...(state.untranscribable
      ? [
          { name: 'write', label: 'Write it down' },
          { name: 'keep', label: 'Keep as audio' },
        ]
      : []),
    ...(sourceId ? [{ name: 'source', label: 'Open the capture it is about' }] : []),
  ]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardAccessibilityLabel(card)}
      accessibilityHint="Opens the capture"
      accessibilityActions={actions.length > 0 ? actions : undefined}
      onAccessibilityAction={(e) => {
        const action = e.nativeEvent.actionName
        if (action === 'retry') onRetry()
        else if (action === 'write') onWriteDown()
        else if (action === 'keep') onKeepAudio()
        else if (action === 'source' && sourceId) onOpenSource(sourceId)
      }}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: t.card, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      {about ? (
        <ThinkingAboutHeader text={about.text} sourceId={sourceId} onOpen={onOpenSource} />
      ) : null}
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
      {state.untranscribable ? (
        <View style={{ gap: 2 }}>
          <Label tone="secondary" size={type.label}>
            {state.reason}
          </Label>
          <View style={styles.actions}>
            <TextButton title="Write it down" onPress={onWriteDown} />
            <TextButton title="Keep as audio" tone="secondary" onPress={onKeepAudio} />
          </View>
        </View>
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

/**
 * "Thinking about: «…»" on an answer's card. Tapping it opens the capture the question is about;
 * an evergreen question has none, so it is plain text.
 */
function ThinkingAboutHeader({
  text,
  sourceId,
  onOpen,
}: {
  text: string
  sourceId: string | null
  onOpen: (bulletId: string) => void
}) {
  const t = useTheme()
  const tint = kindStyle('question', t.scheme)
  const body = (
    <>
      <Label size={type.caption} style={{ color: tint.text }}>
        Thinking about
      </Label>
      <QuestionText size={type.bodySmall}>{text}</QuestionText>
    </>
  )
  if (!sourceId) {
    return (
      <View
        accessibilityLabel={thinkingAboutLabel(text)}
        style={[styles.about, { backgroundColor: tint.background }]}
      >
        {body}
      </View>
    )
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={thinkingAboutLabel(text)}
      accessibilityHint="Opens the capture it is about"
      onPress={() => onOpen(sourceId)}
      style={({ pressed }) => [
        styles.about,
        { backgroundColor: tint.background, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {body}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  about: {
    minHeight: size.touch,
    borderRadius: 12,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    gap: space.xs,
  },
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
})
