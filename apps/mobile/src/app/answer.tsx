import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Composer } from '@/components/capture/Composer'
import { BackHeader, IconButton, Label, Placeholder, QuestionText, Screen } from '@/components/ui'
import { sendCapture } from '@/features/capture/actions'
import { findPinned, fromLabel, questionSourceLine } from '@bullet/client'
import { sendLoopNote } from '@/features/journal/actions'
import { useLocalQuery } from '@/hooks'
import { kindStyle, radius, space, type, useTheme } from '@/theme'

/**
 * Answer: the capture page with a question (`?question=`: a clarifying one, or a reflective one
 * from "Journal about it" / "Add more") or an open loop (`?thought=`) pinned on top. The answer
 * is saved as a capture (typed, or spoken via `/record` with the same link); a loop's note also
 * closes the loop. A reflective question may be answered again and again.
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
  const heading = pinned.reflective
    ? 'Thinking about'
    : pinned.kind === 'question'
      ? 'Answering'
      : 'Closing with a note'
  const from = pinned.reflective
    ? questionSourceLine(pinned.origin ?? 'evergreen', pinned.source, Date.now())
    : pinned.source
      ? fromLabel(pinned.source, Date.now())
      : null
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
                {heading}
              </Label>
              {pinned.reflective ? (
                <QuestionText size={type.body}>{pinned.text}</QuestionText>
              ) : (
                <Label size={type.body}>{pinned.text}</Label>
              )}
              {from ? (
                <Label tone="secondary" size={type.label}>
                  {from}
                </Label>
              ) : null}
            </View>
            <IconButton
              icon="close"
              label={pinned.reflective ? 'Stop journaling about it' : 'Stop answering'}
              iconSize={20}
              onPress={close}
            />
          </View>
        }
        placeholder={pinned.reflective ? 'Start anywhere…' : 'Your answer…'}
        inputLabel="Your answer"
        micLabel="Answer by voice"
        statusLine={
          <Label tone="muted" size={type.label}>
            Your answer is saved as a capture too.
          </Label>
        }
        onMic={() =>
          // A voice answer links like a typed one: it answers the question or closes the loop
          // (app/record.tsx passes answersQuestionId / resolvesThoughtId).
          router.push({
            pathname: '/record',
            params: pinned.kind === 'question' ? { question: pinned.id } : { thought: pinned.id },
          })
        }
        voiceContext={pinned.id}
        onSend={(text) => {
          // A loop's note is a capture that resolves the thought (`resolves_thought_id`).
          if (pinned.kind === 'loop') sendLoopNote(text, pinned.id)
          else sendCapture(text, { answersQuestionId: pinned.id })
        }}
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
