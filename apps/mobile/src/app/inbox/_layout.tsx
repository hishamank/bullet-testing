import { Stack } from 'expo-router'
import { useTheme } from '@/theme'

/** The Inbox and its Edit sheet. */
export default function InboxLayout() {
  const t = useTheme()
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="edit" options={{ presentation: 'modal' }} />
    </Stack>
  )
}
