# Voice capture on the phone

Tap the mic, talk for as long as you need, tap Send. The **recording is the source of truth**: it
is kept forever on the phone and on the home server, where Whisper transcribes it again (mixed
English, Lebanese Arabic and French). While you talk, the phone shows a **live English draft**
from Apple's on-device recognizer. The draft is only a preview. Saving never waits on its quality.

Code: `packages/client/src/features/voice` (logic), `apps/mobile/src/features/voice` (device
drivers, recorder hook), `components/voice` (layout), `app/record.tsx`
(route). Contract: `docs/contract.md` §2b.

## Which speech module, and why

| Option                                       | Live draft                    | Keeps the audio                       | Verdict                                               |
| -------------------------------------------- | ----------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **expo-speech-recognition** (`~57.1.1`)      | yes (SFSpeechRecognizer)      | **yes**, from the same microphone tap | **chosen**                                            |
| expo-speech-transcriber, expo-ai-kit         | yes (SpeechAnalyzer, iOS 26+) | no: own capture, nothing written      | would need a second recorder on the same mic          |
| @react-native-ai/apple                       | no (files only)               | n/a                                   | no live draft                                         |
| A custom Expo module (SpeechAnalyzer + file) | yes                           | yes                                   | best long-term; needs Swift built and tested on a Mac |

`expo-speech-recognition` is the only maintained module, with a release line for SDK 57, that
writes the recording **and** feeds the recognizer from one `AVAudioEngine` tap. The alternatives
would need two clients on the microphone at once, which is fragile on iOS. It runs with
`requiresOnDeviceRecognition: true`, so no audio or text goes to Apple's servers.

The cost: it uses `SFSpeechRecognizer`, not iOS 26's `SpeechAnalyzer`. That's acceptable for
an English preview. Two trade-offs follow:

- It records **uncompressed WAV** (we ask for 16 kHz mono 16-bit: ~1.9 MB a minute, which is
  also Whisper's native input). One note can be up to ~1 h 45 min, the server's 200 MB limit.
  Compressing on device (or on the server) is a possible follow-up.
- The recognizer can end a session on its own, for example after a long silence. The phone then
  starts a new segment at once. The gap is a fraction of a second, usually in silence.

When speech recognition is **denied** or **can't run on device**, the phone records with
**expo-audio** instead (AAC `.m4a`, no live draft). The bullet then reads "Voice note, 3:12"
until the home transcript replaces it.

## How a recording is kept safe

- Each stretch of recording (from start or Resume to Pause) is its own WAV file in
  `Documents/recordings/session-<id>/`. Send joins them into `Documents/recordings/<id>.wav`,
  computing its SHA-256 on the way (any size). Then it saves the bullet, the attachment, the draft
  transcript and the outbox op in one transaction. Upload is the existing resumable
  `PUT /sync/audio/:id`.
- **Paths are stored relative to Documents.** `local_path` is `recordings/<id>.wav`, because
  iOS changes the app container's absolute path on every update or reinstall. Resolve it with
  `recordingUri()` (`apps/mobile/src/sync/runtime.ts`) before reading or playing it. Older rows that hold an
  absolute path still resolve: by the path while it exists, else by file name. A recording that
  can't be read is skipped in the upload pass (the reason is noted under the sync-state key
  `audio_read_error:<id>`), so it never holds back later recordings.
- **Only real interruptions pause.** iOS "inactive" moments keep recording: Control Center,
  Notification Center, a call banner, a Face ID or Siri prompt. A call or Siri taking the
  microphone, another app's audio, or the app going to the background pauses. The current
  segment ends with its file complete. The timer freezes and the screen shows "Recording paused.
  Everything so far is saved." with **Resume** and **Send what you have**. It never resumes by
  itself. Resume waits until the paused segment's file is closed (a few hundred ms), so two
  native sessions never overlap. The screen stays awake while recording, so auto-lock doesn't end
  a long ramble.
- **Crash or kill:** the segment files and a `meta.json` (links, draft so far, start time) stay
  on disk. A WAV whose header was never finalised is repaired from its file size. At the next
  launch, once the first screen is up and idle, `recoverRecordings` saves each leftover as a
  voice capture and skips any already saved; starting a recording runs it too. One run at a time
  (a second call joins the first), and the recording in progress is always skipped. Joining and
  hashing hand the JS thread back every 8 MB, so a long leftover never freezes the screen.
  Recordings made with expo-audio (`.m4a`) can't be recovered after a kill.
- **Cancel** asks first once more than ~10 seconds were recorded, then deletes the files.

## Permissions

The first tap on the mic shows the explanation screen. **Allow microphone** triggers the two iOS
prompts: microphone, then speech recognition. **Type instead** goes back and starts typing.
Speech recognition is optional. Without it, the phone records without a draft. If the
microphone is off, the screen offers **Open Settings**. The usage strings are set in `app.json`
through the `expo-speech-recognition` and `expo-audio` config plugins.

## Build it for your iPhone (development build)

Voice uses native modules, so it **does not run in Expo Go**. You need a development build once,
and again whenever native modules or `app.json` plugins change. JS changes reload as usual.

**With EAS (no Mac needed):**

```bash
npm install --global eas-cli
```

```bash
cd apps/mobile && eas login
```

```bash
cd apps/mobile && eas device:create
```

Open the link it prints on the iPhone to register the device.

```bash
cd apps/mobile && eas build --platform ios --profile development
```

You need a paid Apple Developer account. EAS manages the signing. Install the build from the link
or QR code EAS shows, then turn on **Settings → Privacy & Security → Developer Mode** on the
iPhone. Start the bundler on the computer; the dev build connects to it:

```bash
cd apps/mobile && npx expo start
```

**On a Mac with Xcode:** plug the iPhone in, then run:

```bash
cd apps/mobile && npx expo run:ios --device
```

`eas.json` profiles: `development` is an internal dev client for a real device.
`development-simulator` is for the iOS Simulator (its microphone and on-device recognition are
unreliable, so test voice on the iPhone). `preview` is an internal release build. `production` is for
the App Store.

## What only a device can verify

- The live draft appears while speaking and scrolls. The first use may download Apple's
  English on-device model.
- Pause/Resume, a phone call, Siri and backgrounding each pause the recording and keep every
  stretch. Control Center and banners do not pause it. Send then joins the stretches into one
  playable WAV.
- The `.m4a` fallback notices a call pausing it (it watches the recorder's state).
- Killing the app mid-recording, then relaunching, saves the recovered recording: the note
  appears in the Journal without opening the recorder, and the splash isn't held up by it.
- With speech recognition denied in Settings, the phone records an `.m4a` without a draft.
- The recording uploads to the home server and Whisper's transcript replaces the draft.
- The haptic, the "Saved" on the capture page, and VoiceOver labels on the controls and timer.
