# Getting started

One ordered path from a fresh clone to using Bullet on your iPhone and in a browser. It links to
the reference docs instead of repeating them: [`home-server.md`](./home-server.md) (every flag and
variable), [`voice-capture.md`](./voice-capture.md) (the phone's recorder and dev build) and
[`contract.md`](./contract.md) (states and sync).

Steps marked **OWNER ONLY** need you: an account, a signature, a device in your hand, or a
download. Everything else is a command to paste. The commands assume the repo is at `~/bullet`
(adjust) and the models are in `~/models`.

## 0. What you end up with

```
iPhone (Bullet app)  ──┐                       ┌── llama-server (chat)      127.0.0.1:8080
                       ├─ Tailscale HTTPS ──►  ├── llama-server (embeddings) 127.0.0.1:8082
browser (web app)    ──┘   bullet server       ├── whisper-server (speech)   127.0.0.1:8081
                           127.0.0.1:3001      └── SQLite DB + audio dir
```

Only the bullet server (port 3001) is reachable from your devices, only over your tailnet, and
only with a device token. Everything else stays on loopback.

## 1. Home machine

### 1.1 Prerequisites

Node 24 (see `.nvmrc`), pnpm 10, git, `cmake`, `ninja`, a C++ compiler, the Vulkan headers and
`glslc` (or CUDA, or Metal on a Mac), **`ffmpeg`** (whisper-server needs it to read the
phone's recordings) and the `sqlite3` command-line tool (for backups). Then, in the repo:

```bash
pnpm install
```

If you switch Node versions later, run `pnpm rebuild better-sqlite3`.

### 1.2 Build llama.cpp and whisper.cpp

Exact commands: [`home-server.md` section 1](./home-server.md#1-build-llamacpp-and-whispercpp). In
short, clone both into `~/src` and build `llama-server`, `whisper-server` and `whisper-cli` with
`-DGGML_VULKAN=ON`. The binaries end up in `~/src/llama.cpp/build/bin/` and
`~/src/whisper.cpp/build/bin/`.

### 1.3 Models (OWNER ONLY: downloads)

Put these in `~/models` (the reference machine already has the first three):

| File                                   | Used for                                                           | Size   |
| -------------------------------------- | ------------------------------------------------------------------ | ------ |
| `Qwen3.5-4B-Q4_K_M.gguf`               | The default chat model, and the embedder at first                  | 2.7 GB |
| `whisper/ggml-large-v3-turbo-q5_0.bin` | Speech-to-text (download command in section 2 of `home-server.md`) | 550 MB |
| `gemma-4-26B_q4_0-it.gguf`             | Optional: the bigger model for the nightly run (see section 6)     | 14 GB  |

### 1.4 Start the model servers

Each one runs in its own terminal (or a systemd user service, tmux pane, and so on). They all bind
to loopback. What each flag does is in `home-server.md` (sections 3, 3b and 4).

Chat model (port 8080):

```bash
~/src/llama.cpp/build/bin/llama-server --host 127.0.0.1 --port 8080 -m ~/models/Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b-q4_k_m -ngl 99 -c 16384 -np 1 -fa on --reasoning off --no-mmproj
```

Embeddings, a second instance of the same file (port 8082), for connections and themes:

```bash
~/src/llama.cpp/build/bin/llama-server --host 127.0.0.1 --port 8082 -m ~/models/Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b-q4_k_m --embeddings --pooling mean -ngl 99 -c 4096 -np 1 --no-mmproj
```

Speech (port 8081). The temp directory must exist and be private:

```bash
mkdir -p ~/.cache/whisper-server && chmod 700 ~/.cache/whisper-server
```

```bash
~/src/whisper.cpp/build/bin/whisper-server --host 127.0.0.1 --port 8081 -m ~/models/whisper/ggml-large-v3-turbo-q5_0.bin --convert --tmp-dir ~/.cache/whisper-server -t 8
```

Check the chat server: `curl -s http://127.0.0.1:8080/health` should print `{"status":"ok"}`.

### 1.5 Configure and build

```bash
cp apps/server/.env.example apps/server/.env
```

The example file points at ports 8080 and 8081. Uncomment and set the embedding server in
`apps/server/.env`:

```
EMBED_BASE_URL=http://127.0.0.1:8082
EMBED_MODEL=qwen3.5-4b-q4_k_m
```

Every variable is documented in
[`home-server.md` section 5](./home-server.md#5-start-the-bullet-server).

Build the web app, then start the bullet server. Build the web app **first**: the server looks for
`apps/web/dist` when it starts.

```bash
pnpm --filter web build
```

```bash
pnpm --filter server start
```

It prints the LLM, nightly, embeddings, Whisper and web-app lines it will use, then
`bullet server listening on http://127.0.0.1:3001`. Warnings (`[embed]`, `[whisper]`) mean a model
server is not answering or `ffmpeg` is missing; see Troubleshooting. Data goes to
`apps/server/data/` (the database and the audio folder).

## 2. Tailscale

**OWNER ONLY: Tailscale admin.** Install Tailscale on the home machine and on the iPhone and sign
both in to the same tailnet. In the admin console (DNS), enable **HTTPS certificates** for the
tailnet. Then on the home machine:

```bash
tailscale serve --bg 3001
```

```bash
tailscale serve status
```

`serve status` prints your address, `https://<machine>.<tailnet>.ts.net`. That is the server URL
for the phone and the browser. Never use `tailscale funnel` (it publishes to the internet). Stop
serving with `tailscale serve --https=443 off`.

## 3. Device tokens

Each device gets its own token. Run these on the home machine; each token is printed **once** and
stored hashed, so copy it straight away.

```bash
pnpm --filter server device:add "My iPhone"
```

```bash
pnpm --filter server device:add "My browser"
```

`device:list` shows the devices, and `device:revoke <device-id>` cuts one off (a lost phone, a
shared browser). Send the phone its token through something private (a password manager, not a
chat).

## 4. iPhone

### 4.1 Accounts (OWNER ONLY)

- An **Apple Developer** account (paid). Without it the app cannot be signed for a real device.
- An **Expo** account (free) for EAS builds.

### 4.2 Build the development build (OWNER ONLY: signing, device install)

Voice uses native modules, so the app does not run in Expo Go. The full explanation is in
[`voice-capture.md`](./voice-capture.md#build-it-for-your-iphone-development-build). The steps:

```bash
npm install --global eas-cli
```

Run these from the `apps/mobile` folder (`cd apps/mobile` once; the next three blocks stay there):

```bash
cd apps/mobile
```

```bash
eas login
```

Register the iPhone (open the link it prints on the iPhone, install the profile):

```bash
eas device:create
```

Build (the first run asks to create or link the Expo project and to sign in to your Apple account,
and EAS manages the certificates):

```bash
eas build --platform ios --profile development
```

Install the build from the link or QR code EAS prints, on the iPhone. Then turn on
**Settings → Privacy & Security → Developer Mode** and restart when asked. With a Mac and Xcode you
can instead run `npx expo run:ios --device` in `apps/mobile`.

Go back to the repo root for the rest of this guide (`cd ../..`).

A development build loads its JavaScript from the bundler, so start it on the computer and open
the app. Run it from the repo root:

```bash
pnpm dev:mobile
```

The iPhone must be able to reach the computer running the bundler (the same network), or start it
with `npx expo start --tunnel` from `apps/mobile`.

The build can also be made with the `preview` profile (`eas build --platform ios --profile
preview`, run from `apps/mobile`), an internal release build that carries its own JavaScript and needs no bundler; use it
once you stop changing the code.

### 4.3 First run and pairing

1. Open Bullet. The first screen is **Connect your home server**.
2. Enter the server address (`<machine>.<tailnet>.ts.net`, from section 2) and paste the iPhone's
   token, then tap **Connect**. The phone checks the token against the server.
3. Or tap **Not yet**: you land on Capture, captures stay on the phone, and you can pair later: open
   the Settings sheet (the gear in the Journal header) and tap **Pair a home server**, or tap the
   status line on the Capture page. Nothing is lost.

The iPhone must be connected to Tailscale to reach the server. Without it, captures queue on the
phone and send themselves later.

### 4.4 Microphone permission

Tap the mic on the capture screen. A short explanation appears; **Allow microphone** triggers two
iOS prompts, microphone and speech recognition. Speech recognition is optional: without it the
phone records with no live draft and the home server still transcribes. If you answered No, use
**Open Settings** on that screen (or iOS Settings → Bullet). The checklist of what only the device
can verify is at the end of `voice-capture.md`.

## 5. Browser

The web app is served by the bullet server itself, so use the same address as the phone.

1. Open `https://<machine>.<tailnet>.ts.net/` in a browser on a device that is on the tailnet
   (or `http://127.0.0.1:3001/` on the home machine).
2. Paste the browser's token (the second one from section 3) and press **Connect**. The address is
   pre-filled with the one you came from.
3. The browser keeps a local copy of the journal in IndexedDB. **Settings → Reset local copy** or
   **Unpair** wipes it and rebuilds it from the server. Ctrl/Cmd+Enter sends a capture.

Details, including what the token's storage exposes, are in
[`home-server.md` section 6b](./home-server.md#6b-the-web-app-at-your-desk). After you rebuild the
web app, restart the bullet server and reload the page.

## 6. Optional

- **A dedicated embedding model** (OWNER ONLY: download). nomic-embed-text v1.5 (~140 MB GGUF) or
  bge-m3 (better Arabic and French). Start it like the embedding server in 1.4 (own `-m`, port 8082) and set `EMBED_MODEL` to its name. Changing the model re-embeds your thoughts. See
  [`home-server.md` section 3b](./home-server.md#3b-start-the-embedding-server-connections-and-themes)
  for the profiles and thresholds.
- **A bigger model for the nightly run** (OWNER ONLY: the 14 GB download). Start a third
  llama-server with `gemma-4-26B_q4_0-it.gguf` on port 8083 (use `-c 8192` if memory is tight) and
  set, in `apps/server/.env`:

  ```
  LLM_NIGHTLY_BASE_URL=http://127.0.0.1:8083
  LLM_NIGHTLY_MODEL=<its --alias>
  ```

  The nightly run (02:00 in the server's `TZ`) names themes and reviews links; captures keep
  using the small model.

- **Auto-apply value records.** By default a reading with a value (mood 4, 5 km) waits for a tap.
  Set `AUTO_APPLY_VALUE_RECORDS=true` in `apps/server/.env` to let confident ones apply by
  themselves, with Undo. Restart the server.

## 7. Backups

Two things hold your journal on the home machine, both under `apps/server/data/` unless you moved
them with `DB_PATH` and `AUDIO_DIR`:

- the database, `bullet.db` (SQLite in WAL mode, so do not just copy the one file while the server
  runs);
- the audio folder, `audio/`: every voice recording, kept forever.

Run these from the repo root. A consistent database copy while the server is running:

```bash
sqlite3 apps/server/data/bullet.db ".backup '$HOME/backups/bullet-$(date +%F).db'"
```

```bash
rsync -a apps/server/data/audio/ ~/backups/bullet-audio/
```

Copy them somewhere off the machine, encrypted: this is intimate data. The phone and the browser
hold copies of the journal too, but treat the server as the source of truth. Keep the model files
out of the backup; they can be downloaded again.

## 8. Troubleshooting

**The phone or browser cannot reach the server.**
Check from the home machine first: `curl -s -H "authorization: Bearer <token>"
http://127.0.0.1:3001/health` (every route needs the token, `/health` included). If that works:
`tailscale serve status` must list `3001`; Tailscale must be connected on the device; the address
must be the `https://…ts.net` name, not the loopback one; the token must be that device's (a wrong
or revoked one is refused with 401). Both the phone and the browser say whether the problem is the
network or the token.

**`ffmpeg` is missing.**
The bullet server warns at start (`[whisper] WARNING: ffmpeg is not on the PATH`). whisper-server
runs `ffmpeg` too, so install it (for example `pacman -S ffmpeg`) and restart whisper-server from a
shell where `ffmpeg -version` works.

**Transcription fails (`transcription_failed` on a voice note).**

- `WHISPER_BASE_URL` must be set in `apps/server/.env` (unset means device drafts only) and
  whisper-server must be running with `--convert`.
- `"FFmpeg conversion failed."` is also what an unwritable `--tmp-dir` or a missing `ffmpeg` produces,
  not only a damaged file; fix those first. The server logs `[whisper] WARNING: 3 recordings in a
  row failed ffmpeg conversion` when it keeps happening.
- A failed voice note is retryable from the app. Judge Whisper on your own clips with
  `pnpm --filter server eval:transcribe` (see `home-server.md`).

**Captures stay "processing" for a long time.**
A three-thought capture took about a minute on the reference machine; the phone never waits on it.
Check the chat server answers `/health`, and raise `LLM_TIMEOUT_MS` for a slower model.

**No connections or themes.**
The server warns `[embed] … is not answering` at start when the embedding server (8082) is down;
captures still process, links wait.

More: `home-server.md`, `voice-capture.md` and `contract.md` (what each state and error code
means).

## Owner-only steps, at a glance

1. Download the models into `~/models` (and any optional ones).
2. Tailscale: install on both devices, sign in, enable HTTPS certificates in the admin console.
3. Create the Apple Developer account and the Expo account.
4. `eas login`, `eas device:create`, `eas build`: sign the build and install it on the iPhone, then
   enable Developer Mode.
5. Allow the microphone (and speech recognition) on the iPhone.
6. Copy the two device tokens to the devices.
7. Set up the backup destination.
