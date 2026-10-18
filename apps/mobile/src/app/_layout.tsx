import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { startAppSync } from '@/features/sync/engine'
import { usePairing } from '@/hooks'
import { useTheme } from '@/theme'

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const t = useTheme()
  const pairing = usePairing()
  useEffect(() => startAppSync(), [])
  useEffect(() => {
    if (pairing !== 'loading') void SplashScreen.hideAsync()
  }, [pairing])
  if (pairing === 'loading') return null

  const base = t.scheme === 'dark' ? DarkTheme : DefaultTheme
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      background: t.background,
      card: t.card,
      text: t.text,
      border: t.hairline,
      primary: t.accent,
    },
  }
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.background } }}
      >
        <Stack.Protected guard={pairing === 'unpaired'}>
          <Stack.Screen name="setup" />
        </Stack.Protected>
        <Stack.Protected guard={pairing === 'paired'}>
          <Stack.Screen name="index" />
          <Stack.Screen name="journal" options={{ animation: 'slide_from_left' }} />
          <Stack.Screen name="inbox" />
          <Stack.Screen name="capture/[id]" />
          <Stack.Screen name="answer" />
          <Stack.Screen name="record" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="server" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  )
}
