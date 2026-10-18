/**
 * First run · microphone (MicPermission artboard): explains where recordings go, then hands off
 * to the iOS prompts. "Type instead" is always there. The `blocked` variant is shown once the
 * microphone was turned off: only Settings can turn it back on.
 */

import { Linking, StyleSheet, View } from 'react-native'
import { kindStyle, space, useTheme } from '@/theme'
import { Icon } from '../Icon'
import { Label, PrimaryButton, TextButton } from '../ui'

export function MicPermission({
  blocked,
  onAllow,
  onTypeInstead,
}: {
  blocked: boolean
  onAllow: () => void
  onTypeInstead: () => void
}) {
  const t = useTheme()
  const badge = kindStyle('activity', t.scheme)
  return (
    <View style={styles.body}>
      <View style={[styles.badge, { backgroundColor: badge.background }]}>
        <Icon name="mic" color={badge.text} size={32} />
      </View>
      <Label accessibilityRole="header" size={30} style={styles.title}>
        {blocked ? 'Microphone is off' : "Say what's on your mind"}
      </Label>
      {blocked ? (
        <Label tone="secondary" style={styles.paragraph}>
          To record, turn on Microphone for Bullet in Settings. Your recordings are kept on this
          phone and on your home server, and nowhere else.
        </Label>
      ) : (
        <>
          <Label tone="secondary" style={styles.paragraph}>
            Talk for as long as you need. Your recordings are kept on this phone and on your home
            server, and nowhere else.
          </Label>
          <Label tone="secondary" style={styles.paragraph}>
            Next, iOS will ask for microphone and speech recognition access.
          </Label>
        </>
      )}
      <View style={{ flex: 1 }} />
      <PrimaryButton
        title={blocked ? 'Open Settings' : 'Allow microphone'}
        onPress={blocked ? () => void Linking.openSettings() : onAllow}
      />
      <TextButton title="Type instead" tone="secondary" onPress={onTypeInstead} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingTop: 96,
    paddingHorizontal: 28,
    paddingBottom: space.xxl,
    gap: space.xl,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontWeight: '600', lineHeight: 36 },
  paragraph: { lineHeight: 25 },
})
