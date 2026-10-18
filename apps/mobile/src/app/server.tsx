import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native'
import { ServerForm } from '@/components/setup/ServerForm'
import { BackHeader, Label, Screen } from '@/components/ui'
import { loadServerSettings } from '@/sync/settings'
import { space, type } from '@/theme'

/** Change the home server or this phone's token (e.g. after the token was refused). */
export default function ServerScreen() {
  const router = useRouter()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    loadServerSettings()
      .then((s) => setUrl(s?.baseUrl ?? ''))
      .catch(() => setUrl(''))
  }, [])
  return (
    <Screen>
      <BackHeader backLabel="Back" onBack={() => router.back()} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Label accessibilityRole="header" size={type.title} style={{ fontWeight: '600' }}>
            Home server
          </Label>
          <Label tone="secondary" size={type.bodySmall}>
            Captures already on this phone stay here and sync to the server you connect.
          </Label>
          {url !== null ? <ServerForm initialUrl={url} onPaired={() => router.back()} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { padding: space.xl, gap: space.lg },
})
