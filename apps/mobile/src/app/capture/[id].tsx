import { useLocalSearchParams, useRouter } from 'expo-router'
import { ScrollView, StyleSheet, View } from 'react-native'
import { BackHeader, KindPill, Label, Placeholder, Screen } from '@/components/ui'
import { listBullets, listThoughts } from '@/data/queries'
import { captureStatusLabel } from '@/features/capture/notice'
import { useLocalQuery } from '@/hooks'
import { space, type } from '@/theme'

/**
 * Capture detail. Minimal stand-in (text, state, thoughts with kinds); the audio player,
 * transcript toggle, re-classify, linked things, edit and delete are built in their own session.
 */
export default function CaptureDetail() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const capture = useLocalQuery((db) => listBullets(db).find((b) => b.id === id) ?? null, id)
  const thoughts = useLocalQuery((db) => listThoughts(db, id), id)
  return (
    <Screen>
      <BackHeader backLabel="Journal" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body}>
        {capture ? (
          <>
            <Label size={type.title}>{capture.text}</Label>
            <Label tone="muted" size={type.label}>
              {captureStatusLabel(capture.status)}
            </Label>
            {thoughts.map((th) => (
              <View key={th.id} style={styles.thought}>
                <KindPill kind={th.kind} />
                <Label>{th.text}</Label>
              </View>
            ))}
          </>
        ) : (
          <Placeholder title="This capture isn't on this phone." />
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: space.xl, gap: space.lg },
  thought: { gap: space.xs },
})
