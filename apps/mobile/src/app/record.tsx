import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { ActivityIndicator, Alert, View } from 'react-native'
import { MicPermission } from '@/components/voice/MicPermission'
import { RecordingView } from '@/components/voice/RecordingView'
import { Screen } from '@/components/ui'
import { returnToCapture } from '@/features/voice/actions'
import { draftHint, formatTimer } from '@/features/voice/format'
import { canResume, elapsedMs } from '@/features/voice/session'
import { useVoiceRecorder } from '@/features/voice/useVoiceRecorder'
import { useTheme } from '@/theme'

/**
 * Capture · recording (a full-screen modal over Capture or Answer). `?question=` / `?thought=`
 * make the voice note an answer to that question, or a note that closes that open loop.
 */
export default function RecordScreen() {
  const t = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<{ question?: string; thought?: string }>()
  const context = params.question ?? params.thought ?? null
  const v = useVoiceRecorder({
    ...(params.question ? { answersQuestionId: params.question } : {}),
    ...(params.thought ? { resolvesThoughtId: params.thought } : {}),
  })
  const { send, cancel } = v

  const close = useCallback(
    (how: 'saved' | 'type' | null) => {
      if (how) returnToCapture(how, context)
      router.back()
    },
    [router, context],
  )

  const onSend = useCallback(async () => {
    close((await send()) ? 'saved' : null)
  }, [send, close])

  const onCancel = useCallback(() => {
    const discard = () => {
      cancel()
      close(null)
    }
    if (!v.needsCancelConfirm) return discard()
    Alert.alert(
      'Delete this recording?',
      `The ${formatTimer(elapsedMs(v.state, Date.now()))} you recorded will be deleted.`,
      [
        { text: 'Keep recording', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: discard },
      ],
    )
  }, [cancel, close, v.needsCancelConfirm, v.state])

  if (v.screen.kind === 'checking') {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color={t.textMuted} />
        </View>
      </Screen>
    )
  }
  if (v.screen.kind === 'ask' || v.screen.kind === 'blocked') {
    return (
      <Screen>
        <MicPermission
          blocked={v.screen.kind === 'blocked'}
          onAllow={() => void v.allow()}
          onTypeInstead={() => close('type')}
        />
      </Screen>
    )
  }

  const { access } = v.screen
  const s = v.state
  return (
    <Screen>
      <RecordingView
        elapsedMs={elapsedMs(s, v.now)}
        phase={s.phase}
        pauseReason={s.pauseReason}
        liveDraft={s.liveDraft}
        paragraphs={s.paragraphs}
        partial={s.partial}
        hint={draftHint(s.liveDraft, access.kind === 'record_only' ? access.why : null)}
        notice={
          s.draftUnavailable
            ? "The live draft isn't available right now. Your recording is still kept."
            : null
        }
        canResume={canResume(s, v.now, v.maxMs)}
        saving={v.saving}
        onPause={v.pause}
        onResume={v.resume}
        onSend={() => void onSend()}
        onCancel={onCancel}
      />
    </Screen>
  )
}
