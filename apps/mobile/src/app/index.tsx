import { nonEmptyString } from '@bullet/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { captureBullet } from '@/data/local'
import { getDb } from '@/data/open'
import { deviceDeps, syncSoon } from '@/sync/runtime'

/**
 * Placeholder capture screen. Send saves the bullet on the device (with its outbox entry) and
 * asks for a sync; the real capture UI comes from the design work.
 */
export default function CaptureScreen() {
  const dark = useColorScheme() === 'dark'
  const [text, setText] = useState('')
  const canSend = nonEmptyString().safeParse(text.trim()).success

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: dark ? '#111' : '#fafafa' }]}>
      <View style={styles.stream} />
      <View style={styles.composer}>
        <TextInput
          style={[styles.input, { color: dark ? '#eee' : '#111' }]}
          placeholder="What's on your mind?"
          placeholderTextColor="#888"
          value={text}
          onChangeText={setText}
          multiline
          accessibilityLabel="New bullet"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send bullet"
          disabled={!canSend}
          onPress={() => {
            captureBullet(getDb(), { text }, deviceDeps)
            setText('')
            syncSoon()
          }}
          style={[styles.send, { opacity: canSend ? 1 : 0.4 }]}
        >
          <Text style={styles.sendLabel}>Send</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  stream: { flex: 1 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12 },
  input: { flex: 1, minHeight: 44, maxHeight: 160, fontSize: 17, paddingVertical: 10 },
  send: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    justifyContent: 'center',
    backgroundColor: '#208AEF',
  },
  sendLabel: { color: '#fff', fontSize: 17, fontWeight: '600' },
})
