import { ScrollView } from 'react-native'
import { Placeholder } from '@/components/ui'
import { space } from '@/theme'

/** Journal · trackers. Placeholder: built in its own session. */
export default function JournalTrackers() {
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <Placeholder title="Trackers: one row per tracker with its latest reading and a 14-day sparkline." />
    </ScrollView>
  )
}
