import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { useEffect } from 'react'
import { useColorScheme } from 'react-native'
import { startSyncEngine } from '@/sync/runtime'

export default function RootLayout() {
  const colorScheme = useColorScheme()
  useEffect(() => startSyncEngine(), [])
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  )
}
