# Running the home server

The home server is three processes on one machine, all bound to `127.0.0.1`:

| Process          | Port | What it does                                            |
| ---------------- | ---- | ------------------------------------------------------- |
| `llama-server`   | 8080 | The LLM: splits captures into thoughts, extracts things |
| `whisper-server` | 8081 | Speech-to-text for voice notes (mixed en / ar-LB / fr)  |
| bullet server    | 3001 | Sync API for the phone, the job queue, the apply engine |

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
  (a copy of a journal recording in a random directory). Use a private directory.
- `-t 8`: CPU threads for the parts that do not run on the GPU.

## 5. Start the bullet server

```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` (git-ignored; `start`, `dev` and the `device:*` scripts load it):

| Variable                | Default                 | Notes                                                |
| ----------------------- | ----------------------- | ---------------------------------------------------- |
| `HOST`                  | `127.0.0.1`             | Keep loopback; Tailscale serve proxies to it         |
| `PORT`                  | `3001`                  |                                                      |
| `DB_PATH`               | `./data/bullet.db`      | Relative to `apps/server`                            |
| `AUDIO_DIR`             | `./data/audio`          | Recordings, kept forever. Back this up with the DB   |
| `LLM_BASE_URL`          | `http://127.0.0.1:8080` | llama-server root                                    |
| `LLM_MODEL`             | `default`               | Label sent as `model`; match `--alias`               |
| `LLM_API_KEY`           | unset                   | Only if llama-server has `--api-key`                 |
| `LLM_TIMEOUT_MS`        | `120000`                | Per model call; `180000` suits the iGPU              |
| `WHISPER_BASE_URL`      | unset                   | Unset = no server transcription (device drafts only) |
| `WHISPER_MODEL`         | `large-v3-turbo`        | Recorded on each server transcript                   |
| `WHISPER_PROMPT`        | unset                   | Optional initial prompt (names, spelling style)      |
| `TRANSCRIBE_TIMEOUT_MS` | `600000`                | Per recording                                        |

Create a token for the phone (shown once; it is stored hashed):

```bash
pnpm --filter server device:add "My iPhone"
```

Start:

```bash
pnpm --filter server start
```

It logs the LLM and Whisper endpoints it will use. Every route needs the token, `/health`
included:

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

## Tests

CI never touches a real model. One opt-in test runs against a live whisper-server:

```bash
WHISPER_TEST_URL=http://127.0.0.1:8081 WHISPER_TEST_AUDIO=$HOME/src/whisper.cpp/samples/jfk.mp3 pnpm --filter server exec vp test run src/whisper.integration.test.ts
```
