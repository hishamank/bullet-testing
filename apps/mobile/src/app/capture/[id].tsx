import type { ThoughtKind } from '@bullet/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { RelatedList } from '@/components/connections/RelatedList'
import { AudioPlayer } from '@/components/journal/AudioPlayer'
import { KindPicker } from '@/components/journal/KindPicker'
import { Divider, Group, SectionTitle } from '@/components/journal/parts'
import {
  BackHeader,
  Label,
  Note,
  Placeholder,
  QuestionText,
  Screen,
  TextButton,
} from '@/components/ui'
import { retryCaptures } from '@/features/capture/actions'
import { captureStatusLabel } from '@/features/capture/notice'
import { dismissNotice, undoApplied } from '@/features/inbox/actions'
import {
  deleteChoices,
  editableText,
  loadCaptureDetail,
  type TranscriptTab,
  transcriptView,
  writeDownStart,
} from '@/features/journal/capture'
import { changeKind, deleteCapture, editCapture, keepAsAudio } from '@/features/journal/actions'
import { AUDIO_READ_ERROR_TEXT, untranscribableCopy } from '@/features/journal/stream'
import { clock, whenLabel } from '@/features/journal/format'
import { thinkingAboutLabel } from '@/features/reflect/model'
import { type LinkedThing, THING_STATE_LABELS } from '@/features/journal/things'
import { notRelated } from '@/features/connections/actions'
import { useLocalQuery, useRelated } from '@/hooks'
import { deviceDeps } from '@/sync/runtime'
import { kindStyle, radius, size, space, type, useTheme } from '@/theme'

/**
 * Capture detail: the recording, the home transcript vs the phone draft, the thoughts (tap a
 * kind to change it) with the things they produced, Edit, and "Delete capture…". An answer to a
 * reflective question shows that question pinned above its text (linking up to the capture it is
 * about); a capture asked about lists the answers ("You thought about this · N").
 */
export default function CaptureDetailScreen() {
  const t = useTheme()
  const router = useRouter()
  // `write=1`: opened from a card's "Write it down", so start in the text editor.
  const { id, write } = useLocalSearchParams<{ id: string; write?: string }>()
  const tz = deviceDeps.timezone()
  const c = useLocalQuery((db) => loadCaptureDetail(db, id, Date.now(), tz), id)
  const related = useRelated(id)
  const [tab, setTab] = useState<TranscriptTab | null>(null)
  const [draft, setDraft] = useState<string | null>(() =>
    write === '1' && c ? writeDownStart(c) : null,
  )
  const [picking, setPicking] = useState<{ id: string; text: string; kind: ThoughtKind } | null>(
    null,
  )
  // Undos tapped but not yet reflected (guards a double tap). An id leaves once its thing stops
  // being undoable; if the server refuses and it comes back, Undo is offered again.
  const [undoing, setUndoing] = useState<readonly string[]>([])
  const things = c?.things
  useEffect(() => {
    setUndoing((u) => {
      const still = u.filter((id) => things?.some((x) => x.suggestionId === id && x.undoable))
      return still.length === u.length ? u : still
    })
  }, [things])
  const back = () => router.back()
  const openCapture = (captureId: string) =>
    router.push({ pathname: '/capture/[id]', params: { id: captureId } })

  if (!c) {
    return (
      <Screen>
        <BackHeader backLabel="Journal" onBack={back} />
        <View style={{ padding: space.xl }}>
          <Placeholder title="This capture isn't on this phone, or it was deleted." />
        </View>
      </Screen>
    )
  }

  const view = transcriptView(c)
  const shown = tab && view.tabs.some((x) => x.id === tab) ? tab : view.initial
  const editing = draft !== null
  const meta = [
    c.source === 'voice' ? 'Voice note' : 'Typed',
    whenLabel(c.capturedAt, Date.now(), c.timezone),
    c.transcriptionFailure === 'kept' ? 'audio only' : captureStatusLabel(c.status),
  ].join(' · ')

  const save = () => {
    const next = draft === null ? null : editableText(c.text, draft)
    if (next) editCapture(c.id, next)
    setDraft(null)
  }

  const confirmDelete = () => {
    const [cascade, keep] = deleteChoices(c.things.length)
    Alert.alert(
      'Delete this capture?',
      `${cascade?.detail}\n\nOr keep what it made: ${keep?.detail.toLowerCase()}`,
      [
        { text: 'Cancel', style: 'cancel' },
        ...deleteChoices(c.things.length).map((choice) => ({
          text: choice.title,
          style: 'destructive' as const,
          onPress: () => {
            deleteCapture(c.id, choice.mode)
            router.back()
          },
        })),
      ],
    )
  }

  const go = (thing: LinkedThing) => {
    const l = thing.link
    if (!l) return
    if (l.to === 'inbox') router.push('/inbox')
    else if (l.to === 'plans') router.push({ pathname: '/journal/plans', params: { item: l.item } })
    else if (l.to === 'trackers') {
      router.push({ pathname: '/journal/trackers', params: { tracker: l.tracker } })
    } else router.push({ pathname: '/journal/trackers', params: { activity: l.name } })
  }

  const thingRow = (thing: LinkedThing) => {
    const review = thing.state === 'review'
    const muted = thing.state === 'dismissed' || thing.state === 'removed'
    return (
      <View key={thing.suggestionId} style={styles.thingLine}>
        <Pressable
          accessibilityRole={thing.link ? 'button' : 'text'}
          accessibilityLabel={`${thing.label}, ${THING_STATE_LABELS[thing.state]}`}
          accessibilityHint={
            review ? 'Opens the Inbox' : thing.link ? 'Opens it in the Journal' : undefined
          }
          disabled={!thing.link}
          onPress={() => go(thing)}
          style={({ pressed }) => [
            styles.thing,
            { backgroundColor: t.raised, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Label
            size={type.bodySmall}
            tone={muted ? 'muted' : 'primary'}
            style={[styles.thingLabel, muted ? { textDecorationLine: 'line-through' } : null]}
          >
            {thing.label}
          </Label>
          <Label size={type.label} tone={review ? 'accent' : 'muted'}>
            {THING_STATE_LABELS[thing.state]}
          </Label>
        </Pressable>
        {thing.undoable ? (
          <TextButton
            title="Undo"
            accessibilityLabel={`Undo: ${thing.label}`}
            disabled={undoing.includes(thing.suggestionId)}
            onPress={() => {
              if (undoing.includes(thing.suggestionId)) return
              setUndoing((u) => [...u, thing.suggestionId])
              undoApplied(thing.suggestionId, thing.label)
            }}
          />
        ) : null}
      </View>
    )
  }

  const loose = c.things.filter(
    (x) => !x.thoughtId || !c.thoughts.some((th) => th.id === x.thoughtId),
  )

  return (
    <Screen>
      <BackHeader
        backLabel="Journal"
        onBack={back}
        right={
          editing ? (
            <View style={styles.headerActions}>
              <TextButton title="Cancel" tone="secondary" onPress={() => setDraft(null)} />
              <TextButton
                title="Save"
                onPress={save}
                disabled={editableText(c.text, draft ?? '') === null}
              />
            </View>
          ) : (
            <TextButton
              title="Edit"
              onPress={() => setDraft(c.text)}
              accessibilityLabel="Edit text"
            />
          )
        }
      />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Label tone="muted" size={type.label}>
          {meta}
        </Label>
        {c.notices.map((n) => (
          <Note key={n.key} icon="info" text={n.text} onDismiss={() => dismissNotice(n.key)} />
        ))}
        {c.errorReason ? (
          <View style={styles.failed}>
            <Label tone="warning" size={type.bodySmall} style={{ flex: 1 }}>
              Not processed. {c.errorReason} Your capture is safe.
            </Label>
            <TextButton title="Retry" onPress={() => retryCaptures([c.id])} />
          </View>
        ) : null}
        {c.transcriptionFailure === 'ask' && !editing ? (
          <View style={{ gap: space.xs }}>
            <Label tone="warning" size={type.bodySmall} style={{ fontWeight: '600' }}>
              {untranscribableCopy(c.errorCode).title}
            </Label>
            <Label tone="secondary" size={type.bodySmall}>
              {untranscribableCopy(c.errorCode).detail}
            </Label>
            <View style={styles.headerActions}>
              <TextButton title="Write it down" onPress={() => setDraft(writeDownStart(c))} />
              <TextButton
                title="Keep as audio"
                tone="secondary"
                onPress={() => keepAsAudio(c.id)}
              />
            </View>
          </View>
        ) : null}

        {c.retryTranscription && !editing ? (
          <View style={styles.failed}>
            <Label tone="secondary" size={type.bodySmall} style={{ flex: 1 }}>
              The home server found no speech it could use, so the phone's live draft was read.
            </Label>
            <TextButton title="Retry transcription" onPress={() => retryCaptures([c.id])} />
          </View>
        ) : null}

        {c.audioReadError ? (
          <Label tone="secondary" size={type.bodySmall}>
            {AUDIO_READ_ERROR_TEXT}
          </Label>
        ) : null}

        {c.thinkingAbout ? (
          <View
            style={[styles.about, { backgroundColor: kindStyle('question', t.scheme).background }]}
          >
            <Pressable
              accessibilityRole={c.thinkingAbout.sourceBulletId ? 'link' : 'text'}
              accessibilityLabel={[
                thinkingAboutLabel(c.thinkingAbout.text),
                c.thinkingAbout.sourceLine,
              ]
                .filter(Boolean)
                .join('. ')}
              accessibilityHint={
                c.thinkingAbout.sourceBulletId ? 'Opens the capture it is about' : undefined
              }
              disabled={!c.thinkingAbout.sourceBulletId}
              onPress={() => {
                const src = c.thinkingAbout?.sourceBulletId
                if (src) openCapture(src)
              }}
              style={({ pressed }) => [styles.aboutLink, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Label size={type.caption} style={{ color: kindStyle('question', t.scheme).text }}>
                Thinking about
              </Label>
              <QuestionText size={type.body}>{c.thinkingAbout.text}</QuestionText>
              {c.thinkingAbout.sourceLine ? (
                <Label tone="accent" size={type.label}>
                  {c.thinkingAbout.sourceLine}
                  {c.thinkingAbout.sourceBulletId ? ' ›' : ''}
                </Label>
              ) : null}
            </Pressable>
            {c.thinkingAbout.canAddMore ? (
              <View style={{ alignItems: 'flex-start' }}>
                <TextButton
                  title="Add more"
                  accessibilityLabel={`Add more: ${c.thinkingAbout.text}`}
                  onPress={() =>
                    router.push({
                      pathname: '/answer',
                      params: { question: c.thinkingAbout?.questionId ?? '' },
                    })
                  }
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {c.audio ? <AudioPlayer audio={c.audio} /> : null}

        {editing ? (
          <>
            <TextInput
              value={draft ?? ''}
              onChangeText={setDraft}
              multiline
              autoFocus
              accessibilityLabel="Capture text"
              style={[styles.editor, { backgroundColor: t.card, color: t.text }]}
            />
            <Label tone="muted" size={type.caption}>
              Saving reads it again: thoughts and things are updated to match.
            </Label>
          </>
        ) : (
          <>
            {view.tabs.length > 0 ? (
              <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: t.note }]}>
                {view.tabs.map((x) => {
                  const selected = x.id === shown
                  return (
                    <Pressable
                      key={x.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      onPress={() => setTab(x.id)}
                      style={[
                        styles.tab,
                        { backgroundColor: selected ? t.raisedStrong : 'transparent' },
                      ]}
                    >
                      <Label size={type.label} tone={selected ? 'primary' : 'secondary'}>
                        {x.label}
                      </Label>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            <Label selectable tone={shown === 'draft' ? 'secondary' : 'soft'} style={styles.text}>
              {view.text(shown)}
            </Label>
            {view.note ? (
              <Label tone="muted" size={type.caption}>
                {view.note}
              </Label>
            ) : null}
          </>
        )}

        {c.thoughts.length > 0 ? (
          <>
            <SectionTitle>Thoughts · {c.thoughts.length}</SectionTitle>
            <Group>
              {c.thoughts.map((th, i) => {
                const k = kindStyle(th.kind, t.scheme)
                const things = c.things.filter((x) => x.thoughtId === th.id)
                return (
                  <View key={th.id}>
                    {i > 0 ? <Divider /> : null}
                    <View style={styles.thought}>
                      <View style={styles.thoughtLine}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Kind: ${k.label}. Change kind`}
                          onPress={() => setPicking(th)}
                          hitSlop={8}
                          style={({ pressed }) => [
                            styles.kind,
                            { backgroundColor: k.background, opacity: pressed ? 0.7 : 1 },
                          ]}
                        >
                          <Label size={type.tiny} style={{ color: k.text, fontWeight: '600' }}>
                            {k.label} ▾
                          </Label>
                        </Pressable>
                        <Label size={type.bodySmall} style={styles.thoughtText}>
                          {th.text}
                        </Label>
                      </View>
                      {things.map(thingRow)}
                    </View>
                  </View>
                )
              })}
            </Group>
          </>
        ) : null}

        <RelatedList items={related} onOpen={openCapture} onNotRelated={notRelated} />

        {c.thoughtAbout.length > 0 ? (
          <>
            <SectionTitle>You thought about this · {c.thoughtAbout.length}</SectionTitle>
            <Group>
              {c.thoughtAbout.map((a, i) => (
                <View key={a.id}>
                  {i > 0 ? <Divider /> : null}
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`${a.source === 'voice' ? 'Voice answer' : 'Answer'}, ${clock(a.capturedAt, a.timezone)}: ${a.snippet}`}
                    accessibilityHint="Opens the answer"
                    onPress={() => openCapture(a.id)}
                    style={({ pressed }) => [styles.answer, { opacity: pressed ? 0.7 : 1 }]}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Label size={type.bodySmall} numberOfLines={3}>
                        {a.snippet}
                      </Label>
                      <Label tone="muted" size={type.label}>
                        {whenLabel(a.capturedAt, Date.now(), a.timezone)}
                      </Label>
                    </View>
                    <Label tone="accent" size={type.label}>
                      Open
                    </Label>
                  </Pressable>
                </View>
              ))}
            </Group>
          </>
        ) : null}

        {loose.length > 0 ? (
          <>
            <SectionTitle>Things</SectionTitle>
            <View style={{ gap: space.sm }}>{loose.map(thingRow)}</View>
          </>
        ) : null}

        <View style={{ alignItems: 'center', marginTop: space.lg }}>
          <Pressable
            accessibilityRole="button"
            onPress={confirmDelete}
            style={({ pressed }) => [styles.delete, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Label style={{ color: t.destructive }}>Delete capture…</Label>
          </Pressable>
        </View>
      </ScrollView>
      <KindPicker
        thought={picking}
        onClose={() => setPicking(null)}
        onPick={(kind) => {
          if (picking && kind !== picking.kind) changeKind(picking.id, kind)
          setPicking(null)
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  about: { borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  aboutLink: { minHeight: size.touch, justifyContent: 'center', gap: space.xs, paddingVertical: 4 },
  answer: {
    minHeight: size.touch,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: 14 },
  headerActions: { flexDirection: 'row', gap: space.sm },
  failed: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tabs: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  tab: {
    flex: 1,
    minHeight: size.touch,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  text: { lineHeight: 24 },
  editor: {
    minHeight: 140,
    borderRadius: radius.note,
    padding: 14,
    fontSize: type.body,
    textAlignVertical: 'top',
  },
  thought: { paddingVertical: 10, paddingHorizontal: 14, gap: space.sm },
  thoughtLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  kind: {
    minHeight: 28,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
  },
  thoughtText: { flexGrow: 1, flexShrink: 1, flexBasis: 160 },
  thingLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  thing: {
    flex: 1,
    minHeight: size.touch,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  thingLabel: { flexShrink: 1, flexGrow: 1, flexBasis: 160 },
  delete: { minHeight: size.touch, justifyContent: 'center', paddingHorizontal: space.md },
})
