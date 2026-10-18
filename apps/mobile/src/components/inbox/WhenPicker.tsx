/** A date-and-time picker for the Edit sheet (Android/web: the community picker). */

import DateTimePicker from '@expo/ui/community/datetime-picker'
import { View } from 'react-native'
import { useTheme } from '@/theme'

export interface WhenPickerProps {
  /** What the date is ("Starts", "Due"): spoken by VoiceOver / TalkBack. */
  label: string
  value: number
  onChange: (at: number) => void
}

export function WhenPicker({ label, value, onChange }: WhenPickerProps) {
  const t = useTheme()
  return (
    <View accessibilityLabel={label}>
      <DateTimePicker
        value={new Date(value)}
        mode="datetime"
        display="compact"
        accentColor={t.accent}
        onValueChange={(_, date) => onChange(date.getTime())}
      />
    </View>
  )
}
