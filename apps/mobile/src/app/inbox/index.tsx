import { Link, useRouter } from 'expo-router'
import { Pressable, ScrollView, StyleSheet } from 'react-native'
import { BackHeader, Label, Placeholder, Screen } from '@/components/ui'
import { listOpenQuestions, listPendingSuggestions } from '@/data/queries'
import { useLocalQuery } from '@/hooks'
import { radius, space, type, useTheme } from '@/theme'

/**
 * Inbox. Minimal stand-in: counts plus open questions linking to Answer. To decide, quick
 * options, Skip and Done for you (with Undo) are built in their own session.
 */
export default function Inbox() {
  const t = useTheme()
  const router = useRouter()
  const pending = useLocalQuery((db) => listPendingSuggestions(db).length)
  const questions = useLocalQuery(listOpenQuestions)
  return (
    <Screen>
      <BackHeader title="Inbox" backLabel="Capture" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body}>
        <Placeholder
          title={`${pending} to decide · ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`}
        />
        {questions.map((q) => (
          <Link key={q.id} href={{ pathname: '/answer', params: { question: q.id } }} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Answer in words"
              style={[styles.card, { backgroundColor: t.card }]}
            >
              <Label>{q.text}</Label>
              <Label tone="accent" size={type.label}>
                Answer in words
              </Label>
            </Pressable>
          </Link>
        ))}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  card: { borderRadius: radius.card, padding: space.lg, gap: space.sm, minHeight: 44 },
})
