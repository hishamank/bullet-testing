/** iOS: SwiftUI's compact DatePicker, with the field's name as its VoiceOver label. */

import { DatePicker, Host } from '@expo/ui/swift-ui'
import {
  accessibilityLabel,
  datePickerStyle,
  labelsHidden,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { useTheme } from '@/theme'
import type { WhenPickerProps } from './WhenPicker'

export function WhenPicker({ label, value, onChange }: WhenPickerProps) {
  const t = useTheme()
  return (
    <Host matchContents={{ vertical: true }} ignoreSafeArea="all">
      <DatePicker
        title={label}
        selection={new Date(value)}
        displayedComponents={['date', 'hourAndMinute']}
        onDateChange={(date) => onChange(date.getTime())}
        modifiers={[
          datePickerStyle('compact'),
          tint(t.accent),
          labelsHidden(),
          accessibilityLabel(label),
        ]}
      />
    </Host>
  )
}
