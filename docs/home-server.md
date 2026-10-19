# Running the home server

The home server is three processes on one machine, all bound to `127.0.0.1`:

| Process                     | Port | What it does                                                    |
| --------------------------- | ---- | --------------------------------------------------------------- |
| `llama-server`              | 8080 | The LLM: splits captures into thoughts, extracts things         |
| `whisper-server`            | 8081 | Speech-to-text for voice notes (mixed en / ar-LB / fr)          |
| `llama-server --embeddings` | 8082 | Embeddings for connections and themes (slice 3), see section 3b |
| bullet server               | 3001 | Sync API for the phone, the job queue, the apply engine         |

Only the bullet server is ever reachable from the phone, and only through Tailscale over HTTPS.
The model servers never leave loopback. Journal text and recordings stay on this machine.

## Reference machine

Tested on (2026-10-18): Intel Core Ultra 5 235HX, integrated Arc graphics (Arrow Lake, no
discrete GPU), 62 GB RAM, Linux. Both model servers use the iGPU through **Vulkan** (shared
memory, so RAM is the limit, not VRAM).

| Role          | Model                          | Size   | Measured here                                                                      |
| ------------- | ------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| LLM (default) | `Qwen3.5-4B-Q4_K_M.gguf`       | 2.7 GB | ~80 tok/s prompt, ~8 tok/s generation; a three-thought capture took about a minute |
| LLM (bigger)  | `gemma-4-26B_q4_0-it.gguf`     | 14 GB  | not benchmarked yet; expect better extraction and slower jobs                      |
| Speech        | `ggml-large-v3-turbo-q5_0.bin` | 550 MB | ~1× real time (11 s clip ≈ 10 s)                                                   |

Processing is asynchronous: the phone never waits on these numbers, it only sees a bullet stay in
`processing` longer. Raise `LLM_TIMEOUT_MS` if you move to a slower model.

## 1. Build llama.cpp and whisper.cpp

Needs `cmake`, `ninja`, a C++ compiler, the Vulkan headers and `glslc` (Arch: `vulkan-headers`,
`shaderc`), and `ffmpeg` (whisper-server uses it to read the phone's M4A recordings).

```bash
mkdir -p ~/src && cd ~/src
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
```

```bash
cd ~/src/llama.cpp && cmake -B build -G Ninja -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF && cmake --build build --target llama-server
```

```bash
cd ~/src/whisper.cpp && cmake -B build -G Ninja -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build --target whisper-server whisper-cli
```

On an NVIDIA box use `-DGGML_CUDA=ON` instead of Vulkan; on a Mac, Metal is the default.

## 2. Models

The LLMs live in `~/models`. The Whisper model (~550 MB):

```bash
mkdir -p ~/models/whisper && curl -L -o ~/models/whisper/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

The unquantized `ggml-large-v3-turbo.bin` (1.6 GB) is the same model at f16; q5_0 is close in
quality and faster on CPU / iGPU. To try an Arabic-dialect fine-tune, convert its Hugging Face
checkpoint with whisper.cpp's `models/convert-h5-to-ggml.py` and compare it with the eval script
(below) before switching.

## 3. Start llama-server

```bash
~/src/llama.cpp/build/bin/llama-server --host 127.0.0.1 --port 8080 -m ~/models/Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b-q4_k_m -ngl 99 -c 16384 -np 1 -fa on --reasoning off --no-mmproj
```

Why these flags:

- `--host 127.0.0.1`: loopback only. Add `--api-key …` (and `LLM_API_KEY`) if anything else
  shares the machine.
- **Structured output needs no flag.** The bullet server sends
  `response_format: { type: 'json_schema', … }`; llama-server compiles the schema into a grammar
  that constrains decoding. Keep the default Jinja chat template (`--jinja` is on by default).
- `--reasoning off`: the extraction prompts expect a direct JSON answer; thinking tokens only add
  latency (at ~8 tok/s, a lot of it).
- `-c 16384 -np 1`: the worker runs one job at a time, so one slot gets the whole context. A
  capture's prompt measured ~900 tokens; the headroom covers long captures, the snapshot of
  existing tasks/trackers, and the repair call. For Gemma 26B, `-c 8192` is enough if memory is
  tight.
- `-ngl 99 -fa on`: offload every layer to the GPU and use flash attention.
- `--no-mmproj`: text only; skips loading a vision projector.
- `--alias`: the name shown in responses; set `LLM_MODEL` to the same string so logs match.

Check it: `curl -s http://127.0.0.1:8080/health` → `{"status":"ok"}`.

## 3b. Start the embedding server (connections and themes)

Slice 3 links thoughts across captures and finds recurring themes from **embeddings**, served by
llama-server's OpenAI-compatible `/v1/embeddings`. A llama-server started with `--embeddings`
serves only embeddings (its chat endpoints are off), so it is a **second instance**. Nothing needs
downloading: it can run the same Qwen file as the chat server.

```bash
~/src/llama.cpp/build/bin/llama-server --host 127.0.0.1 --port 8082 -m ~/models/Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b-q4_k_m --embeddings --pooling mean -ngl 99 -c 4096 -np 1 --no-mmproj
```

Then in `apps/server/.env`: `EMBED_BASE_URL=http://127.0.0.1:8082` and
`EMBED_MODEL=qwen3.5-4b-q4_k_m`. It loads a second copy of the model (another ~2.7 GB of shared
memory); one embedding takes a few tens of milliseconds, so it never slows extraction.

**Later, your choice:** a dedicated small embedding model (nomic-embed-text v1.5, ~140 MB as
GGUF; or bge-m3 for better Arabic/French) is faster, lighter and separates topics better than a
chat model. Download it only if you want to; point `EMBED_MODEL` at its name (anything without
qwen/gemma/llama/mistral/phi in it reads as a dedicated model and uses the spec's thresholds) and
start it the same way. Changing the model re-embeds every thought: links and themes made since
use the new vectors (older links stay).

### How similarity is read (calibration)

The vector of each thought is stored with the embedder's name and template
(`thought_embeddings.model`); another name means it is embedded again.

| Profile (`EMBED_PROFILE`) | For                                     | Scores                   | Link | Shared name | "Answers?" check | Connection question |
| ------------------------- | --------------------------------------- | ------------------------ | ---- | ----------- | ---------------- | ------------------- |
| `dedicated`               | nomic-embed-text, bge, e5…              | raw cosine               | 0.80 | 0.75        | ≥ 0.70           | 0.65 – link         |
| `llm` (default for Qwen)  | a chat model used as embedder (Qwen 4B) | centred cosine, template | 0.40 | 0.35        | ≥ 0.30           | 0.28 – link         |

The spec's numbers assume a dedicated model. Measured on Qwen3.5-4B Q4_K_M (2026-10-19, a
calibration set of 40 journal-style thoughts on 10 topics plus 30 unrelated lines; pairs within a
topic vs across topics):

- **Raw cosine is unusable with a chat model.** Unrelated thoughts score 0.72 on the median (up to
  0.91), related ones 0.78. At the spec's 0.80: 39% of related pairs linked, but so were 11% of
  unrelated ones (about 2 false links for every true one). Cross-language pairs (Arabizi or French
  against English) scored 0.39–0.45: below any threshold.
- **Two fixes, both automatic in the `llm` profile:** each thought is embedded inside a short
  template, `This journal note : "…" is about, in one word:"` (the PromptEOL trick: the model's
  answer-state summarises the topic), and vectors are **centred**: a mean is subtracted before
  comparing, a fixed blend of the 36 everyday background lines (embedded once per model) and the
  user's own live thoughts, the journal weighing by its size but **never more than half**. Then at
  0.40: 39–53% of related pairs linked against 0.5–3.7% of unrelated ones (the higher numbers with
  the background alone, the lower ones with the journal at about half). The cap keeps a journal of
  10 000 thoughts reading the thresholds the same way as one of 50. `--pooling last` scored about
  the same as `mean`; `mean` is kept.
- Below the link threshold the open-loop "answers?" check (a yes/no model call) and the connection
  question catch more: they read the words, not only the vectors.

**Live check (2026-10-19, Qwen3.5-4B for chat and embeddings, 16 synthetic captures over 11
simulated days: rent, sleep, Karim, a bank question, a passport loop, a podcast idea).** A link job
took ~0.8 s after `processed` (30 s for the very first, which embeds the background lines). 17
links: 15 clearly right (landlord / rent, Karim ×3, sleep ×2, passport loop ↔ its answer,
podcast idea ↔ its restatement as `revisits`, bank question ↔ moving the account), 2 loose
("Should I switch banks?" and "The fees are crazy" ↔ "Can we even afford this flat?": money, not
the same thing). Misses: nothing linked "can't sleep, mind racing about money" to the sleep
thoughts. The nightly run (42 s) reviewed all 17, removed none, and called too many links
`same_entity` (a 4B model reads "same subject" as "same thing"); a bigger `LLM_NIGHTLY_MODEL` should
do better. One theme, named "the rent" in the user's words, 8 thoughts over 7 days, but chained
through the loose money links it also took in the two bank thoughts; sleep (3 thoughts) and Karim (3)
stayed under the 4-thought rule. One Noticed card: "«I'm worried the landlord will raise the rent
again.» · came up 8 times in 12 days". The "answers?" check, on 7 hand-made pairs, got the 4
answers (English, Arabizi) and 2 of 3 non-answers; it said yes to a French complaint about bank
fees for "should I change banks?" (the user still decides: it is only a suggestion). In this run the
passport loop was classified a `task`, not `to_check`, so no "Did this close it?" was offered.

Override any number with `LINK_THRESHOLD`, `LINK_ENTITY_THRESHOLD`, `ANSWER_CHECK_THRESHOLD`,
`CONNECTION_QUESTION_THRESHOLD`, `LINK_REVIEW_BELOW` (the nightly review checks links scoring
below it first, and removes one it finds unrelated).

## 4. Start whisper-server

```bash
mkdir -p ~/.cache/whisper-server && chmod 700 ~/.cache/whisper-server
```

```bash
~/src/whisper.cpp/build/bin/whisper-server --host 127.0.0.1 --port 8081 -m ~/models/whisper/ggml-large-v3-turbo-q5_0.bin --convert --tmp-dir ~/.cache/whisper-server -t 8
```

- `--convert` is required: the phone uploads AAC/M4A and whisper-server otherwise reads WAV
  only. It shells out to `ffmpeg`, which must be on the `PATH`.
- **Language is never forced.** whisper-server defaults to English, so the bullet server sends
  `language=auto` on every request. Whisper detects **one** language per recording (from the
  first 30 s); a note that switches between Arabic, English and French is still transcribed as
  one piece, but the detected language is only the dominant one. Judge the quality on your own
  clips with the eval script before relying on it.
- `--tmp-dir`: where `--convert` writes each recording while converting it. The default is the
  directory you started the server from, and a recording ffmpeg can't decode is **left there**
  (a copy of a journal recording in a random directory). Use a private directory. It must be
  writable: an unwritable `--tmp-dir`, or ffmpeg missing from whisper-server's `PATH`, fails
  every recording with the same `"FFmpeg conversion failed."` a damaged file gets, so each voice
  note shows `transcription_failed`.
- `-t 8`: CPU threads for the parts that do not run on the GPU.

## 5. Start the bullet server

```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` (git-ignored; `start`, `dev` and the `device:*` scripts load it):

| Variable                   | Default                 | Notes                                                                                                                                                              |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST`                     | `127.0.0.1`             | Keep loopback; Tailscale serve proxies to it                                                                                                                       |
| `PORT`                     | `3001`                  |                                                                                                                                                                    |
| `DB_PATH`                  | `./data/bullet.db`      | Relative to `apps/server`                                                                                                                                          |
| `AUDIO_DIR`                | `./data/audio`          | Recordings, kept forever. Back this up with the DB                                                                                                                 |
| `WEB_DIR`                  | `../web/dist`           | The built web app served at `/` (section 6b); relative to `apps/server`. Not built = API only                                                                      |
| `LLM_BASE_URL`             | `http://127.0.0.1:8080` | llama-server root                                                                                                                                                  |
| `LLM_MODEL`                | `default`               | Label sent as `model`; match `--alias`                                                                                                                             |
| `LLM_API_KEY`              | unset                   | Only if llama-server has `--api-key`                                                                                                                               |
| `LLM_TIMEOUT_MS`           | `120000`                | Per model call; `180000` suits the iGPU                                                                                                                            |
| `WHISPER_BASE_URL`         | unset                   | Unset = no server transcription (device drafts only)                                                                                                               |
| `WHISPER_MODEL`            | `large-v3-turbo`        | Recorded on each server transcript                                                                                                                                 |
| `WHISPER_PROMPT`           | unset                   | Optional initial prompt (names, spelling style)                                                                                                                    |
| `TRANSCRIBE_TIMEOUT_MS`    | `600000`                | Per recording                                                                                                                                                      |
| `AUTO_APPLY_VALUE_RECORDS` | `false`                 | `true`: confident readings with a value (mood 4, 5 km) apply automatically, with Undo; otherwise they wait for a tap                                               |
| `LLM_NIGHTLY_MODEL`        | unset                   | The model for the nightly run (theme names, link review); unset = `LLM_MODEL`                                                                                      |
| `LLM_NIGHTLY_BASE_URL`     | unset                   | Its llama-server, if it is another one (e.g. Gemma 26B on 8083); unset = `LLM_BASE_URL`                                                                            |
| `EMBED_BASE_URL`           | `LLM_BASE_URL`          | The llama-server started with `--embeddings` (section 3b); the chat server alone answers 501, so links wait. Unset: the `llm` profile, whatever `EMBED_MODEL` says |
| `EMBED_MODEL`              | `LLM_MODEL`             | Stored with every vector; a new name re-embeds. Also picks the profile                                                                                             |
| `EMBED_PROFILE`            | from the URL and model  | `llm` (centred, calibrated for Qwen) or `dedicated` (the spec's raw-cosine thresholds)                                                                             |
| `EMBED_TIMEOUT_MS`         | `60000`                 | Per embedding request                                                                                                                                              |
| `TZ`                       | the system zone         | The nightly run is at 02:00 in this zone                                                                                                                           |

Create a token for the phone (shown once; it is stored hashed):

```bash
pnpm --filter server device:add "My iPhone"
```

Start:

```bash
pnpm --filter server start
```

It logs the LLM, nightly, embedding and Whisper endpoints it will use, and warns at startup when
the embedding server does not answer (connections then wait; everything else works). With `WHISPER_BASE_URL` set, it also warns at
startup when `ffmpeg` is not on its own `PATH` (whisper-server usually shares it), and logs
`[whisper] WARNING: 3 recordings in a row failed ffmpeg conversion…` when conversions keep
failing: that is the setup, not the recordings. Every route needs the token, `/health` included:

```bash
curl -s -H "authorization: Bearer $BULLET_TOKEN" http://127.0.0.1:3001/health
```

`pnpm --filter server device:list` and `device:revoke <id>` manage tokens.

## 6. Reach it from the phone over Tailscale

The bullet server stays on `127.0.0.1`. `tailscale serve` terminates HTTPS with a certificate for
the machine's tailnet name and proxies to loopback, so only devices on your tailnet can reach it,
and the token is still required.

```bash
tailscale serve --bg 3001
```

```bash
tailscale serve status
```

The phone's server URL is the `https://<machine>.<tailnet>.ts.net` address that `serve status`
prints. HTTPS certificates must be enabled for the tailnet (admin console → DNS → HTTPS
certificates); `tailscale serve` explains how if they are not. To stop serving:

```bash
tailscale serve --https=443 off
```

Do **not** use `tailscale funnel`: it publishes the server to the internet.

## 6b. The web app at your desk

`apps/web` is the desk companion to the phone: read the Stream and Inbox on a big screen, work
through decisions in batches, type longer captures on a real keyboard. It is a static app that the
bullet server serves itself, so the only thing that ever leaves the page is its sync calls to this
same server (no CDN, no analytics, no remote fonts; the page's Content-Security-Policy enforces it).

```bash
pnpm --filter web build          # writes apps/web/dist
pnpm --filter server start       # logs "web app: serving …/apps/web/dist at /"
```

Open the same address you use for the phone (`https://<machine>.<tailnet>.ts.net/` over Tailscale
serve, or `http://127.0.0.1:3001/` on the machine itself). The page and its files are public to
whoever can reach the server, and hold no data; the sync API paths still require a bearer token on
every request.

1. Create a token for the browser (each device has its own):
   `pnpm --filter server device:add my-browser`.
2. Open the app, paste the token, press Connect. The address is pre-filled with the one you came
   from; it must be this server (the page may only talk to its own origin).
3. The browser keeps a **local copy** of the journal (SQLite compiled to WebAssembly, saved in
   IndexedDB). It is a cache of the server plus any change the server has not confirmed yet.
   **Settings → Reset local copy** or **Unpair** wipes it, and the next full pull rebuilds it; a
   change that had not reached the server is lost with it, and the buttons say so first.
   Only one tab of a browser opens the local copy at a time (Web Locks on https/localhost, a
   BroadcastChannel ping on plain http). A capture shows "Saved" only once it is stored in
   IndexedDB, and the browser asks before the tab closes with anything unsaved. If a stored copy
   cannot be read, a backup of it is kept and a fresh one is rebuilt from the server.
4. **The token lives in this browser's `localStorage`**, so a script injected into the page could
   read it; XSS is the remaining exposure. The page ships no third-party scripts and its
   Content-Security-Policy (`script-src 'self'`, no inline script or style, `connect-src 'self'`)
   is what limits that. Revoke a lost browser's token with `pnpm --filter server device:revoke`.

For development, `pnpm dev:web` runs Vite and forwards `/sync` and `/health` to
`BULLET_SERVER_URL` (default `http://127.0.0.1:3001`), so enter `http://localhost:5173` as the
address there. Over plain `http` on a tailnet address the app still works (ids fall back to
`getRandomValues`, the one-tab check to a BroadcastChannel); https is still better.

## Judging Whisper on your own voice

Put 10 or so of your own clips (M4A from the phone, or MP3/WAV) in `apps/server/eval/clips/`.
`apps/server/eval/` is git-ignored: never commit recordings or transcripts.

```bash
pnpm --filter server eval:transcribe --server turbo=http://127.0.0.1:8081
```

This writes `apps/server/eval/out/transcripts.md` (per clip: each model's text, detected
language, time) and `transcripts.json`. To compare two models, run a second whisper-server with
the other model on port 8082 and pass both:

```bash
pnpm --filter server eval:transcribe --server turbo=http://127.0.0.1:8081 --server arabic-ft=http://127.0.0.1:8082
```

Other options: `--in <dir>`, `--out <dir>`, `--prompt "<initial prompt>"` (applies to every
server; run twice to compare with and without), `--timeout-ms`.

## Connections and the nightly run

- After a capture's things are stored, a **link job** embeds its thoughts and links them to earlier
  ones (seconds; before the capture's reflective question). An open loop close to it gets one
  yes/no call to the live model.
- At **02:00 server time** (`TZ`) the worker runs the **nightly** pass when nothing else is waiting:
  re-embeds thoughts after a model change, reviews up to 40 uncertain links, finds themes, names new
  ones (one short call each) and writes at most 2 Noticed cards. After downtime it runs once to catch
  up; every limit is checked against the database, so a week offline still gives at most 8 active
  themes and 2 cards. `nightly_runs` records each run and its counts.
- **The nightly run never holds a capture back.** Between model calls, embedding batches (32) and
  chunks of the similarity matrix (200 rows) it checks whether an extraction, link or reflect job is
  waiting; if so it stops (`yielded`: what it did is kept, every step is idempotent and the caps are
  re-checked) and is offered again as soon as the queue is empty. A failed run waits an hour.
- **Links are add-only.** A link is made once, by its capture's link job (or a "Same thing"), and is
  never re-scored when the mean drifts or a model changes; it goes only when the user vetoes it, a
  nightly review finds it unrelated, or one of its thoughts goes. Themes, by contrast, are recomputed
  every night from the current vectors.
- **Volume.** Linking a capture is one scan of all the user's vectors (milliseconds at thousands of
  thoughts). Theme clustering compares every pair within the 30-day window (O(n²)): about 1.7 s for
  1 500 thoughts in the window and 10 s for 3 000 on the reference machine, outside any transaction
  and in yielding chunks. Beyond ~5 000 thoughts in 30 days it would want an approximate index;
  journals are far below that. Every vector is loaded in memory (Qwen 4B: 10 KB per thought, 30 MB
  per 3 000).

## Tests

CI never touches a real model. One opt-in test runs against a live whisper-server:

```bash
WHISPER_TEST_URL=http://127.0.0.1:8081 WHISPER_TEST_AUDIO=$HOME/src/whisper.cpp/samples/jfk.mp3 pnpm --filter server exec vp test run src/whisper.integration.test.ts
```
