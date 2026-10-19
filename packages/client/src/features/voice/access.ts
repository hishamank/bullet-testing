/**
 * What the microphone button can do, from the two iOS permissions (pure). The first run explains
 * and then hands off to the iOS prompts; speech recognition is optional (no live draft without it).
 */

export interface PermissionState {
  granted: boolean
  /** False once the user said no: only Settings can change it. */
  canAskAgain: boolean
}

export interface VoicePermissions {
  microphone: PermissionState
  speech: PermissionState
  /** The device can recognise English on-device (nothing leaves the phone). */
  onDeviceEnglish: boolean
}

export type VoiceAccess =
  /** First run (or something still undecided): show the explanation, then ask. */
  | { kind: 'ask' }
  /** The microphone is off: point to Settings, offer typing. */
  | { kind: 'blocked' }
  /** Record with the on-device live draft. */
  | { kind: 'draft' }
  /** Record without a live draft. */
  | { kind: 'record_only'; why: 'speech_denied' | 'no_on_device' }

const undecided = (p: PermissionState) => !p.granted && p.canAskAgain

export function voiceAccess(p: VoicePermissions): VoiceAccess {
  if (!p.microphone.granted) return p.microphone.canAskAgain ? { kind: 'ask' } : { kind: 'blocked' }
  if (undecided(p.speech)) return { kind: 'ask' }
  if (!p.speech.granted) return { kind: 'record_only', why: 'speech_denied' }
  if (!p.onDeviceEnglish) return { kind: 'record_only', why: 'no_on_device' }
  return { kind: 'draft' }
}
