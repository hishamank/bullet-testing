import { nonEmptyString } from '@bullet/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

/**
 * Placeholder capture screen. It proves the workspace wiring (Metro resolving `@bullet/core`
 * from source); local persistence, the outbox and sync come in the capture-loop slice.
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
          onPress={() => setText('')}
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
