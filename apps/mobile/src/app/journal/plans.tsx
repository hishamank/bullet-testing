import { ScrollView } from 'react-native'
import { Placeholder } from '@/components/ui'
import { space } from '@/theme'

/** Journal · plans. Placeholder: built in its own session. */
export default function JournalPlans() {
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <Placeholder title="Plans: upcoming events by day, then open tasks by due date." />
    </ScrollView>
  )
}
