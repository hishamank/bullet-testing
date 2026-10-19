import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import type { CaptureCounts } from '@/features/capture/counts'
import {
  captureNotice,
  failedText,
  foundText,
  onPhoneText,
  SORTING_TEXT,
  STILL_SORTING_TEXT,
  UNAUTHORIZED_TEXT,
  unpairedText,
  untranscribableText,
  UNREACHABLE_TEXT,
} from '@/features/capture/notice'
import { useNow, usePairing, useSyncStatus } from '@/hooks'
import { type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, Note, TextButton, touch } from '../ui'

/** The quiet line under the mic: failed captures (with Retry), or captures waiting on the phone. */
export function StatusLine({ counts, onRetry }: { counts: CaptureCounts; onRetry: () => void }) {
  const t = useTheme()
  const router = useRouter()
  const sync = useSyncStatus()
  const pairing = usePairing()
  // A static line that changes on its own only once ("Still sorting" after 5 minutes).
  const now = useNow(30_000)
  const notice = captureNotice({
    saved: false,
    failedCount: counts.failedIds.length,
    onPhoneCount: counts.onPhone,
    cannotReachServer: sync.cannotReachServer,
    unpaired: pairing !== 'paired',
    untranscribableIds: counts.untranscribableIds,
    latest: counts.latest,
    now,
  })
  switch (notice.kind) {
    case 'sorting': {
      const text = notice.slow ? STILL_SORTING_TEXT : SORTING_TEXT
      return (
        <View style={styles.row} accessible accessibilityRole="text" accessibilityLabel={text}>
          <Label tone="muted" size={type.label} style={{ textAlign: 'center' }}>
            {text}
          </Label>
        </View>
      )
    }
    case 'found': {
      const text = foundText(notice.count)
      return (
        <Pressable
          style={({ pressed }) => [styles.row, touch, { opacity: pressed ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={text}
          accessibilityHint="Opens the capture"
          onPress={() =>
            router.push({ pathname: '/capture/[id]', params: { id: notice.bulletId } })
          }
        >
          <Label tone="secondary" size={type.label}>
            {text}
          </Label>
        </Pressable>
      )
    }
    case 'unpaired':
      return (
        <Pressable
          style={({ pressed }) => [styles.row, touch, { opacity: pressed ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={unpairedText(notice.count)}
          accessibilityHint="Opens home server pairing"
          onPress={() => router.push('/setup')}
        >
          <Label tone="secondary" size={type.label} style={{ textAlign: 'center' }}>
            {unpairedText(notice.count)}
          </Label>
        </Pressable>
      )
    case 'failed':
      return (
        <View style={styles.row}>
          <Label tone="secondary" size={type.label}>
            {failedText(notice.count)} ·
          </Label>
          <TextButton
            title="Retry"
            accessibilityLabel={`Retry ${notice.count === 1 ? 'the capture' : `${notice.count} captures`}`}
            onPress={onRetry}
          />
        </View>
      )
    case 'untranscribable': {
      const one = notice.bulletId
      return (
        <Pressable
          style={({ pressed }) => [styles.row, touch, { opacity: pressed ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={untranscribableText(notice.count)}
          accessibilityHint={one ? 'Opens the capture' : 'Opens the journal'}
          onPress={() =>
            one
              ? router.push({ pathname: '/capture/[id]', params: { id: one } })
              : router.push('/journal')
          }
        >
          <Label tone="secondary" size={type.label}>
            {untranscribableText(notice.count)}
          </Label>
        </Pressable>
      )
    }
    case 'on_phone':
      return (
        <Pressable
          style={[styles.row, touch]}
          accessibilityRole="button"
          accessibilityLabel={onPhoneText(notice.count)}
          accessibilityHint="Opens the journal"
          onPress={() => router.push('/journal')}
        >
          <Icon name="offline" color={t.textSecondary} size={16} />
          <Label tone="secondary" size={type.label}>
            {onPhoneText(notice.count)}
          </Label>
        </Pressable>
      )
    default:
      return null
  }
}

/** One-time notes about the home server: unreachable (once per outage) or token refused. */
export function ServerNotes() {
  const router = useRouter()
  const sync = useSyncStatus()
  if (sync.reachability === 'unauthorized') {
    return (
      <Note
        icon="offline"
        text={UNAUTHORIZED_TEXT}
        action={
          <TextButton title="Set up the server again" onPress={() => router.push('/server')} />
        }
      />
    )
  }
  if (sync.showUnreachableNote) {
    return <Note icon="offline" text={UNREACHABLE_TEXT} onDismiss={sync.dismissUnreachableNote} />
  }
  return null
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
})
