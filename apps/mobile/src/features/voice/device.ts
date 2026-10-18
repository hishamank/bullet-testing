/**
 * Device edge for voice: files (expo-file-system) and the two iOS
 * permissions. Thin adapters over the injected interfaces in save.ts / access.ts.
 */

import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio'
import { Directory, File, Paths } from 'expo-file-system'
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import type { PermissionState, VoicePermissions } from './access'
import type { VoiceStoreDeps, VoiceStoreIo } from './save'

const withSlash = (uri: string) => (uri.endsWith('/') ? uri : `${uri}/`)

export const deviceVoiceIo: VoiceStoreIo = {
  exists: (uri) => (uri.endsWith('/') ? new Directory(uri).exists : new File(uri).exists),
  size: (uri) => new File(uri).size,
  read(uri, offset, length) {
    const handle = new File(uri).open()
    try {
      handle.offset = offset
      return handle.readBytes(length)
    } finally {
      handle.close()
    }
  },
  create: (uri, bytes) => {
    const f = new File(uri)
    f.create({ overwrite: true })
    f.write(bytes)
  },
  append: (uri, bytes) => new File(uri).write(bytes, { append: true }),
  list(dir) {
    const d = new Directory(dir)
    return d.exists ? d.list().map((e) => e.name) : []
  },
  readText(uri) {
    const f = new File(uri)
    return f.exists ? f.textSync() : null
  },
  writeText: (uri, text) => {
    const f = new File(uri)
    if (!f.exists) f.create()
    f.write(text)
  },
  ensureDir: (dir) => new Directory(dir).create({ intermediates: true, idempotent: true }),
  remove(uri) {
    const entry = uri.endsWith('/') ? new Directory(uri) : new File(uri)
    if (entry.exists) entry.delete()
  },
  move: (from, to) => new File(from).moveSync(new File(to)),
}

/** Where recordings live: the documents folder (never purged by iOS, unlike the cache). */
export function recordingsRoot(): string {
  const root = withSlash(new Directory(Paths.document, 'recordings').uri)
  deviceVoiceIo.ensureDir(root)
  return root
}

export function voiceStoreDeps(): VoiceStoreDeps {
  return { db: getDb(), local: deviceDeps, io: deviceVoiceIo, root: recordingsRoot() }
}

const asState = (p: { granted: boolean; canAskAgain: boolean }): PermissionState => ({
  granted: p.granted,
  canAskAgain: p.canAskAgain,
})

function onDeviceEnglish(): boolean {
  try {
    return (
      ExpoSpeechRecognitionModule.isRecognitionAvailable() &&
      ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
    )
  } catch {
    return false
  }
}

export async function readVoicePermissions(): Promise<VoicePermissions> {
  const [microphone, speech] = await Promise.all([
    getRecordingPermissionsAsync(),
    ExpoSpeechRecognitionModule.getSpeechRecognizerPermissionsAsync(),
  ])
  return {
    microphone: asState(microphone),
    speech: asState(speech),
    onDeviceEnglish: onDeviceEnglish(),
  }
}

/** The iOS prompts, microphone first, then speech recognition (only asked if the mic is on). */
export async function requestVoicePermissions(): Promise<VoicePermissions> {
  const microphone = await requestRecordingPermissionsAsync()
  if (microphone.granted) {
    await ExpoSpeechRecognitionModule.requestSpeechRecognizerPermissionsAsync()
  }
  return readVoicePermissions()
}
