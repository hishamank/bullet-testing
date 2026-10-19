/**
 * The sync status indicator and the few lines of copy that differ from the phone's ("device"
 * instead of "phone"). Pure; the shell renders what these return.
 *
 *   synced · syncing · can't reach · N on this device
 */

import type { Reachability } from '@bullet/client'

export type IndicatorKind =
  | 'unpaired'
  | 'syncing'
  | 'unreachable'
  | 'unauthorized'
  | 'on-device'
  | 'synced'

export interface Indicator {
  kind: IndicatorKind
  label: string
  /** The longer line for a tooltip / the settings panel. */
  detail: string
}

export interface IndicatorInput {
  paired: boolean
  syncing: boolean
  reachability: Reachability
  /** Offline, or the server can't be reached / refused this browser. */
  cannotReach: boolean
  /** Writes the server hasn't confirmed yet. */
  onDevice: number
}

export const onDeviceText = (n: number) => `${n} on this device · will sync`

export const UNREACHABLE_TEXT =
  'Home server unreachable. Your captures are safe on this device and will sync later.'

export const UNAUTHORIZED_TEXT =
  "The home server didn't accept this device's token. Your captures are safe on this device."

export const pendingLine = (n: number) => `Pending on this device · ${n}`

export function syncIndicator(i: IndicatorInput): Indicator {
  if (!i.paired) {
    return { kind: 'unpaired', label: 'Not paired', detail: 'Pair a home server to sync.' }
  }
  if (i.reachability === 'unauthorized') {
    return { kind: 'unauthorized', label: "Can't reach", detail: UNAUTHORIZED_TEXT }
  }
  if (i.cannotReach) {
    return {
      kind: 'unreachable',
      label: "Can't reach",
      detail: i.onDevice > 0 ? `${UNREACHABLE_TEXT} ${onDeviceText(i.onDevice)}` : UNREACHABLE_TEXT,
    }
  }
  if (i.syncing)
    return { kind: 'syncing', label: 'Syncing…', detail: 'Syncing with your home server.' }
  if (i.onDevice > 0) {
    return { kind: 'on-device', label: onDeviceText(i.onDevice), detail: onDeviceText(i.onDevice) }
  }
  return { kind: 'synced', label: 'Synced', detail: 'Everything is on your home server.' }
}
