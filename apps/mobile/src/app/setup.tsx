import { useRouter } from 'expo-router'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { ServerForm } from '@/components/setup/ServerForm'
import { Label, Screen, TextButton } from '@/components/ui'
import { deferPairing } from '@/features/sync/engine'
import { space, type } from '@/theme'

/**
 * Connect this phone to the home server. On first run "Not yet" goes straight to Capture:
 * captures stay on the phone until it's paired. Reached again later from Capture or Settings.
 */
export default function SetupScreen() {
  const router = useRouter()
  const notYet = () => {
    deferPairing()
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }
  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Label accessibilityRole="header" size={type.capture} style={{ fontWeight: '600' }}>
            Connect your home server
          </Label>
          <Label tone="secondary" size={type.bodySmall}>
            Your journal stays on this phone and your own home server. Nothing is sent anywhere
            else.
          </Label>
          <ServerForm />
          <View style={styles.notYet}>
            <TextButton
              title="Not yet"
              tone="secondary"
              accessibilityLabel="Not yet. Start capturing; pair a home server later"
              onPress={notYet}
            />
            <Label tone="muted" size={type.label} style={{ textAlign: 'center' }}>
              Captures stay on this phone until you pair.
            </Label>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: space.xl, paddingTop: 56, gap: space.lg },
  notYet: { alignItems: 'center', gap: space.xs },
})
