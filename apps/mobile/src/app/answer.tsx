import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Composer } from '@/components/capture/Composer'
import { BackHeader, IconButton, Label, Placeholder, Screen } from '@/components/ui'
import { sendCapture } from '@/features/capture/actions'
import { findPinned, fromLabel } from '@/features/capture/pinned'
import { useLocalQuery } from '@/hooks'
import { kindStyle, radius, space, type, useTheme } from '@/theme'

/**
 * Answer: the capture page with a clarifying question (`?question=`) or an open loop
 * (`?thought=`) pinned on top. The answer is saved as a capture.
 */
export default function AnswerScreen() {
  const t = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<{ question?: string; thought?: string }>()
  const target = { question: params.question, thought: params.thought }
  const live = useLocalQuery((db) => findPinned(db, target), `${target.question}|${target.thought}`)
  // Answering closes the question; keep showing it while "Saved" plays out.
  const [opened] = useState(live)
  const pinned = live ?? opened
  const close = useCallback(() => router.back(), [router])

  if (!pinned) {
    return (
      <Screen>
        <BackHeader backLabel="Back" onBack={close} />
        <View style={{ padding: space.xl }}>
          <Placeholder title="This was already answered or closed." />
        </View>
      </Screen>
    )
  }
  const tint = kindStyle(pinned.kind === 'question' ? 'question' : 'to_check', t.scheme)
  return (
    <Screen>
      <Composer
        header={
          <BackHeader backLabel={pinned.kind === 'question' ? 'Inbox' : 'Journal'} onBack={close} />
        }
        pinned={
          <View style={[styles.card, { backgroundColor: tint.background }]}>
            <View style={styles.cardText}>
              <Label size={type.caption} style={{ color: tint.text }}>
                {pinned.kind === 'question' ? 'Answering' : 'Closing with a note'}
              </Label>
              <Label size={type.body}>{pinned.text}</Label>
              {pinned.source ? (
                <Label tone="secondary" size={type.label}>
                  {fromLabel(pinned.source, Date.now())}
                </Label>
              ) : null}
            </View>
            <IconButton icon="close" label="Stop answering" iconSize={20} onPress={close} />
          </View>
        }
        placeholder="Your answer…"
        inputLabel="Your answer"
        micLabel="Answer by voice"
        statusLine={
          <Label tone="muted" size={type.label}>
            Your answer is saved as a capture too.
          </Label>
        }
        onMic={() =>
          // A voice answer links like a typed one (or closes the loop), see app/record.tsx.
          router.push({
            pathname: '/record',
            params: pinned.kind === 'question' ? { question: pinned.id } : { thought: pinned.id },
          })
        }
        voiceContext={pinned.id}
        onSend={(text) =>
          // An open loop's note is saved as a plain capture until the data layer can link it
          // (`resolves_thought_id`, being added alongside `thought.resolve`).
          sendCapture(text, pinned.kind === 'question' ? { answersQuestionId: pinned.id } : {})
        }
        onSavedShown={close}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    padding: 14,
    paddingRight: 4,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  cardText: { flex: 1, gap: 6 },
})
