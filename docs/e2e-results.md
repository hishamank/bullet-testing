# End-to-end results: slice 1 on the real home server

The first run of the whole capture loop against real models: a headless "phone" (the mobile data
layer, sync client and HTTP transport on an in-memory SQLite) talking to the bullet server, which
talks to llama-server and whisper-server. All content is made up; the voice clips are synthetic
speech (eSpeak formant voice through the `mespeak` npm package), never a real voice.

## Setup (2026-10-19)

| Part           | What                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| Machine        | Intel Core Ultra 5 235HX, Arc iGPU (Vulkan), 62 GB RAM, Linux             |
| LLM            | `Qwen3.5-4B-Q4_K_M.gguf` on llama-server, flags as in `home-server.md`    |
| Speech         | `ggml-large-v3-turbo-q5_0.bin` on whisper-server `--convert`              |
| Bullet server  | this branch, `LLM_TIMEOUT_MS=180000`, throwaway `DB_PATH` and `AUDIO_DIR` |
| Phone timezone | `Asia/Beirut`; captures made on a Monday around 05:00 local               |

Runs: 1 on `main` (c6d9de3); 2 with the fixes below (with `BULLET_E2E_SLOW=1`); 3 after merging
`main` 884b08c (PR #29), on a fresh database; 4 and 5 on that same database, with harness fixes
(per-run unique text for the idempotency check; it found the previous run's copy).

## Running the harness

It is skipped unless `BULLET_E2E_URL` is set. Use a throwaway database: it writes captures.

```bash
pnpm --filter server device:add "E2E harness"
```

```bash
BULLET_E2E_URL=http://127.0.0.1:3001 BULLET_E2E_TOKEN=<token> pnpm --filter mobile exec vp test run src/test/e2e
```

Optional variables:

| Variable                                       | Effect                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `BULLET_E2E_SPEECH_WAV`                        | A WAV of synthetic speech; the two voice-transcript tests are skipped without it       |
| `BULLET_E2E_SPEECH_WORDS`                      | Comma-separated words its transcript must contain (default `olive`)                    |
| `BULLET_E2E_LLM_STOP` / `BULLET_E2E_LLM_START` | Shell commands that stop / start llama-server; enables the outage test                 |
| `BULLET_E2E_LLM_URL`                           | llama-server root for the health check after the restart (default `127.0.0.1:8080`)    |
| `BULLET_E2E_SLOW=1`                            | Wait out the whole retry policy (~23 min) for a damaged recording, then `bullet.retry` |
| `BULLET_E2E_REPORT`                            | JSON-lines file: latencies, transitions, every extraction, quality notes               |
| `BULLET_E2E_TZ`                                | Phone time zone (default `Asia/Beirut`)                                                |

Contract rules (states, tiers, never-auto trackers, idempotency, user edits winning) are
assertions. The model's judgement (kinds, dates, names) is recorded as quality notes, so a small
model's wobble shows in the report without failing the run.

## What passed

Runs 2 (slow mode), 3 and 5: 11 of 11; run 6 ran the added "tracker readings" test alone (passes,
see Journal). Run 1: 9 of 10 (the damaged-recording check failed, bug 1; the no-speech test was
added after it). Run 4 failed only the idempotency check, on the harness's own leftover from run 3.

- Typed ramble: `saved_local → processing → needs_review`, six thoughts with the expected kinds,
  suggestions with tiers, pulled to the phone, outbox empty.
- Mixed Arabizi / French / English: every thought keeps the user's words (`bukra lazem eb3at el
  report la Nadine`, `RDV chez le coiffeur jeudi 15h`); "bukra" → tomorrow; "jeudi 15h" → Thursday
  15:00 after fix 3.
- Voice: resumable upload in 32 KiB chunks with one dropped request (the next sync resumed at the
  server's offset), `transcribing → processing`, the Whisper transcript replaced the draft. A
  draft the user edited stayed the text, with the server transcript kept beside it.
- Inbox: a held accept stayed on the phone during its window and was retracted locally; accept,
  reject, edit-accept (the edited title was applied), undo, `question.answer` "Next Monday" (the
  event moved to the next Monday 19:00).
- Journal: resolve / unresolve, a loop note with `resolves_thought_id` closed the thought,
  `task.update` done / todo / due date, `event.update`, a refused end-before-start. The
  `tracker_entry.update` step needs a tracker, which only exists once someone answers Yes to a
  "Start tracking …?" offer; runs 1–3 never got one on the inbox capture (see quality), so from
  run 4 the harness answers Yes to any open offer. Runs 4–6 (and a dedicated
  "tracker readings" test) created the tracker, but it was named after the whole reading
  ("energy level 3 out of 5 today"), so the next reading did not match it and no entry existed
  to correct: **`tracker_entry.update` was not exercised live** (only by the unit tests).
- Editing a capture: re-processed; the user's thought kind and hand-edited event were kept, the
  removed "ran 5k" was undone and withdrawn, the new "running shoes" task was added.
- Idempotency: a push whose response was lost was resent (`duplicate`), the same op twice in one
  request, the same accept twice; a fresh phone pulled exactly one of each.
- llama-server killed while a capture was `processing`: the job failed in ~1 s with
  `llm_unavailable` and a retry 10 s later, the second capture waited, the phone kept both and an
  empty outbox. After the restart both finished (attempt 2), 95–105 s after the outage.
- No speech (a tone): `transcription_failed` "no speech", the draft stays the text (fix 2).
- Damaged audio: `transcription_failed` (fix 1). With `BULLET_E2E_SLOW=1` (run 2) it reached
  `failed` after the fifth attempt, 23 min later, and `bullet.retry` put it straight back into
  `transcribing`.

## Bugs found and fixed

1. **A damaged recording read as "transcriber not running".** With `--convert`, whisper-server
   answers audio ffmpeg can't decode with `500 {"error":"FFmpeg conversion failed."}`; every 500
   was `transcription_unavailable`. Now `transcription_failed`.
2. **A recording with no speech replaced the draft with ".".** Whisper answers a tone with `" ."`
   and blank audio with `[BLANK_AUDIO]`, which passed the empty-transcript guard. The guard now
   needs a letter or digit outside non-speech markers.
3. **"jeudi 15h" was all-day.** A bare `15h` only counted as a time after "à"/"at"; now also
   right after a weekday or "tomorrow" (Arabizi/French day words included). "slept 6h" still isn't.
4. **"Start tracking "mood 2 sur 5."?".** The model names the tracker in its own field
   (`{ tracker: "sleep", value: 6 }`, `tracker_name`). The resolver ignored it for matching and
   for the offered tracker's name. Now the offer reads "Start tracking "mood"?" and a reading
   matches an existing tracker by that field.
5. **One runaway generation cost 3 minutes and a retry.** In run 1 the extraction of "Slept 6
   hours." looped inside the JSON grammar (~1,400 tokens) until the 180 s deadline; the capture
   took 330 s instead of ~75 s. No request set `max_tokens`. Extraction is now capped at 1,024
   tokens (live answers: 36–176), segmentation at 2 tokens per character (room for Arabic script) (min 1,024); a cut-off
   reply goes to the existing repair retry.
6. **Docs: whisper-server leaves recordings in its working directory.** With `--convert` it writes
   each upload to a temp WAV in the directory it was started from and keeps it when conversion
   fails (run 1 left five in the repo root). `home-server.md` now passes a private `--tmp-dir`.

## Latencies

Typed captures, wall time from push to the final state as the phone saw it (polling every 1 s):

| Capture                    | Thoughts (actionable) | Run 1                   | Run 2 | Run 3 |
| -------------------------- | --------------------- | ----------------------- | ----- | ----- |
| Ramble (224 chars)         | 6 (4)                 | 330 s (timeout + retry) | 76 s  | 72 s  |
| Mixed language (135 chars) | 5 (3)                 | 64 s                    | 68 s  | 63 s  |
| Inbox capture (199 chars)  | 6 (6)                 | 91 s                    | 96 s  | 86 s  |
| Loop note (72 chars)       | 1 (0–1)               | 17 s                    | 10 s  | 9 s   |
| Edited ramble (reprocess)  | 5 (4)                 | 75 s                    | 71 s  | 71 s  |

Roughly **25–30 s to split a capture, plus 10–20 s per actionable thought**. llama-server: prompt
74–79 tok/s, generation 7.8 tok/s; an extraction answer is 36–176 tokens.

Voice, a 5.25 s synthetic clip: transcription 15.0 s in every run, so **~2.9 s per second of
audio** for a short clip (mostly fixed cost: ffmpeg conversion and model warm-up; a direct cold
`curl` took 9.7 s). The whole voice capture (upload, transcribe, extract) took 38 s, 52 s and 55 s.
`home-server.md` measured ~1× real time on an 11 s clip, so the per-second cost falls with length.

## Extraction-quality problems (Qwen3.5-4B)

Not bugs in the code; what the model does with the current prompts.

- **Readings become plain activities, the value lost.** Run 1: "Slept 6 hours.", "mood 2 sur 5",
  "Meditated 20 minutes.", "Drank 3 glasses of water." were all auto-applied activities named after
  the whole sentence with `quantity: null`, and no "Start tracking?" offer. The same text alone
  (debug run) gave `{ kind: tracker_entry, fields: { tracker: "sleep", value: 6 } }`. Run to run it
  flips. "Meditated 20 minutes" came back as `{ duration: 20, unit: "minutes" }`: unit kept,
  quantity lost (`duration` isn't a quantity key).
- **A tracker named after the reading.** When the model gives no tracker field (runs 3–4, "mood 2
  sur 5"), the offer is still 'Start tracking "mood 2 sur 5"?' and Yes creates that tracker;
  fix 4 only helps when the model names it. The next reading "mood 2 sur 5 4 today" then
  failed to match it and became one more activity.
- **Titles carry the sentence.** "Dentist Thursday at 3pm.", "Pay the electricity bill.",
  "Need to check whether the car insurance covers windscreen damage." The date phrase and the
  trailing period end up in the title; run 1 got "Dentist".
- **Invented records.** "Pay the electricity bill." gave a task _and_ an `ask` activity "Paid the
  electricity bill." (run 1). "Remind me to buy olive oil tomorrow." gave a tracker definition
  "buy olive oil" instead of a task (voice, run 2).
- **Kinds drift on re-processing.** The same "Need to check whether…" sentence was `to_check` and
  became `task` when the capture was edited; the loop note "Checked with the insurer: … covered"
  was `to_check` in run 1 (and an activity was extracted) and `note` in run 2.
- **"this weekend" has no date.** "Buy running shoes this weekend." → a task with no due date.
- **Whisper hallucinates on silence.** Three seconds of digital silence transcribe as
  "Thank you." (English, no-speech probability ~0). Fix 2 catches tones and markers, not this.
  whisper-server's `--vad` (Silero) would; untested here.

## Open product questions

- **Should a deterministic transcription failure fail at once?** Damaged audio and "no speech"
  are retried on the normal policy (10 s, 1 min, 6 min, 15 min): the user waits ~23 min to see
  `failed` for a recording that will never transcribe.
- **Without a usable transcript, use the device draft?** A voice note whose draft was not edited
  still ends `failed` when Whisper finds no speech, though the phone has words for it.
- **Auto-applied value-less activities for readings.** When the model drops the value, "Slept 6
  hours." is auto-applied as an activity: no review, value lost. Should a thought the segmenter
  calls `tracker` never produce an `auto` activity?
- **How should a tracker be named when the model doesn't name it?** Today it is the whole reading
  ("Start tracking "mood 2 sur 5"?"), which no later reading matches. Options: strip the numbers
  and date words deterministically, or let the user name it when answering Yes.
- **Titles:** keep the user's whole words (current prompt: "never translate") or a short cleaned
  title ("Dentist") with the date stripped?
- **Is ~75 s for a six-thought ramble acceptable?** The phone never waits, but the inbox fills a
  minute or two later. A bigger model will be slower; one extraction call per capture instead of
  per thought would be faster.
