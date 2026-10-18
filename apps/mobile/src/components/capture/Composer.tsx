/**
 * The capture page body, shared by Capture (home) and Answer. Idle is mic-first with the keyboard
 * down; tapping the text types; Send sits above the keyboard; "Saved" shows for about two
 * seconds and the page clears. The state machine is pure (features/capture/composer.ts).
 */

import { type ReactNode, useEffect, useReducer, useRef } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import {
  canSend,
  composerMode,
  composerReducer,
  initialComposer,
  SAVED_MS,
} from '@/features/capture/composer'
import { useReduceMotion } from '@/hooks'
import { size, space, type, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { IconButton, Label, RoundButton } from '../ui'

export interface ComposerProps {
  header: ReactNode
  /** A card pinned above the text (the question or loop being answered). */
  pinned?: ReactNode
  placeholder: string
  inputLabel: string
  micLabel: string
  /** The quiet line under the mic when nothing was just saved. */
  statusLine?: ReactNode
  onMic: () => void
  /** Save the capture. Must not throw for non-empty text. */
  onSend: (text: string) => void
  /** "Saved" has finished showing. */
  onSavedShown?: () => void
}

export function Composer(p: ComposerProps) {
  const t = useTheme()
  const reduceMotion = useReduceMotion()
  const [state, dispatch] = useReducer(composerReducer, initialComposer)
  const input = useRef<TextInput>(null)
  const savedOpacity = useRef(new Animated.Value(0)).current
  const mode = composerMode(state)
  const { savedAt } = state
  const { onSavedShown } = p

  useEffect(() => {
    if (savedAt === null) return
    AccessibilityInfo.announceForAccessibility('Saved')
    savedOpacity.setValue(reduceMotion ? 1 : 0)
    if (!reduceMotion) {
      Animated.timing(savedOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start()
    }
    const fadeOut = setTimeout(() => {
      if (reduceMotion) return
      Animated.timing(savedOpacity, { toValue: 0, duration: 250, useNativeDriver: true }).start()
    }, SAVED_MS - 250)
    const done = setTimeout(() => {
      dispatch({ type: 'saved_elapsed', at: savedAt + SAVED_MS })
      onSavedShown?.()
    }, SAVED_MS)
    return () => {
      clearTimeout(fadeOut)
      clearTimeout(done)
    }
  }, [savedAt, reduceMotion, savedOpacity, onSavedShown])

  function send() {
    if (!canSend(state.text)) return
    p.onSend(state.text)
    dispatch({ type: 'sent', at: Date.now() })
    input.current?.blur()
    Keyboard.dismiss()
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.fill}
    >
      <View style={styles.top}>
        {p.header}
        {p.pinned}
      </View>
      <TextInput
        ref={input}
        value={state.text}
        onChangeText={(text) => dispatch({ type: 'change', text })}
        onFocus={() => dispatch({ type: 'focus' })}
        onBlur={() => dispatch({ type: 'blur' })}
        placeholder={p.placeholder}
        placeholderTextColor={t.textMuted}
        accessibilityLabel={p.inputLabel}
        multiline
        textAlignVertical="top"
        keyboardAppearance={t.scheme}
        selectionColor={t.accent}
        style={[styles.input, { color: t.text }]}
      />
      {mode === 'typing' ? (
        <View style={styles.typingBar}>
          <IconButton icon="mic" label="Switch to voice" onPress={p.onMic} />
          <RoundButton
            icon="send"
            label="Send"
            diameter={size.send}
            disabled={!canSend(state.text)}
            onPress={send}
          />
        </View>
      ) : (
        <View style={styles.idleBar}>
          <RoundButton icon="mic" label={p.micLabel} diameter={size.mic} onPress={p.onMic} />
          <View style={styles.status}>
            {mode === 'saved' ? (
              <Animated.View
                accessibilityRole="text"
                style={[styles.saved, { opacity: savedOpacity }]}
              >
                <Icon name="check" color={t.accentText} size={16} weight="semibold" />
                <Label tone="accent" size={type.label}>
                  Saved
                </Label>
              </Animated.View>
            ) : (
              p.statusLine
            )}
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: { paddingHorizontal: space.xl, paddingTop: space.md, gap: space.md },
  input: {
    flex: 1,
    marginHorizontal: space.xl,
    marginTop: space.xxl,
    fontSize: type.capture,
    lineHeight: type.capture * 1.3,
    padding: 0,
  },
  typingBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  idleBar: { alignItems: 'center', gap: space.lg, paddingBottom: space.xxl, paddingTop: space.md },
  status: { minHeight: size.touch, justifyContent: 'center', paddingHorizontal: space.xl },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 6 },
})
