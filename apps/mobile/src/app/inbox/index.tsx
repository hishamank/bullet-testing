import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { LoopAnswer, NoticedCard, NoticedEmpty } from '@/components/connections/InboxCards'
import { showThemeMenu, type ThemeSheet, ThemeSheets } from '@/components/connections/ThemeSheets'
import { DecideGroup } from '@/components/inbox/DecideGroup'
import { DoneList } from '@/components/inbox/DoneList'
import { SectionTitle } from '@/components/inbox/parts'
import { PickQuestionSheet } from '@/components/inbox/PickQuestionSheet'
import { QuestionCard } from '@/components/inbox/QuestionCard'
import { AnsweredList, ThinkCard, ThinkEmpty } from '@/components/inbox/ThinkCard'
import { BackHeader, Label, Note, Screen, TextButton } from '@/components/ui'
import {
  accept,
  acceptAll,
  answerWithOption,
  dismiss,
  dismissNotice,
  flushDecisions,
  skipQuestion,
  startTracking,
  UNDO_MESSAGES,
  undoApplied,
  undoDecision,
} from '@/features/inbox/actions'
import {
  answerSame,
  clearClosed,
  closeLoop,
  keepLoopOpen,
  mergeInto,
  notATheme,
  openCard,
  renameThemeTo,
} from '@/features/connections/actions'
import { COPY } from '@/features/connections/copy'
import { inboxIsEmpty } from '@/features/connections/model'
import { useInbox } from '@/features/inbox/useInbox'
import { laterQuestion, notThisOne, pickQuestion } from '@/features/reflect/actions'
import { useEvergreenChoices, useLoopAnswers, useNoticed, useThinkView } from '@/hooks'
import { space, type } from '@/theme'

/** How long a one-off message (e.g. "it stays dismissed") stays before fading out. */
const MESSAGE_MS = 6_000

/**
 * Inbox: To decide (grouped by capture), To clarify (clarifying questions, in the badge), To
 * think about (reflective questions, never in the badge), and Done for you today. Everything
 * here is optional and can wait; the screen only wires taps to `features/inbox/actions` and
 * `features/reflect/actions`.
 */
export default function Inbox() {
  const router = useRouter()
  const view = useInbox()
  const think = useThinkView()
  const evergreen = useEvergreenChoices()
  const [message, setMessage] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const loopAnswers = useLoopAnswers()
  const noticed = useNoticed()
  const [sheet, setSheet] = useState<ThemeSheet | null>(null)
  const empty = inboxIsEmpty(view.empty, loopAnswers.length, noticed.length)
  const journal = (questionId: string) =>
    router.push({ pathname: '/answer', params: { question: questionId } })
  const openCapture = (id: string) => router.push({ pathname: '/capture/[id]', params: { id } })
  const openTheme = (id: string) => router.push({ pathname: '/theme/[id]', params: { id } })

  // Leaving the Inbox sends whatever is still in its Undo window.
  useEffect(() => flushDecisions, [])
  useEffect(() => {
    if (!message) return
    const id = setTimeout(() => setMessage(null), MESSAGE_MS)
    return () => clearTimeout(id)
  }, [message])

  const onUndo = useCallback((id: string) => {
    const outcome = undoDecision(id)
    if (outcome === 'already_sent') setMessage(UNDO_MESSAGES.already_sent)
  }, [])

  return (
    <Screen>
      <BackHeader title="Inbox" backLabel="Capture" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body}>
        {view.notices.map((n) => (
          <Note key={n.key} icon="info" text={n.text} onDismiss={() => dismissNotice(n.key)} />
        ))}
        {message ? <Note icon="info" text={message} onDismiss={() => setMessage(null)} /> : null}

        {empty ? <EmptyState onPick={() => setPicking(true)} /> : null}

        {view.groups.length > 0 || loopAnswers.length > 0 ? (
          <>
            <SectionTitle
              title="To decide"
              count={
                view.pendingCount + loopAnswers.length > 0
                  ? view.pendingCount + loopAnswers.length
                  : undefined
              }
            />
            {loopAnswers.map((a) => (
              <LoopAnswer
                key={a.suggestionId}
                item={a}
                onOpenCapture={openCapture}
                onClose={() => closeLoop(a.suggestionId)}
                onKeepOpen={() => keepLoopOpen(a.suggestionId)}
                onClear={() => clearClosed(a.suggestionId)}
              />
            ))}
            {view.groups.map((g) => (
              <DecideGroup
                key={g.bulletId}
                group={g}
                onAccept={(i) => accept(i.id, i.summary.spoken)}
                onDismiss={(i) => dismiss(i.id, i.summary.spoken)}
                onEdit={(i) =>
                  router.push({ pathname: '/inbox/edit', params: { suggestion: i.id } })
                }
                onUndo={(i) => onUndo(i.id)}
                onAcceptAll={(items) => acceptAll(items.map((i) => i.id))}
                onStartTracking={(i, name) => startTracking(i.id, name)}
              />
            ))}
          </>
        ) : null}

        {view.questions.length > 0 ? (
          <>
            <SectionTitle title="To clarify" count={view.questions.length} />
            {view.questions.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                onAnswer={(option) => answerWithOption(q.id, option)}
                onSkip={() => skipQuestion(q.id)}
              />
            ))}
          </>
        ) : null}

        {/* Nothing at all waiting: the one empty state above offers Pick a question. */}
        {empty ? null : (
          <>
            <SectionTitle
              title="To think about"
              count={think.toThink.length > 0 ? think.toThink.length : undefined}
            />
            {think.toThink.length > 0 ? (
              think.toThink.map((q) => (
                <ThinkCard
                  key={q.id}
                  question={q}
                  onJournal={() => journal(q.id)}
                  onLater={() => laterQuestion(q.id)}
                  onNotThisOne={() => notThisOne(q.id)}
                  onSame={(same) => answerSame(q.id, same)}
                />
              ))
            ) : (
              <ThinkEmpty onPick={() => setPicking(true)} />
            )}
          </>
        )}
        <AnsweredList items={think.answered} onAddMore={(q) => journal(q.id)} />

        {/* Noticed: below Questions; never in the badge, never notified. */}
        {empty ? null : (
          <>
            <SectionTitle title={COPY.noticedTitle} />
            {noticed.length > 0 ? (
              noticed.map((c) => (
                <NoticedCard
                  key={c.id}
                  card={c}
                  onOpenCapture={openCapture}
                  onOpen={() => {
                    openCard(c.id)
                    openTheme(c.theme.id)
                  }}
                  onNotATheme={() => notATheme(c.theme.id)}
                  onRename={() =>
                    setSheet({ mode: 'rename', themeId: c.theme.id, name: c.theme.name })
                  }
                  onMore={() =>
                    showThemeMenu((mode) =>
                      setSheet({ mode, themeId: c.theme.id, name: c.theme.name }),
                    )
                  }
                />
              ))
            ) : (
              <NoticedEmpty />
            )}
          </>
        )}

        {view.done.length > 0 ? (
          <>
            <SectionTitle title="Done for you today" count={view.done.length} />
            <DoneList
              items={view.done}
              onUndo={(d) => undoApplied(d.suggestionId, d.summary.done)}
            />
          </>
        ) : null}
      </ScrollView>
      <PickQuestionSheet
        visible={picking}
        choices={evergreen.choices}
        canPick={evergreen.canPick}
        onClose={() => setPicking(false)}
        onPick={(q) => {
          const id = pickQuestion(q.id)
          setPicking(false)
          if (id) journal(id)
        }}
      />
      <ThemeSheets
        sheet={sheet}
        onClose={() => setSheet(null)}
        onRename={(id, name) => {
          renameThemeTo(id, name)
          setSheet(null)
        }}
        onMerge={(id, into) => {
          mergeInto(id, into)
          setSheet(null)
        }}
      />
    </Screen>
  )
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <View style={styles.empty}>
      <View accessible accessibilityRole="text" style={{ gap: space.sm }}>
        <Label size={type.title} style={{ fontWeight: '600' }}>
          Nothing waiting.
        </Label>
        <Label tone="secondary">Captures you make will show up here when they need you.</Label>
      </View>
      <View style={{ alignItems: 'flex-start' }}>
        <TextButton
          title="Pick a question"
          accessibilityHint="Choose a question to write or talk about"
          onPress={onPick}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
  empty: { paddingVertical: space.xxl, gap: space.sm },
})
