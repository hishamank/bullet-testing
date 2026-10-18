import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native'
import { ServerForm } from '@/components/setup/ServerForm'
import { Label, Screen } from '@/components/ui'
import { space, type } from '@/theme'

/** First run: connect this phone to the home server. Needed before anything else. */
export default function SetupScreen() {
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
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: space.xl, paddingTop: 56, gap: space.lg },
})
