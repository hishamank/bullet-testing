/**
 * The recording player on Capture detail: the file on this phone first, else streamed from the
 * home server (`GET /sync/audio/:id`, with the device token). Where the audio comes from is
 * decided by `audioSource` (pure); this component only plays it.
 */

import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { File } from 'expo-file-system'
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { Label, RoundButton } from '@/components/ui'
import { type AudioRow, audioSource } from '@/features/journal/capture'
import { duration, spokenDuration } from '@/features/journal/format'
import { currentServerSettings } from '@/sync/runtime'
import { radius, space, type, useTheme } from '@/theme'

function fileExists(path: string): boolean {
  try {
    return new File(path).exists
  } catch {
    return false
  }
}

export function AudioPlayer({ audio }: { audio: AudioRow }) {
  const t = useTheme()
  const source = useMemo(
    () => audioSource(audio, { localExists: fileExists, server: currentServerSettings() }),
    [audio.id, audio.local_path, audio.upload_status],
  )
  if (source.kind === 'unavailable') {
    return (
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <Label tone="secondary" size={type.bodySmall} style={{ flex: 1 }}>
          {source.reason}
        </Label>
      </View>
    )
  }
  return (
    <Player
      uri={source.uri}
      headers={source.kind === 'remote' ? source.headers : undefined}
      durationMs={audio.duration_ms}
    />
  )
}

function Player({
  uri,
  headers,
  durationMs,
}: {
  uri: string
  headers?: Record<string, string>
  durationMs: number
}) {
  const t = useTheme()
  // A stable source object, so re-renders don't reload the recording.
  const src = useMemo(() => ({ uri, headers }), [uri, headers?.authorization])
  const player = useAudioPlayer(src, { updateInterval: 250 })
  const status = useAudioPlayerStatus(player)
  const total = status.duration > 0 ? status.duration * 1000 : durationMs
  const at = Math.min(total, status.currentTime * 1000)
  const progress = total > 0 ? at / total : 0

  const toggle = () => {
    if (status.playing) {
      player.pause()
      return
    }
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {})
    if (status.didJustFinish || (total > 0 && at >= total - 250)) void player.seekTo(0)
    player.play()
  }
  const seekBy = (seconds: number) => {
    const next = Math.max(0, Math.min(total / 1000, status.currentTime + seconds))
    void player.seekTo(next)
  }

  return (
    <View style={[styles.card, { backgroundColor: t.card }]}>
      <RoundButton
        icon={status.playing ? 'pause' : 'play'}
        label={status.playing ? 'Pause recording' : 'Play recording'}
        diameter={44}
        onPress={toggle}
      />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position in recording"
        accessibilityValue={{ text: `${spokenDuration(at)} of ${spokenDuration(total)}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => seekBy(e.nativeEvent.actionName === 'increment' ? 10 : -10)}
        style={styles.track}
      >
        <View style={[styles.rail, { backgroundColor: t.raisedStrong }]}>
          <View
            style={[styles.fill, { backgroundColor: t.accentText, width: `${progress * 100}%` }]}
          />
        </View>
      </View>
      <Label
        tone="secondary"
        size={type.label}
        style={{ fontVariant: ['tabular-nums'] }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {duration(at)} / {duration(total)}
      </Label>
      {status.error ? (
        <Label accessibilityRole="alert" tone="warning" size={type.caption} style={styles.error}>
          Couldn't play the recording. It's still kept.
        </Label>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    paddingVertical: space.md,
    paddingHorizontal: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.md,
  },
  track: { flex: 1, minWidth: 100, minHeight: 44, justifyContent: 'center' },
  rail: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4 },
  error: { width: '100%' },
})
