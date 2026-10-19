import { useRouter } from 'expo-router'
import { Composer } from '@/components/capture/Composer'
import { Corners } from '@/components/capture/Corners'
import { ServerNotes, StatusLine } from '@/components/capture/StatusLine'
import { Screen } from '@/components/ui'
import { retryCaptures, sendCapture } from '@/features/capture/actions'
import { useCaptureCounts, useInboxCount } from '@/hooks'

/** Capture (home): a blank page. Type or speak, tap Send, move on. */
export default function CaptureScreen() {
  const router = useRouter()
  const counts = useCaptureCounts()
  const inbox = useInboxCount()
  return (
    <Screen>
      <Composer
        header={
          <Corners
            failedCount={counts.failedIds.length + counts.untranscribableIds.length}
            inboxCount={inbox}
          />
        }
        pinned={<ServerNotes />}
        placeholder="What's on your mind?"
        inputLabel="New capture"
        micLabel="Start recording"
        statusLine={<StatusLine counts={counts} onRetry={() => retryCaptures(counts.failedIds)} />}
        onMic={() => router.push('/record')}
        onSend={(text) => sendCapture(text)}
      />
    </Screen>
  )
}
