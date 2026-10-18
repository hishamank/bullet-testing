import { ScrollView } from 'react-native'
import { Placeholder } from '@/components/ui'
import { space } from '@/theme'

/** Journal · open loops. Placeholder: built in its own session. */
export default function JournalOpenLoops() {
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <Placeholder title="Open loops: things to check and questions you asked yourself, each linking back to its capture." />
    </ScrollView>
  )
}
