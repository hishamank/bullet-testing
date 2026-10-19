/**
 * Inbox · Noticed cards ("«quote» · came up N times in M days", up to 3 quotes, the theme pill,
 * Open / Not a theme / Clear / ···) and "Did this close it?" cards («loop» ← «answer», Close it /
 * Keep open with the usual Undo window, or "Already closed"). Layout only: the screen passes what
 * each tap does.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { OptionButton } from '@/components/inbox/parts'
import { IconButton, Label, TextButton, touch } from '@/components/ui'
import {
  closeAskLabel,
  COPY,
  type LoopAnswerCard,
  type NoticedCard as Card,
  quote,
} from '@bullet/client'
import { readingFont, space, type, useTheme } from '@/theme'
import { ConnectionCard, QuoteLink, Quoted, ThemePill } from './parts'

export function NoticedCard({
  card,
  onOpenCapture,
  onOpen,
  onNotATheme,
  onClear,
  onRename,
  onMore,
}: {
  card: Card
  onOpenCapture: (bulletId: string) => void
  onOpen: () => void
  onNotATheme: () => void
  /** Let this card go; the theme stays. */
  onClear: () => void
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
        <OptionButton title={COPY.open} label={`${COPY.open}: ${card.headline}`} onPress={onOpen} />
        <TextButton
          title={COPY.notATheme}
          tone="secondary"
          accessibilityLabel={`${COPY.notATheme}: ${card.headline}`}
          accessibilityHint={COPY.notAThemeHint}
          onPress={onNotATheme}
        />
        <TextButton
          title={COPY.clear}
          tone="secondary"
          accessibilityLabel={`${COPY.clear}: ${card.headline}`}
          accessibilityHint={COPY.clearHint}
          onPress={onClear}
        />
        <View style={{ flex: 1 }} />
        <IconButton
          icon="more"
          label={COPY.more}
          accessibilityHint={COPY.moreHint}
          iconSize={20}
          onPress={onMore}
        />
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
  onUndo,
  onClear,
}: {
  item: LoopAnswerCard
  onOpenCapture: (bulletId: string) => void
  onClose: () => void
  onKeepOpen: () => void
  /** Undo inside the window after Close it / Keep open. */
  onUndo: () => void
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
        accessibilityLabel={`Open loop: ${quote(item.loop)}`}
        accessibilityHint={COPY.quoteHint}
        onPress={() => onOpenCapture(item.loopBulletId)}
        style={({ pressed }) => [styles.quote, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Quoted text={item.loop} rtl={item.loopRtl} tone="secondary" />
      </Pressable>
      {item.answer ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Answered by ${quote(item.answer)}`}
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
      {item.decision ? (
        <View style={styles.decide}>
          <Label tone="secondary" size={type.bodySmall} style={{ flex: 1 }}>
            {item.decision === 'accepted' ? COPY.closed : COPY.keptOpen}
          </Label>
          <TextButton
            title={COPY.undo}
            accessibilityLabel={`${COPY.undo}: ${quote(item.loop)}`}
            onPress={onUndo}
          />
        </View>
      ) : item.alreadyClosed ? (
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
          <OptionButton
            title={COPY.keepOpen}
            label={`${COPY.keepOpen}: ${quote(item.loop)}`}
            onPress={onKeepOpen}
          />
          <OptionButton
            title={COPY.closeIt}
            label={`${COPY.closeIt}: ${quote(item.loop)}`}
            onPress={onClose}
          />
        </View>
      )}
    </ConnectionCard>
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
})
