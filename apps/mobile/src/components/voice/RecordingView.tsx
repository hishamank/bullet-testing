/**
 * Capture · recording (Recording artboard): timer and Cancel on top, the scrolling live draft
 * (older stretches fade), the draft label, then Pause/Resume and Send (stop and save in one tap).
 * Layout only: state and decisions come from features/voice.
 */

import { useRef } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { formatTimer, pauseNote, spokenDuration } from '@/features/voice/format'
import { useReduceMotion } from '@/hooks'
import { size, space, type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, PrimaryButton, RoundButton, TextButton } from '../ui'

export interface RecordingViewProps {
  elapsedMs: number
  phase: 'starting' | 'recording' | 'paused' | 'finishing' | 'done' | 'cancelled'
  pauseReason: 'user' | 'interrupted' | 'background' | 'limit' | 'error' | null
  liveDraft: boolean
  /** Finished stretches' draft, one paragraph each, then the current one. */
  paragraphs: string[]
  partial: string
  hint: string
  /** Shown when the live draft could not start this time. */
  notice: string | null
  canResume: boolean
  saving: boolean
  onPause: () => void
  onResume: () => void
  onSend: () => void
  onCancel: () => void
}

const DRAFT_SIZE = 20

export function RecordingView(p: RecordingViewProps) {
  const t = useTheme()
  const reduceMotion = useReduceMotion()
  const scroll = useRef<ScrollView>(null)
  const paused = p.phase === 'paused'
  const busy = p.saving || p.phase === 'finishing'
  const timer = formatTimer(p.elapsedMs)
  const note = paused ? pauseNote(p.pauseReason) : null
  // Paused by something else than the Pause button: the paused panel replaces the controls.
  // It never resumes by itself.
  const held = paused && note !== null
  const atLimit = p.pauseReason === 'limit'
  const lines = [...p.paragraphs, p.partial].filter((l) => l.trim() !== '')
  // The newest words are brightest; older ones step back.
  const shade = (fromEnd: number) =>
    fromEnd === 0 ? t.text : fromEnd === 1 ? t.textSecondary : t.textMuted

  return (
    <View style={styles.fill}>
      <View style={styles.top}>
        <View
          accessible
          accessibilityRole="timer"
          accessibilityLabel={`${paused ? 'Paused' : 'Recording'}, ${spokenDuration(p.elapsedMs)}`}
          style={styles.timer}
        >
          <View style={[styles.dot, { backgroundColor: paused ? t.textMuted : t.destructive }]} />
          <Label size={type.body} style={styles.tabular}>
            {timer}
          </Label>
          {paused ? (
            <Label tone="secondary" size={type.body}>
              Paused
            </Label>
          ) : null}
        </View>
        <TextButton
          title="Cancel"
          tone="secondary"
          accessibilityLabel="Cancel recording"
          disabled={busy}
          onPress={p.onCancel}
        />
      </View>

      <ScrollView
        ref={scroll}
        style={styles.fill}
        contentContainerStyle={styles.draft}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: !reduceMotion })}
        accessibilityLabel="Live draft"
      >
        {lines.length === 0 ? (
          <Label tone="muted" size={DRAFT_SIZE} style={styles.draftText}>
            {p.liveDraft ? (paused ? '' : 'Listening…') : 'Recording…'}
          </Label>
        ) : (
          lines.map((line, i) => (
            <Label
              // Stretches only ever append, so the index is stable.
              key={i}
              size={DRAFT_SIZE}
              style={[styles.draftText, { color: shade(lines.length - 1 - i) }]}
            >
              {line}
            </Label>
          ))
        )}
      </ScrollView>

      <View style={styles.notes}>
        {p.notice ? (
          <Label tone="secondary" size={type.label}>
            {p.notice}
          </Label>
        ) : null}
        <View style={styles.hint}>
          <Icon name="mic" color={t.textMuted} size={16} />
          <Label tone="muted" size={type.label} style={{ flex: 1 }}>
            {p.hint}
          </Label>
        </View>
      </View>

      {held ? (
        <View style={styles.panel}>
          <Label accessibilityRole="alert" size={type.body} style={styles.panelText}>
            {note}
          </Label>
          {atLimit ? (
            <PrimaryButton title="Send what you have" busy={busy} onPress={p.onSend} />
          ) : (
            <>
              <PrimaryButton
                title="Resume"
                disabled={!p.canResume}
                busy={busy}
                onPress={p.onResume}
              />
              <TextButton
                title="Send what you have"
                tone="secondary"
                disabled={busy}
                onPress={p.onSend}
              />
            </>
          )}
        </View>
      ) : (
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={paused ? 'Resume recording' : 'Pause recording'}
            accessibilityState={{ disabled: busy || (paused && !p.canResume) }}
            disabled={busy || (paused && !p.canResume)}
            onPress={paused ? p.onResume : p.onPause}
            style={({ pressed }) => [
              styles.side,
              {
                borderColor: t.raisedStrong,
                opacity: busy || (paused && !p.canResume) ? 0.4 : pressed ? 0.6 : 1,
              },
            ]}
          >
            <Icon name={paused ? 'mic' : 'pause'} color={t.text} size={26} />
          </Pressable>
          <RoundButton
            icon="send"
            label="Stop and save"
            diameter={size.mic}
            disabled={busy}
            onPress={p.onSend}
          />
          <View style={styles.spacer} />
        </View>
      )}
    </View>
  )
}

const SIDE = 64

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: size.touch,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
  },
  timer: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tabular: { fontVariant: ['tabular-nums'] },
  draft: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
  },
  draftText: { lineHeight: DRAFT_SIZE * 1.45 },
  notes: { paddingHorizontal: space.xl, gap: space.sm, paddingBottom: space.xl },
  hint: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xxl,
    paddingBottom: 40,
  },
  side: {
    width: SIDE,
    height: SIDE,
    borderRadius: SIDE / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer: { width: SIDE, height: SIDE },
  panel: { paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.md },
  panelText: { textAlign: 'center', paddingBottom: space.sm },
})
