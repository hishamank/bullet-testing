import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { Label, Placeholder, RoundButton, Screen, TextButton } from '@/components/ui'
import { size, space, type } from '@/theme'

/**
 * Capture · recording. Placeholder: voice capture (expo-audio + Apple SpeechAnalyzer live draft,
 * pause, Send = stop and save) is built in its own session.
 */
export default function RecordScreen() {
  const router = useRouter()
  return (
    <Screen>
      <View style={styles.top}>
        <View style={{ flex: 1 }} />
        <TextButton title="Cancel" tone="secondary" onPress={() => router.back()} />
      </View>
      <View style={styles.body}>
        <Placeholder title="Voice capture is coming soon. For now, type your thought instead." />
      </View>
      <Label tone="muted" size={type.label} style={styles.hint}>
        Live draft. Your recording is kept and transcribed again at home.
      </Label>
      <View style={styles.controls}>
        <RoundButton icon="send" label="Stop and save" diameter={size.mic} disabled />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', paddingHorizontal: space.xl, paddingTop: space.md },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xl },
  hint: { paddingHorizontal: space.xl, paddingBottom: space.xl },
  controls: { alignItems: 'center', paddingBottom: space.xxl },
})
