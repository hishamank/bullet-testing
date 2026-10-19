/** Device edge: the palette for the system colour scheme. */

import { Platform, useColorScheme } from 'react-native'
import { dark, light, type Palette } from '@bullet/client/theme'

export * from '@bullet/client/theme'

export function useTheme(): Palette {
  return useColorScheme() === 'light' ? light : dark
}

/** The serif reading face for reflective questions (Georgia ships with iOS; serif on Android). */
export const readingFont = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' })
