/** Home server address + device token, checked with one small pull, then saved securely. */

import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import {
  CHECK_MESSAGES,
  type ConnectionCheck,
  checkConnection,
  normalizeServerUrl,
  normalizeToken,
} from '@/features/setup/pairing'
import { pairDevice } from '@/features/sync/engine'
import { createHttpTransport } from '@/sync/transport'
import { radius, space, type, useTheme } from '@/theme'
import { Label, PrimaryButton, TextButton } from '../ui'

export function ServerForm({
  initialUrl = '',
  onPaired,
}: {
  initialUrl?: string
  onPaired?: () => void
}) {
  const t = useTheme()
  const [url, setUrl] = useState(initialUrl)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ConnectionCheck | null>(null)

  const parsed = () => {
    const u = normalizeServerUrl(url)
    if (!u.ok) return { error: u.error }
    const k = normalizeToken(token)
    if (!k.ok) return { error: k.error }
    return { settings: { baseUrl: u.url, token: k.token } }
  }

  async function save() {
    const p = parsed()
    if (!p.settings) return
    await pairDevice(p.settings)
    onPaired?.()
  }

  async function connect() {
    const p = parsed()
    setResult(null)
    if (!p.settings) {
      setError(p.error ?? null)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const check = await checkConnection(createHttpTransport({ ...p.settings, timeoutMs: 10_000 }))
      setResult(check)
      if (check === 'ok') await save()
    } finally {
      setBusy(false)
    }
  }

  const field = [
    styles.field,
    { backgroundColor: t.card, borderColor: t.hairline, color: t.text, fontSize: type.body },
  ]
  const message = error ?? (result && result !== 'ok' ? CHECK_MESSAGES[result] : null)

  return (
    <View style={styles.form}>
      <View style={styles.group}>
        <Label tone="secondary" size={type.label} nativeID="server-url-label">
          Home server address
        </Label>
        <TextInput
          value={url}
          onChangeText={(v) => {
            setUrl(v)
            setResult(null)
          }}
          placeholder="my-mac.tailnet.ts.net"
          placeholderTextColor={t.textMuted}
          accessibilityLabel="Home server address"
          accessibilityLabelledBy="server-url-label"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          keyboardAppearance={t.scheme}
          returnKeyType="next"
          style={field}
        />
      </View>
      <View style={styles.group}>
        <Label tone="secondary" size={type.label} nativeID="token-label">
          Device token
        </Label>
        <TextInput
          value={token}
          onChangeText={(v) => {
            setToken(v)
            setResult(null)
          }}
          placeholder="Paste it here"
          placeholderTextColor={t.textMuted}
          accessibilityLabel="Device token"
          accessibilityLabelledBy="token-label"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          keyboardAppearance={t.scheme}
          returnKeyType="done"
          onSubmitEditing={() => void connect()}
          style={field}
        />
        <Label tone="muted" size={type.label}>
          On the server, run `pnpm --filter server device:add my-iphone` and paste the token it
          prints.
        </Label>
      </View>
      {message ? (
        <Label tone="warning" size={type.bodySmall} accessibilityRole="alert">
          {message}
        </Label>
      ) : null}
      <PrimaryButton
        title={busy ? 'Checking…' : 'Connect'}
        busy={busy}
        onPress={() => void connect()}
      />
      {result === 'unreachable' ? (
        <TextButton title="Save anyway" onPress={() => void save()} />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: space.xl },
  group: { gap: space.sm },
  field: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.note,
    paddingHorizontal: 14,
    paddingVertical: space.md,
  },
})
