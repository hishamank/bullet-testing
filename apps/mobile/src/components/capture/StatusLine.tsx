import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import type { CaptureCounts } from '@/features/capture/counts'
import {
  captureNotice,
  failedText,
  onPhoneText,
  UNAUTHORIZED_TEXT,
  unpairedText,
  untranscribableText,
  UNREACHABLE_TEXT,
} from '@/features/capture/notice'
import { usePairing, useSyncStatus } from '@/hooks'
import { type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, Note, TextButton, touch } from '../ui'

/** The quiet line under the mic: failed captures (with Retry), or captures waiting on the phone. */
export function StatusLine({ counts, onRetry }: { counts: CaptureCounts; onRetry: () => void }) {
  const t = useTheme()
  const router = useRouter()
  const sync = useSyncStatus()
  const pairing = usePairing()
  const notice = captureNotice({
    saved: false,
    failedCount: counts.failedIds.length,
    onPhoneCount: counts.onPhone,
    cannotReachServer: sync.cannotReachServer,
    unpaired: pairing !== 'paired',
    untranscribableIds: counts.untranscribableIds,
  })
  switch (notice.kind) {
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
