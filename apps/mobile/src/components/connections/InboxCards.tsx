/**
 * Inbox · Noticed cards ("«quote» · came up N times in M days", up to 3 quotes, the theme pill,
 * Open / Not a theme / ···) and "Did this close it?" cards («loop» ← «answer», Close it / Keep
 * open, or "Already closed"). Layout only: the screen passes what each tap does.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { IconButton, Label, TextButton, touch } from '@/components/ui'
import { closeAskLabel, COPY } from '@/features/connections/copy'
import type { LoopAnswerCard, NoticedCard as Card } from '@/features/connections/model'
import { radius, readingFont, space, type, useTheme } from '@/theme'
import { ConnectionCard, QuoteLink, Quoted, ThemePill } from './parts'

export function NoticedCard({
  card,
  onOpenCapture,
  onOpen,
  onNotATheme,
  onRename,
  onMore,
}: {
  card: Card
  onOpenCapture: (bulletId: string) => void
  onOpen: () => void
  onNotATheme: () => void
  onRename: () => void
  onMore: () => void
}) {
  return (
    <ConnectionCard>
      <ThemePill name={card.theme.name} onPress={onRename} />
      <Label
        accessibilityRole="header"
        size={type.body}
        style={[
          { fontFamily: readingFont, lineHeight: type.body * 1.4 },
          card.headlineRtl ? { writingDirection: 'rtl', textAlign: 'right' } : null,
        ]}
      >
        {card.headline}
      </Label>
      <View>
        {card.quotes.map((q, i) => (
          <QuoteLink key={q.thoughtId} row={q} onOpen={onOpenCapture} first={i === 0} />
        ))}
      </View>
      <View style={styles.actions}>
        <OutlineButton
          title={COPY.open}
          label={`${COPY.open}: ${card.headline}`}
          hint={COPY.openHint}
          onPress={onOpen}
        />
        <TextButton
          title={COPY.notATheme}
          tone="secondary"
          accessibilityLabel={`${COPY.notATheme}: ${card.headline}`}
          accessibilityHint={COPY.notAThemeHint}
          onPress={onNotATheme}
        />
        <View style={{ flex: 1 }} />
        <IconButton icon="more" label={COPY.moreLabel} iconSize={20} onPress={onMore} />
      </View>
    </ConnectionCard>
  )
}

export function NoticedEmpty() {
  return (
    <ConnectionCard>
      <Label tone="secondary" size={type.bodySmall}>
        {COPY.noticedEmpty}
      </Label>
    </ConnectionCard>
  )
}

export function LoopAnswer({
  item,
  onOpenCapture,
  onClose,
  onKeepOpen,
  onClear,
}: {
  item: LoopAnswerCard
  onOpenCapture: (bulletId: string) => void
  onClose: () => void
  onKeepOpen: () => void
  /** "Already closed" → OK: the card goes. */
  onClear: () => void
}) {
  const t = useTheme()
  const label = closeAskLabel(item.loop, item.answer)
  return (
    <ConnectionCard>
      <Label size={type.bodySmall} accessibilityRole="header" accessibilityLabel={label}>
        {COPY.closeAsk}
      </Label>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open loop: «${item.loop}»`}
        accessibilityHint={COPY.quoteHint}
        onPress={() => onOpenCapture(item.loopBulletId)}
        style={({ pressed }) => [styles.quote, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Quoted text={item.loop} rtl={item.loopRtl} tone="secondary" />
      </Pressable>
      {item.answer ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Answered by «${item.answer}»`}
          accessibilityHint={COPY.quoteHint}
          onPress={() => onOpenCapture(item.answerBulletId)}
          style={({ pressed }) => [styles.quote, styles.answer, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={{ color: t.textSecondary, fontSize: type.bodySmall }}>←</Text>
          <View style={{ flex: 1 }}>
            <Quoted text={item.answer} rtl={item.answerRtl} tone="primary" />
          </View>
        </Pressable>
      ) : null}
      {item.alreadyClosed ? (
        <View style={styles.decide}>
          <Label tone="muted" size={type.bodySmall} style={{ flex: 1 }}>
            {COPY.alreadyClosed}
          </Label>
          <TextButton
            title={COPY.ok}
            accessibilityLabel={`${COPY.alreadyClosed}. ${COPY.ok}`}
            onPress={onClear}
          />
        </View>
      ) : (
        <View style={styles.decide}>
          <OutlineButton
            title={COPY.keepOpen}
            label={`${COPY.keepOpen}: «${item.loop}»`}
            onPress={onKeepOpen}
          />
          <FilledButton
            title={COPY.closeIt}
            label={`${COPY.closeIt}: «${item.loop}»`}
            onPress={onClose}
          />
        </View>
      )}
    </ConnectionCard>
  )
}

function OutlineButton({
  title,
  label,
  hint,
  onPress,
}: {
  title: string
  label: string
  hint?: string
  onPress: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pillButton,
        { borderWidth: 1, borderColor: t.textMuted, backgroundColor: t.raised },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Label size={type.bodySmall}>{title}</Label>
    </Pressable>
  )
}

function FilledButton({
  title,
  label,
  onPress,
}: {
  title: string
  label: string
  onPress: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pillButton,
        { backgroundColor: t.accent, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={{ color: t.onAccent, fontSize: type.bodySmall, fontWeight: '600' }}>
        {title}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  decide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  quote: { minHeight: touch.minHeight, justifyContent: 'center' },
  answer: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pillButton: {
    ...touch,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
  },
})
