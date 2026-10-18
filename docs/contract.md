# Capture-loop contract

**Status:** stable for slice 1 (2026-10-18). The code version lives in `@bullet/core`
(`processing.ts`, `sync.ts`). We may **add** things later (new operations, new kinds of data); we
won't rename or remove anything below without updating this page.

This page is for anyone designing screens. Technical details are at the end.

---

## 1. The idea

1. You type or dictate a thought and tap **Send**. It's saved **on the phone** straight away,
   even with no signal.
2. When the phone can reach your **home server**, it sends the thought over (**sync**).
3. The home server reads it with a local AI model, **in the background**, and works out what's
   in it: a task, an event, a tracker reading, something you did.
4. What it finds comes back to the phone as **suggestions**. Safe, obvious ones are applied
   automatically (with Undo). The rest wait for you to review, whenever you like.

Capture never waits on any of this: Send always works right away.

## 2. Bullet states

Each bullet has exactly **one** of these states.

| State          | Plain meaning                                                | Where it exists | What it's waiting on                      |
| -------------- | ------------------------------------------------------------ | --------------- | ----------------------------------------- |
| `saved_local`  | Saved on this phone, not on the server yet                   | **Phone only**  | A connection to the home server           |
| `synced`       | The server has it and it's in line to be read                | Phone + server  | The server's AI (queue)                   |
| `processing`   | The AI is reading it now                                     | Phone + server  | Usually a few seconds; at most ~2 minutes |
| `processed`    | Done. Anything found was applied, or there was nothing to do | Phone + server  | Nothing                                   |
| `needs_review` | Done, and at least one suggestion is waiting for you         | Phone + server  | **You**                                   |
| `failed`       | The server couldn't read it, even after retrying             | Phone + server  | **You** (tap Retry)                       |

```
 saved_local ──sent──▶ synced ──picked up──▶ processing ──┬──▶ processed
                         ▲                                ├──▶ needs_review ──all reviewed──▶ processed
                         │                                └──▶ failed
                         │                                        │
                         └──── retry / edit / server hiccup ◀─────┘
```

### What moves a bullet between states

- **Sent** (`saved_local → synced`): the phone reached the server and the server confirmed it has
  the bullet.
- **Picked up** (`synced → processing`): the server starts reading it. Bullets are read one at a
  time, oldest first.
- **Done** (`processing → processed` or `needs_review`): `needs_review` if at least one suggestion
  needs a decision, otherwise `processed`.
- **All reviewed** (`needs_review → processed`): you accepted or dismissed every waiting
  suggestion.
- **Failed** (`processing → failed`): the server tried several times and gave up (the AI was
  down, too slow, or gave nonsense). A failed bullet is **never lost**: the text is safe, only
  the extraction is missing.
- **Retry** (`failed → synced`): you tapped Retry.
- **Automatic retry** (`processing → synced`): a temporary problem. The server will try again by
  itself shortly. The bullet shows how many attempts so far and when the next one is due.
- **Edit** (`processed`/`needs_review`/`failed → synced`): you changed the text, so it's read
  again (see §4).

### On the phone

- A bullet you **just captured or edited** shows `saved_local` until the server confirms it has
  that version, **whatever its previous state was**. So an edited `processed` bullet goes back to
  `saved_local`, then `synced`, and so on.
- Everything else shows the state the server last reported.
- The phone keeps working fully offline: capture, edit, delete, accept/dismiss suggestions. It
  all queues up and goes out on the next sync.

### Extra details the UI may use

Every bullet carries:

- **Attempts:** how many times the server has tried to read it (0 before the first try). This is
  the retry count.
- **Last error,** if any. One of:
  - `llm_unavailable`: the home server's AI isn't running or isn't reachable.
  - `llm_timeout`: the AI took too long.
  - `llm_bad_output`: the AI's answer was unusable.
  - `internal`: something else went wrong on the server.

  A `failed` bullet always has an error. A `synced` bullet may also have one while an automatic
  retry is waiting ("Retrying…").

- **Next retry time,** only while an automatic retry is waiting.
- **Source:** `text` or `voice` (dictated), plus **when** it was captured and the phone's
  **time zone** then. "Tomorrow 3pm" always means 3pm where you were when you said it.

## 3. Suggestions

A bullet can produce several suggestions ("ran 5k, dentist Thursday 3pm" → an activity **and** an
event). Each suggestion is one proposed change:

- **Kind:** `task`, `event`, `tracker` (a new thing to track), `tracker_entry` (a reading such as
  mood 4), or `activity` (something you did).
- **Operation:** `create` (make a new one), `append` (log under an existing tracker), or `update`
  (change something that exists, such as marking a task done).
- **Tier:** how sure the system is. This is what to show, rather than a percentage:
  - `auto`: applied automatically. The UI should offer **Undo**.
  - `suggest`: probably right; one tap to confirm.
  - `ask`: unsure; the user should look at it.
- **Status:** `pending` (waiting for you), `accepted`, `edited` (accepted with your changes), or
  `rejected` (dismissed, or undone).
- **Applied:** whether it was applied, when, what it created or changed, and whether it was
  applied **automatically**.

Rules the design can rely on:

- Suggestions **never expire**. Review whenever you like.
- **New trackers are never applied automatically.** They always need your OK.
- Readings with a value (mood 4, weight 72) and new tasks/events wait for a tap by default.
- Accepting a suggestion that's been waiting a while checks it against what's there **now**. If
  it no longer makes sense (say, the task it would mark done was deleted), you'll be told and
  nothing changes.
- **Undo** works on anything that was applied. It removes what was created, or puts back what was
  changed. If you've since edited that thing by hand, Undo is refused rather than overwriting
  your change.

## 4. Editing and deleting a bullet

- **Edit:** the bullet is read again. Suggestions that still match are **kept** (including ones
  you already accepted). New findings are **added**. Things that no longer appear in the text are
  **withdrawn**: waiting suggestions disappear, and applied ones are undone. All of this happens
  in one step, so you never see a half-updated mix.
- **Delete** offers three choices:
  - **Cancel.**
  - **Delete + extractions:** the bullet and everything it produced go away.
  - **Delete but keep extractions:** only the bullet goes. Tasks, events and entries it created
    stay. Suggestions still waiting are withdrawn.

Nothing is ever erased for good. Deletes are "soft", so they can be recovered later.

## 5. Sync, briefly

- The phone keeps an **outbox**: a list of everything you did that the server hasn't confirmed
  yet. It's saved in the same instant as the change itself, so nothing can slip between the two.
- When the app comes to the foreground, when the network comes back, and now and then in the
  background (if iOS allows), the phone:
  1. **pushes** the outbox, oldest first; then
  2. **pulls** everything that changed on the server since last time: bullet states,
     suggestions, and the tasks/events/trackers/entries/activities they produced.
- Sending the same thing twice is harmless: the server recognises it and won't duplicate
  anything. So the phone can just resend after any network hiccup.
- If the server **refuses** something for good (for example you edited a bullet on another phone
  more recently), the phone drops it and takes the server's version on the next pull.

---

## Technical appendix

**Auth.** Every request has `Authorization: Bearer <device token>`. Each phone has its own token,
created on the server (`pnpm --filter server device:add <name>`). The server stores only a hash
of it.

**`POST /sync/push`** with body `{ ops: PushOp[] }` (1–100 ops, applied in order). Each op has a
client-minted UUID `op_id`. The op types are `bullet.create` (with a client-minted bullet `id`,
`text`, `captured_at`, `timezone`, `source`), `bullet.edit` (`text`, `edited_at`),
`bullet.delete` (`mode: cascade | keep_extractions`), `bullet.retry`, `suggestion.accept`
(optional edited `payload`), `suggestion.reject` and `suggestion.undo`.

The response is `{ results: [{ op_id, status: applied | duplicate | rejected, error? }],
server_time }`. Rejection codes are `not_found`, `invalid`, `conflict` and `stale`. A rejected op
is final.

**`GET /sync/pull?cursor=<opaque>&limit=<1..500>`** returns `{ changes: { bullets, suggestions,
tasks, events, trackers, tracker_entries, activities }, cursor, has_more, server_time }`. Rows
are full current versions, soft-deleted ones included (`state: 'deleted'`). Omit `cursor` for a
full sync. Repeat while `has_more`.

**Timestamps** are epoch milliseconds. **IDs** are UUID v4. Errors use the envelope
`{ error: { code, message } }` with `401 unauthorized`, `400 bad_request`, `413
payload_too_large` and `500 internal`.
