/** Device edge: the palette for the system colour scheme. */

import { useColorScheme } from 'react-native'
import { dark, light, type Palette } from './tokens'

export * from './tokens'

export function useTheme(): Palette {
  return useColorScheme() === 'light' ? light : dark
}
