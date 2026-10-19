import { SymbolView } from 'expo-symbols'
import type { ComponentProps } from 'react'

type SymbolName = ComponentProps<typeof SymbolView>['name']

/** SF Symbols on iOS, Material Symbols elsewhere. Icons are decorative: label the button. */
const ICONS = {
  journal: { ios: 'book.closed', android: 'menu_book', web: 'menu_book' },
  inbox: { ios: 'tray', android: 'inbox', web: 'inbox' },
  mic: { ios: 'mic', android: 'mic', web: 'mic' },
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  offline: { ios: 'icloud.slash', android: 'cloud_off', web: 'cloud_off' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  back: { ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' },
  forward: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  pause: { ios: 'pause', android: 'pause', web: 'pause' },
  play: { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' },
  text: { ios: 'text.quote', android: 'format_quote', web: 'format_quote' },
  info: { ios: 'info.circle', android: 'info', web: 'info' },
  note: { ios: 'square.and.pencil', android: 'edit_note', web: 'edit_note' },
  expand: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  collapse: { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' },
  settings: { ios: 'gearshape', android: 'settings', web: 'settings' },
} satisfies Record<string, SymbolName>

export type IconName = keyof typeof ICONS

export function Icon({
  name,
  color,
  size = 24,
  weight = 'regular',
}: {
  name: IconName
  color: string
  size?: number
  weight?: 'regular' | 'medium' | 'semibold'
}) {
  return (
    <SymbolView
      name={ICONS[name]}
      tintColor={color}
      size={size}
      weight={weight}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  )
}
