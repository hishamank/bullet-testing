# Capture-loop contract

**Status:** stable for slice 1 (2026-10-18; voice-note audio, the `transcribing` state, and
thoughts + clarifying questions were added the same day; light manual editing, closing open loops
and tap-to-answer questions were added 2026-10-19; reflective questions (slice 2) were added
2026-10-19 too, §2e; connections, themes and Noticed (slice 3) were added 2026-10-19, §2f). The
code version lives in `@bullet/core` (`processing.ts`, `sync.ts`). We may **add** things later (new operations, new kinds of data); we
won't rename or remove anything below without updating this page.

This page is for anyone designing screens. Technical details are at the end.

**Words used here.** A **capture** is what you typed or said in one go (with its recording, if
spoken). It is split into **thoughts**, and from thoughts the app extracts **things**: tasks,
events, tracker readings, activities. In the code and the API a capture is still called a
`bullet`, because renaming it would break this contract for no change in behaviour. On this page,
"capture" and "bullet" mean the same thing.

---

## 1. The idea

1. You type or speak (one thought, or a long ramble) and tap **Send**. It's saved **on the phone** straight away,
   even with no signal. When you speak, the phone **keeps the recording** and shows a live draft
   of the words as you talk.
2. When the phone can reach your **home server**, it sends the thought over (**sync**).
3. For a voice note, the home server first **transcribes the recording again**, more accurately
   (it handles a mix of English, Lebanese Arabic and French). Then a local AI model, **in the
   background**:
   - splits the capture into separate **thoughts** (a worry, something to check, a question, an
     idea, a note, a task, an event, a reading, something you did). **Every thought is kept**,
     even when nothing needs doing about it, so you can empty your mind knowing nothing is lost;
   - works out the **things** in the actionable thoughts: tasks, events, tracker readings,
     activities.
4. Things come back to the phone as **suggestions**. Safe, obvious ones are applied
   automatically (with Undo). The rest wait for you to review, whenever you like. When something
   is genuinely ambiguous, the app may also ask a short **clarifying question** ("Which
   Thursday?"). Answering is optional.

Capture never waits on any of this: Send always works right away.

## 2. Bullet states

Each bullet has exactly **one** of these states.

| State          | Plain meaning                                                   | Where it exists | What it's waiting on                                                |
| -------------- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `saved_local`  | Saved on this phone, not on the server yet                      | **Phone only**  | A connection to the home server                                     |
| `synced`       | The server has it and it's in line to be read                   | Phone + server  | The server's AI (queue), or the rest of a recording still uploading |
| `transcribing` | Voice notes only: the server is turning the recording into text | Phone + server  | Usually seconds; longer for long recordings                         |
| `processing`   | The AI is reading it now                                        | Phone + server  | Usually a few seconds; at most ~2 minutes                           |
| `processed`    | Done. Anything found was applied, or there was nothing to do    | Phone + server  | Nothing                                                             |
| `needs_review` | Done, and at least one suggestion is waiting for you            | Phone + server  | **You**                                                             |
| `failed`       | The server couldn't read it, even after retrying                | Phone + server  | **You** (tap Retry)                                                 |

```
                              ┌─ voice note ─▶ transcribing ─┐
 saved_local ──sent──▶ synced ┤                              ├─▶ processing ──┬──▶ processed
                         ▲    └─ typed ──────────────────────┘                ├──▶ needs_review ──all reviewed──▶ processed
                         │                                                    └──▶ failed
                         │                     (transcribing can fail too) ──▶ failed │
                         └──────────────── retry / edit / server hiccup ◀─────────────┘
```

### What moves a bullet between states

- **Sent** (`saved_local → synced`): the phone reached the server and the server confirmed it has
  the bullet.
- **Picked up** (`synced → transcribing` for a voice note with a recording, otherwise
  `synced → processing`): the server starts on it. Bullets are handled one at a time, oldest
  first. A voice note waits in `synced` until its whole recording has arrived.
- **Transcribed** (`transcribing → processing`): the server's transcript replaces the draft
  text, **unless you edited the draft** before sending (or later). Then your words stay and the
  server's transcript is only kept alongside. Either way the bullet is then read as usual.
- **No usable transcript, but a real draft** (`transcribing → processing`): when the recording
  has no speech the server can use (or can't be read) but the phone's live draft has real content
  (more than three words, not just "Thank you."), the draft stays the text, the bullet is marked
  **from the phone's live draft**, and it is read as usual. Whisper's well-known silence phrases
  ("Thank you.", "Thanks for watching", "Merci.", "شكرا") count as no speech on a short recording
  or when the draft disagrees. With no usable draft either, the bullet fails at once (below).
- **Done** (`processing → processed` or `needs_review`): `needs_review` if at least one suggestion
  needs a decision, otherwise `processed`.
- **All reviewed** (`needs_review → processed`): you accepted or dismissed every waiting
  suggestion.
- **Failed** (`transcribing → failed` or `processing → failed`): the server tried several times
  and gave up (the transcriber or the AI was down, too slow, or gave nonsense). A failed bullet
  is **never lost**: the text and the recording are safe, only the transcript or extraction is
  missing. A recording that **can't** be transcribed (no speech in it, or audio that can't be
  read) fails **at once**, without automatic retries: trying the same recording again would give
  the same answer.
- **Retry** (`failed → synced`): you tapped Retry. On a capture **from the phone's live draft**,
  the same op is **Retry transcription** (`processed`/`needs_review → synced`): the server runs
  Whisper again. A good transcript then replaces the draft text (unless you edited it) and the
  capture is read again, keeping what still matches; still no speech leaves it as it was.
- **Automatic retry** (`transcribing`/`processing → synced`): a temporary problem (the
  transcriber or the AI unreachable, too slow, or busy). The server will try again by itself
  shortly, up to 5 attempts. The bullet shows how many attempts so far and when the next one is
  due.
- **Edit** (`processed`/`needs_review`/`failed → synced`): you changed the text, so it's read
  again (see §4).

### On the phone

- A bullet you **just captured or edited** shows `saved_local` until the server confirms it has
  that version, **whatever its previous state was**. So an edited `processed` bullet goes back to
  `saved_local`, then `synced`, and so on.
- Everything else shows the state the server last reported.
- **Processing feedback** for the latest capture is one quiet, static line under the mic (no
  spinner, no notification), from the capture's own status and time:
  - while it is `saved_local` (and the server is reachable), `synced`, `transcribing` or
    `processing`: "Saved. Sorting this out in the background.";
  - more than 5 minutes after it was captured and still on its way: "Still sorting. Your capture
    is safe.";
  - done, with things found: "N things found" (taps through to the capture). A reading counts
    with its new tracker as one thing; dismissed ones don't count. Shown for an hour.
    Failed captures, recordings that can't be transcribed and offline captures keep their own
    lines, which come first.
- The phone keeps working fully offline: capture, edit, delete, accept/dismiss suggestions, edit
  tasks/events/readings, resolve thoughts, answer questions. It all queues up and goes out on the
  next sync.

### Extra details the UI may use

Every bullet carries:

- **Attempts:** how many times the server has tried to read it (0 before the first try). This is
  the retry count.
- **Last error,** if any. One of:
  - `llm_unavailable`: the home server's AI isn't running or isn't reachable.
  - `llm_timeout`: the AI took too long.
  - `llm_bad_output`: the AI's answer was unusable.
  - `transcription_unavailable`: the server's transcriber isn't running or isn't reachable.
  - `transcription_timeout`: transcribing took too long.
  - `transcription_failed`: the recording couldn't be read (damaged or undecodable audio).
    Permanent: no automatic retry.
  - `transcription_no_speech`: the recording was read but has no speech in it (silence, a tone,
    zero-length audio, or only Whisper's silence phrases such as "Thank you."). Permanent: no
    automatic retry. _Added 2026-10-19._
  - `internal`: something else went wrong on the server.

  For the two permanent ones the phone offers **Write it down** / **Keep as audio** instead of
  Retry, worded "No speech found in this recording" (`transcription_no_speech`) or "Couldn't
  transcribe this recording" (`transcription_failed`). After "Write it down" the server reads
  the user's words right away. `bullet.retry` still works on them (it tries the recording once
  more).

  A `failed` bullet always has an error. A `synced` bullet may also have one while an automatic
  retry is waiting ("Retrying…").

- **Next retry time,** only while an automatic retry is waiting.
- **Source:** `text` or `voice`, plus **when** it was captured and the phone's **time zone**
  then. "Tomorrow 3pm" always means 3pm where you were when you said it.
- **Edited by you:** whether you changed the text by hand. Server transcripts never overwrite it.
- **From the phone's live draft** (`text_from_draft`): the server found no usable speech, so the
  text is the phone's draft. Show "From the phone's live draft" and offer **Retry
  transcription**. Cleared by a good transcript or by your edit. _Added 2026-10-19._

## 2b. Voice notes

- The **recording is kept for good**, on the phone and on the server. It is never thrown away
  after transcription. Deleting the bullet hides it like everything else (soft delete).
- Each voice note has one **recording** with its length, format, size and an **upload state**:
  `pending` (some or all of it hasn't reached the server; the phone knows how much has) or
  `uploaded`. Big recordings go up in pieces, and an interrupted upload continues where it
  stopped.
- It can have two **transcripts**, both kept:
  - the **draft** the phone made live while you spoke (Apple's on-device recognition, English);
  - the **server transcript** (Whisper), which understands mixed English, Lebanese Arabic and
    French. It records which engine and model made it and the languages it heard.
- The bullet's text is the server transcript once it exists, unless you edited the text yourself.
  When there is no usable server transcript, the text stays the phone's draft (if it has real
  content) and the bullet says so (`text_from_draft`). The UI can always show both transcripts
  and play the recording.

## 2c. Thoughts

Each capture is split into one or more thoughts, in order. A thought has:

- its **text** (the segment, lightly cleaned of "um"s and false starts);
- where it sits in the capture text (a **span**; occasionally unknown when the text was
  paraphrased);
- a **kind**, one of: `worry`, `to_check`, `question` (one you asked yourself), `idea`, `note`,
  `task`, `event`, `tracker`, `activity`.

Rules the design can rely on:

- **Every thought is kept**, actionable or not, and needs **no review**. The kind is a label, not
  a suggestion.
- You can **re-classify** a thought. Your choice sticks, even if the capture is processed again.
- Things (and their suggestions) say which **thought** they came from, as well as which capture.
- Worries, ideas, notes and self-questions are kept as thoughts and nothing is extracted from
  them. A worry, self-question or idea may get a **reflective question** (§2e). Thoughts of
  different captures are **linked**, and recurring ones make **themes** (§2f).
- The server may flag a thought `sensitive` (it reads as self-harm, crisis or acute distress).
  The flag is **server-only**: it is never pulled to the phone, never shown (no UI, no copy, no
  notification), and the capture is never hidden. Its effects: no reflective question is asked
  about that capture (§2e), and the thought never surfaces outside its own capture (§2f).
- Long recordings work: the capture is split in pieces for the AI and the thoughts are put back
  together in order.

### Open loops

Thoughts of kind `to_check` and `question` are **open loops**: things you meant to look into or
answer. You can close one:

- **Resolve** it directly ("done, checked it"). It gets a **resolved** time. You can **re-open** it,
  which clears that time.
- **Resolve it with a note:** capture something (typed or spoken) as the follow-up. That capture
  points at the thought and closes it once the server has it. The note is an ordinary capture: it
  is split into thoughts and things are extracted from it like any other.

Only `to_check` and `question` thoughts can be resolved; the server refuses the others. Resolving
survives the capture being processed again.

## 2d. Clarifying questions

Sometimes a thing is ambiguous. The app may then ask a **clarifying question**: short, concrete,
about one thing. Examples: "Which Thursday: today or next week?", "Start tracking Sleep?".

- At most **3** per capture.
- Each has a **topic** (`date`, `new_tracker` or `other`), the question text, up to 4 quick
  **options** to show as buttons (or none, for a free answer), and links to the thought and
  suggestion it is about.
- **Optional, never blocking:** the suggestion it is about stays reviewable as usual. Status:
  `open`, `answered` or `dismissed`.
- **Answer by tapping an option** (no AI involved, works offline and syncs later):
  - **Date** questions ("Which Thursday: Today or Next Thursday?"): the day you tap is set on the
    task or event the question is about (keeping its time of day), and it is **applied**. It then
    shows as applied, with **Undo**, like anything done for you.
  - **"Start tracking X?"**: **Yes** creates the tracker (your tap is the OK a new tracker always
    needs) and logs the reading you gave with it. **No** declines the tracker for good (it is
    never offered again for that capture) and keeps the reading as a plain activity with its
    value ("Slept · 6 h", no tracker), applied as a record. The Inbox shows the same decision on
    the tracker's own card (see §3), and deciding there answers this question too.
- **Or answer with a capture** (typed or spoken) that points at the question.
- Either way the question becomes `answered` (with the option you tapped, if any).
- Clarifying questions have `kind: clarifying`. Open-ended questions to think about are
  **reflective** (§2e).

## 2e. Reflective questions (slice 2)

Now and then the app offers a question **to think about**: about what you said, never what you
should do. It is optional and never nags.

**Where they come from** (`origin`):

- `capture`: after a capture's things are done, the server may ask **one** question about one of
  its worries, self-questions or ideas, quoting your words, in your language, with a curious tone
  ("You wrote «I'm dreading Monday's meeting». What about it feels heavy?"). It never delays the
  capture's things. A capture that answers a reflective question gets none of its own. A reflect
  job the limits refuse is **finished, not deferred**: a question arriving days after the capture
  would feel odd. If an edit rewords the thought a live question was about, that question is
  withdrawn and the capture may get a new one; a dismissed or answered one still counts.
- `open_loop`: a `to_check` or `question` thought left unresolved for **7 days** gets
  "Still on your mind? «check if the passport expires»", with the prefix in the thought's
  language: "Toujours en tête ? «…»" (a narrow no-break space, U+202F, before the "?"),
  "Ba3do 3a balak? «…»", or "بعدو عبالك؟ «…»" (shown right to left; its "؟" is never replaced by
  "?"). The language is a deterministic guess that falls back to English when unsure. At most
  once per thought, ever. A resolved one never does.
- `connection` (slice 3, §2f): "Is this the same thing? «A» / «B»" about a thought of the capture
  and an earlier one that are close, but not close enough to link, with the options **Same thing**
  and **Different** (a free answer, a capture, works too). It takes the capture's one question only
  when the capture's own reflection asked nothing.
- `evergreen`: a hand-written list of about 20 calm questions ("What took more energy than it
  should have this week?"), with a `template_id`. Offered only when no other reflective question
  is open, at most one every 3 days. The user can also **pick one** to journal about
  (`question.pick_evergreen`). The list is in `@bullet/core` (`EVERGREEN_QUESTIONS`).

**Limits**, across all three: at most **3** open at a time (a picked evergreen question may make
it 4), at most **2** new per day (rolling 24 hours), one per capture, and nothing new while you
haven't captured anything for 14 days. Snoozed ones count as open.

**On the phone:** the Inbox's Questions split into **To clarify** (clarifying, counted in the
badge) and **To think about** (reflective: never in the badge, never notified). Each reflective
question offers:

- **Journal about it:** an ordinary capture (typed or spoken) with `answers_question_id`. It is
  split into thoughts and extracted like any other, and the question becomes `answered`. More
  captures can answer it later ("Add more"), with the same `answers_question_id`. Answered ones
  are listed under **Answered · N**.
- **Later:** hidden for 7 days (`snoozed`, `snoozed_until`), then back. Allowed once; a second
  Later dismisses it quietly.
- **Not this one:** dismissed for good, and the thought it was about never produces another
  question (`never_ask` on the thought), even after the capture is processed again. A dismissed
  evergreen question is not offered again.

Tapping an option (`question.answer`) is refused for reflective questions, except a `connection`
question's Same thing / Different (§2f).

**Pick a question** lists the evergreen questions except those let go with Not this one and those
already waiting. A pick is created on the phone at once, so it can be answered offline. If the
server later refuses it, the phone drops its copy and the Inbox says "That question couldn't be
added. Your answer is still saved." (the answer stays an ordinary capture).

**Answers and their source** link both ways: an answer's Stream card is headed "Thinking about"
with the question (tapping it opens the capture it is about; nothing for evergreen questions),
its Capture detail pins the question above the text, and the capture asked about lists
"You thought about this · N" with each answer.

**Sensitive thoughts.** When a thought reads as self-harm, crisis or acute distress, the server
marks it `sensitive` (conservatively, while splitting the capture; server-only, never pulled).
That capture then gets no reflective question, its open loops never get "Still on your mind?",
and evergreen questions pause for 7 days. Everything else is identical: the capture is kept,
split and extracted. No UI, no copy, no notification.

## 2f. Connections, themes and Noticed (slice 3)

The app quietly shows the thread when you've said something before, in your own words, and lets you
say "no, that's not it". Nothing here notifies. Noticed cards and connection questions are never in
the Inbox badge; a waiting "Did this close it?" is (like any suggestion waiting for a decision).

**Links between thoughts** of different captures, one of four types:

- `same_entity`: the same person, place or project ("Karim", "the Hamra flat");
- `same_topic`: about the same thing;
- `answers`: a later thought answers an earlier open loop (`to_check` / `question`);
- `revisits`: a later thought asks again, or restates, an earlier question or idea.

A capture's thoughts are linked within moments of it being `processed` (a `link` job right after
its extraction): each thought is compared with the 10 closest earlier thoughts, and linked when
they are close enough (a lower threshold applies when they share a name). At most **5 links per
thought**; anything not close enough is dropped, never queued. A nightly run checks the least
certain links with a bigger model: it settles same person vs same topic, and removes one it finds
unrelated (it never comes back). Links are only ever added this way, never re-scored: a link made
stays until you or a nightly review remove it, or one of its thoughts goes.

**Answered loops.** When a later capture seems to answer an open loop, the live model is asked
"does it?" and a yes proposes closing it: a **`thought_resolve` suggestion** (§3), tier `suggest`,
never applied automatically: "Did this close it? «loop» ← «answer»". One per loop and answering
capture.

- **Accept** closes the loop (`resolved_at`, `resolved_by_bullet_id` = the answering capture).
  Refused (`conflict`) when the loop was closed meanwhile: show **Already closed**.
- **Dismiss** remembers the pair: it is never proposed again, even after re-processing.
- **Undo** opens the loop again (the link stays, no longer called an answer).
- A loop you closed by hand is never touched; nothing is proposed from a capture with any sensitive thought (the answer is quoted where it closes the loop: "Closed by «…»" quotes only that answering thought, never the capture).
- It is about another capture's loop, so it never puts the answering capture in `needs_review`;
  it does count in the Inbox badge while it waits.
- Withdrawn when the loop or the answer is deleted, or turns sensitive.

**Connection questions** ("Is this the same thing? «A» / «B»", §2e origin `connection`): a pair a
little under the link threshold, both worries, things to check, self-questions or ideas. It obeys
every slice 2 limit, lives under **To think about**, and takes the capture's single question only
when the capture got no other. **Same thing** links them (your link); **Different** remembers they
are not related.

**Themes.** A theme is at least **4 thoughts over at least 3 different days, from at least 2
captures, within the last 30 days**, that are linked or close. A nightly run (02:00 on the home
server; after downtime it catches up once) finds them, names new ones in a few of your own words,
and keeps at most **8 active**. A theme's `status`: `active`, `dormant` (not recurring now; it may
come back), or `retired` ("Not a theme", or merged into another: `merged_into_theme_id`).

**Noticed cards** (an Inbox section below Questions): "«quote» · came up N times in M days", up to 3
quotes (each opens its capture; the headline always quotes one of them), and the theme as an
editable pill. Wording is observational and in
your words: the app never writes "seem", "tend", "should", "pattern", "stress", "anxious", "always"
or "never" (only a quote of yours can contain them). At most one card per theme per 14 days, at most
2 new cards a day; a card you haven't opened is **retired** after 14 days. Status: `new`, `opened`,
`dismissed`, `retired`.

**Corrections are remembered** (nothing re-creates them: not nightly runs, edits or re-processing):

- **Not related** (`link.veto`, long-press a Related row): the link goes and the pair is remembered,
  in both directions.
- **Not a theme** (`theme.retire`): the theme is retired, never re-created from mostly the same
  thoughts, and its unopened cards are withdrawn. Its links stay.
- **Rename** (`theme.rename`): your name shows from now on.
- **Merge with…** (`theme.merge`): its thoughts move to the other theme, it is retired, and later
  matches of it go to the other theme.
- **Open** / **dismiss** a card (`noticed.open`, `noticed.dismiss`).

A remembered pair is about two thoughts; an edit that rewords a thought makes it a new thought.

**Sensitive thoughts** are linked, but never appear outside their own capture. A link is shown only
from the capture whose **other** end is not sensitive: a sensitive capture's own Related still
lists its non-sensitive links, while the other capture doesn't list it (`visible_from`: `both`,
`a` or `b`; a link between two sensitive thoughts is not pulled). Noticed never quotes one (if a
card's headline thought turns sensitive, the headline is rebuilt from another quote, or the card
goes), and they never take part in a connection question or an answered loop (one waiting is
withdrawn when its thought turns sensitive). A theme made half or more of them is not pulled at all
(no card, no name) and doesn't count toward the 8.

**On the phone** (data layer: `packages/client/src/data/connections.ts`): Capture detail **Related · N**
(each row: date, quote, small word: same one / related / answers / again — "same one" because the server keeps no entity kind, so a place is never called a person; `listRelated` honours
`visible_from`), the Inbox's
**Noticed**, the Stream's "again" dot (a thought in an active theme), "Did this close it?" cards,
and "Closed by «…»" on open loops (`resolved_by_bullet_id`).

## 3. Suggestions

A bullet can produce several suggestions ("ran 5k, dentist Thursday 3pm" → an activity **and** an
event). Each suggestion is one proposed change:

- **Kind:** `task`, `event`, `tracker` (a new thing to track), `tracker_entry` (a reading such as
  mood 4), or `activity` (something you did). Slice 3 adds `thought_resolve` ("Did this close
  it?", §2f): an `update` whose `target_id` is the open loop and whose payload is `{ thought_id,
  resolved_by_bullet_id }`; tier `suggest`, never `auto`.
- **Operation:** `create` (make a new one), `append` (log under an existing tracker), or `update`
  (change something that exists, such as marking a task done). A `tracker_entry` **`create`** is
  a reading of a tracker that is itself only proposed: its `payload.tracker_id` is that `tracker`
  suggestion's id (which becomes the tracker's id once created). It is decided **with** the
  tracker, never on its own: accepting the tracker logs it, "Not now" turns it into an applied
  activity with the value (the suggestion's kind becomes `activity`), undoing the tracker undoes
  it. _Added 2026-10-19._
- **The same new tracker from two captures.** Each capture offers it on its own, and deciding one
  never decides the other until a tracker of that name exists. Once one is accepted (on any
  phone), every other open offer of that name is **linked** to it: it shows as `accepted` with
  `applied_entity_id` = the existing tracker (it created nothing), its question is answered, and
  its reading becomes an ordinary pending reading of that tracker ("Log 7 h to Sleep?"), one per
  capture. Accepting an offer whose (edited) name matches an existing tracker links it the same
  way rather than refusing. Undoing a linked offer never deletes the tracker. Undoing the new
  tracker itself opens every offer linked to it again ("Start tracking Sleep?" with its reading
  waiting on it, its question open), unless that would orphan something: it is refused
  (`conflict`) when a reading logged with it was edited by hand, or when another capture's
  reading is already logged to it.
- **Declining a plain reading** ("Log 7 h to Sleep?" → dismiss) keeps no record: the reading is
  not logged anywhere, and its words stay in the capture's thought. (Only "Not now" on a _new_
  tracker keeps its reading as an activity.)
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
- **A reading is never a value-less activity.** "Slept 6 hours", "meditated 20 minutes",
  "mood 2 sur 5" always carry their value: logged under an existing tracker ("Log 6 h to
  Sleep?"), or, for something not tracked yet, a new tracker plus the reading ("Start tracking
  Sleep?"). A new tracker is offered only for a reading or a thing people track (sleep, mood,
  water, a run…): "spent 2 hours at the dentist" keeps its value on an activity. A reading on
  another scale or unit than its tracker ("mood 7/10" for a 1–5 tracker, "5 miles" for a km
  one) is never clamped or converted: it waits as an activity with its value. Only a value-less
  activity ("meditated", "went for a walk") may be applied automatically.
- **Titles are a short phrase in your own words**: "Dentist" (with Thu 15:00 in the event's
  start), "Pay the electricity bill". The date and time go into the structured fields
  (`due_at`, `starts_at`) and out of the title, as do a reminder lead-in ("Remind me to",
  "Need to", "Il faut") and trailing punctuation. Your spelling and language are kept: never
  paraphrased or translated. A date phrase the app can't read yet ("this weekend") stays in the
  title, and so does a possessive ("Prepare the slides for Monday's meeting").
- **Tracker names are a short noun** for the measured thing, 1–2 words, Title Case, in your
  language: "Mood", "Sleep", "Sommeil". Never the reading, its unit or its value.
- **Inbox wording.** A new tracker: "Start tracking Mood?", its name in an editable field
  (pre-filled), buttons **Start tracking** (accept, with the edited name as the payload's
  `name`) and **Not now** (dismiss), and under it what each does with the reading ("Start
  tracking logs 6 h. Not now keeps 6 h as an activity.").
  A later reading: "Log 6 h to Sleep?".
- Accepting a suggestion that's been waiting a while checks it against what's there **now**. If
  it no longer makes sense (say, the task it would mark done was deleted), you'll be told and
  nothing changes.
- **Undo** works on anything that was applied. It removes what was created, or puts back what was
  changed. If you've since edited that thing by hand, Undo is refused rather than overwriting
  your change.

## 3b. Editing what the app found

Slice 1 has light manual editing of things (there is no manual creation yet):

| Thing           | You can change                                                     | Delete |
| --------------- | ------------------------------------------------------------------ | ------ |
| Task            | complete / reopen (`done` ↔ `todo`), due date (or none), title     | yes    |
| Event           | start, end (or none), title                                        | yes    |
| Tracker reading | the value (it must fit the tracker: in range, one of its options…) | yes    |

- Every hand edit or delete marks the thing **edited by you** (with when). From then on nothing
  automatic overwrites it: processing the capture again leaves it alone, and **Undo** of the
  suggestion that made it is refused.
- Deletes are soft, like everywhere else.
- An event can't end before it starts; a change that would do that is refused.

## 4. Editing and deleting a bullet

- **Edit:** the bullet is read again and split into thoughts again (kinds you set by hand are
  kept). Suggestions that still match are **kept** (including ones you already accepted). New findings are **added**. Things that no longer appear in the text are
  **withdrawn**: waiting suggestions disappear, and applied ones are undone. All of this happens
  in one step, so you never see a half-updated mix.
- **Delete** offers three choices:
  - **Cancel.**
  - **Delete + extractions:** the bullet and everything it produced go away.
  - **Delete but keep extractions:** only the bullet goes. Tasks, events and entries it created
    stay. Suggestions still waiting are withdrawn.

  Either way, the capture's own parts go with it: its recording, transcripts, thoughts and open
  questions.

Nothing is ever erased for good. Deletes are "soft", so they can be recovered later.

## 5. Sync, briefly

- The phone keeps an **outbox**: a list of everything you did that the server hasn't confirmed
  yet. It's saved in the same instant as the change itself, so nothing can slip between the two.
- When the app comes to the foreground, when the network comes back, and now and then in the
  background (if iOS allows), the phone:
  1. **pushes** the outbox, oldest first; then
  2. **uploads** any recording the server doesn't fully have yet (only after the server has
     accepted its bullet), continuing interrupted uploads where they stopped; then
  3. **pulls** everything that changed on the server since last time: bullet states, thoughts,
     questions, suggestions, transcripts, recordings' upload states, and the
     tasks/events/trackers/entries/activities they produced.
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
`text`, `captured_at`, `timezone`, `source`, optional `text_edited_by_user`, and for a voice note
optional `audio`: recording `id`, `mime_type`, `duration_ms`, `size_bytes`, `sha256` and the
device `draft` transcript, optional `answers_question_id`, and optional `resolves_thought_id`),
`bullet.edit` (`text`, `edited_at`; marks the text user-edited), `bullet.delete`
(`mode: cascade | keep_extractions`), `bullet.retry` (a `failed` bullet, or a settled one with
`text_from_draft`; anything else is a no-op), `suggestion.accept` (optional edited
`payload`), `suggestion.reject`, `suggestion.undo`, `thought.reclassify` (`thought_id`, `kind`),
`thought.resolve` / `thought.unresolve` (`thought_id`), `question.dismiss` (`question_id`),
`question.answer` (`question_id`, `option`), `question.snooze` (`question_id`; reflective only),
`question.pick_evergreen` (a client-minted `question_id`, `template_id`), the slice 3 corrections
`link.veto` (`link_id`), `theme.rename` (`theme_id`, `name`, 1–60 characters), `theme.retire`
(`theme_id`), `theme.merge` (`theme_id`, `into_theme_id`), `noticed.open` / `noticed.dismiss`
(`card_id`), and the manual edits: `task.update` (`task_id`,
`patch` of `status: todo | done`, `due_at`, `title`), `task.delete` (`task_id`), `event.update`
(`event_id`, `patch` of `starts_at`, `ends_at`, `title`), `event.delete` (`event_id`),
`tracker_entry.update` (`tracker_entry_id`, `patch: { value }`) and `tracker_entry.delete`
(`tracker_entry_id`). A `patch` carries only what changes (at least one field, no others).

Who changed what by hand: tasks, events and tracker entries carry `user_edited_at` (null until a
manual edit or delete). Thoughts carry `resolved_at` and `resolved_by_bullet_id`; questions
carry `answer_option`; bullets carry `resolves_thought_id` and `text_from_draft`. Older rows without
them read as null (`text_from_draft`: false).

Reflective questions (2026-10-19): questions carry `kind` (`clarifying` | `reflective`), `origin`
(`capture` | `open_loop` | `evergreen`), `snoozed_until`, `snooze_count` and `template_id`, and
`status` may be `snoozed`. A question's `source_bullet_id` is null for an evergreen question (it
has no capture). Thoughts carry `sensitive` and `never_ask`. Older rows read as `clarifying`,
`capture`, null, 0, null, false, false.

Connections (2026-10-19): questions carry `related_thought_id` (a `connection` question's earlier
thought; null otherwise) and `origin` may be `connection`, whose `options` are `Same thing` and
`Different`. A `thought_links` row: `a_thought_id`, `a_bullet_id` (the earlier), `b_thought_id`,
`b_bullet_id`, `type`, `visible_from` (`both` | `a` | `b`: which capture's Related shows it;
older rows read as `both`). A `themes` row: `name` (the user's, else the model's; null until named),
`named_by_user`, `status`, `merged_into_theme_id`, `thought_count`, `day_count`, `first_seen_at`,
`last_seen_at`. A `theme_thoughts` row: `theme_id`, `thought_id`, `bullet_id`. A `noticed_cards`
row: `theme_id`, `headline`, `quotes` (`thought_id`, `bullet_id`, `text`; up to 3), `count`,
`days`, `status`, `opened_at`, `resolved_at`. Hidden for sensitivity means pulled as
`state: 'deleted'`. Older rows read as null / `capture`.

Provenance: every thing and suggestion carries `source_bullet_id` (the capture) and
`source_thought_id` (the thought; null for things made by hand or before thoughts existed).

The response is `{ results: [{ op_id, status: applied | duplicate | rejected, error? }],
server_time }`. Rejection codes are `not_found`, `invalid`, `conflict` and `stale`. A rejected op
is final. For the new ops: editing or resolving something deleted, a reading that doesn't fit its
tracker, resolving a thought that isn't `to_check`/`question`, or an option the question doesn't
offer are `invalid` (so is `question.answer` or `question.snooze` on the wrong kind of question,
or picking an unknown evergreen template; a pick over the open limit is `conflict`); answering a
question whose suggestion is no longer waiting (dismissed, or its
result edited by you) is `conflict`. Re-sending the same answer, resolve or edit is harmless.
Accepting a `thought_resolve` whose loop was closed meanwhile is `conflict`; renaming or merging a
retired theme is `invalid`; vetoing a link, retiring a theme or opening a card twice is a
`duplicate`.

**`GET /sync/pull?cursor=<opaque>&limit=<1..500>`** returns `{ changes: { bullets, suggestions,
tasks, events, trackers, tracker_entries, activities, audio_attachments, transcripts,
thoughts, questions, thought_links, themes, theme_thoughts, noticed_cards }, cursor,
has_more, server_time }`. Rows
are full current versions, soft-deleted ones included (`state: 'deleted'`). Omit `cursor` for a
full sync. Repeat while `has_more`.

**Audio upload** (resumable, idempotent by recording id; only after its `bullet.create` was
acked). `GET /sync/audio/:id/status` returns `{ attachment_id, size_bytes, received_bytes,
upload_status }`. `PUT /sync/audio/:id` sends the next bytes (at most 4 MiB per request) as
`application/octet-stream` with header `upload-offset: <received_bytes>`, and returns the same
status. A wrong offset answers `409 conflict`; the client re-reads the status and resends from
there. The request completing the file checks the
`sha256` (if one was given); a mismatch answers `422 unprocessable` and restarts the upload at 0.
Re-sending a finished upload is a no-op. `GET /sync/audio/:id` downloads the recording; it
honours a single `Range: bytes=` request (`206` with `Content-Range`, `416` past the end) so
players can seek.

**Timestamps** are epoch milliseconds. **IDs** are UUID v4. Errors use the envelope
`{ error: { code, message } }` with `401 unauthorized`, `400 bad_request`, `404 not_found`,
`409 conflict`, `413 payload_too_large`, `422 unprocessable` and `500 internal`.
