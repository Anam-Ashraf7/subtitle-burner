# Job API schema — Level 2 (Voiceover) & Level 3 (Manipulate heads)

`schema_version: "1.0"` · one `POST` per job · async with callback.

---

## 1. Design principles

1. **One envelope, per-level blocks.** Every job shares the same top-level shape (`template`,
   `source_video`, `script`, `characters`, `output`). Only the per-character block changes:
   `voice` for L2, `head` for L3. Adding L4 later = adding one block, not a new contract.
2. **Characters are first-class.** Everything the user configures (a voice prompt, a face to
   insert) hangs off a **character**, not off a line. Lines just reference `character_id`.
3. **Spoken text is separated from stage directions.** TTS must never read
   *"(They swap tools, mix solutions)"* aloud. See §3.
4. **IDs are stable and slugged** so the same character survives a template re-upload.

---

## 2. Common envelope

```jsonc
{
  "schema_version": "1.0",
  "job_id": "b3f1c2a4-...",          // client-generated UUID (idempotency key)
  "level": 2,                         // 0 | 1 | 2 | 3
  "created_at": "2026-07-22T10:04:11Z",

  "template": {
    "id": "lab-mask-convo",
    "name": "Lab Mask Convo",
    "type": 2,                        // template type from the xlsx
    "source_file": "master.xlsx"
  },

  // The video produced by the generator step (the form). Always an S3 URL.
  "source_video": {
    "url": "s3://xavier-videos/generated/8f2c/lab-mask-convo.mp4",
    "duration_sec": 26.4,
    "width": 608, "height": 1080, "fps": 25
  },

  "script":       { /* §3 */ },
  "characters":   [ /* §4 (L2) or §5 (L3) */ ],

  // Values the user typed for [Placeholders] in the sheet
  "placeholders": { "FullNameX": "Zohran Mamdani", "OfficeX": "Mayor", "CityX": "New York" },

  // The details form (kept for record / personalisation)
  "form": {
    "full_name": "Zohran Mamdani", "email": "a@b.com", "position": "Mayor",
    "state": "New York", "city": "New York", "county": "", "party": "democrat", "style": "realistic"
  },

  "output": {
    "bucket": "xavier-videos",
    "key_prefix": "jobs/b3f1c2a4/",
    "formats": ["mp4"],
    "deliver": ["video", "srt", "audio_stems"]
  },

  "callback_url": "https://api.xavier.ai/webhooks/jobs"
}
```

---

## 3. `script` — subtitles as JSON (from the xlsx)

```jsonc
"script": {
  "intro": [ { "id": "intro-0", "text": "The party of Democrat Zohran Mamdani has some novel solutions for you.", "duration_sec": 4.1 } ],
  "outro": [ { "id": "outro-0", "text": "Trust your common sense.", "duration_sec": 1.7 } ],

  "subtitles": [
    {
      "id": "sub-0",
      "index": 0,
      "start_sec": 1.0,
      "end_sec": 4.0,
      "character_id": "scientist-1",
      "speaker_label": "Scientist 1",
      "text": "Comrade, our Democratic Socialists finally have cracked it! Free sh*t for everyone!",
      "action": null,                    // stage direction — NEVER spoken
      "direction": "insert voiceover"    // parenthetical from the Person column
    },
    {
      "id": "sub-3",
      "index": 3,
      "start_sec": 11.0,
      "end_sec": 12.0,
      "character_id": "scientist-2",
      "speaker_label": "Scientist 2",
      "text": "What about inflation?",
      "action": "They swap tools, mix solutions",   // <- pulled OUT of the text
      "direction": null
    }
  ]
}
```

**Parsing rules applied to the sheet (already implemented):**

| Sheet value | → |
|---|---|
| `Person` = `Scientist 1 (Insert voiceover)` | `speaker_label: "Scientist 1"`, `direction: "insert voiceover"` |
| `Person` = `Scientist 1` (later rows) | same `character_id: "scientist-1"` |
| `text` = `(They swap tools) What about inflation?` | `action: "They swap tools"`, `text: "What about inflation?"` |
| `timestamp_start` = `:07` / `00:00:07` / Excel time | `start_sec: 7.0` |
| `[FullNameX]` in text | substituted before send; raw token recorded in `placeholders` |

---

## 4. Level 2 — `characters[].voice`

The user writes **one prompt per character**; every line that character speaks uses it.

```jsonc
"characters": [
  {
    "id": "scientist-1",
    "name": "Scientist 1",
    "is_group": false,
    "members": [],
    "line_ids": ["sub-0", "sub-2", "sub-4", "sub-7"],
    "line_count": 4,
    "total_speech_sec": 9.0,

    "voice": {
      "prompt": "Older male, thick Russian accent, manic and gleeful — mad-scientist energy",
      "language": "en-US",
      "voice_id": null,            // set to pin a known voice; null = pick from prompt
      "provider": "auto",          // auto | elevenlabs | openai | ...
      "settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0.4, "speed": 1.0 }
    }
  },
  {
    "id": "both-in-unison",
    "name": "Both, in unison",
    "is_group": true,
    "members": ["scientist-1", "scientist-2"],   // needs the sheet to declare this (§6)
    "line_ids": ["sub-9"],
    "voice": { "prompt": "Both voices together, shouted in unison", "language": "en-US" }
  }
],

"audio": {
  "keep_original_audio": false,
  "original_gain_db": -30,          // used when keep_original_audio = true
  "music_url": null,
  "normalize_lufs": -14,
  "fit_to_timing": "fit"            // natural | fit (time-stretch to the cue) | pad
}
```

> **`fit_to_timing` matters.** Generated speech rarely matches the cue length exactly.
> `fit` stretches to `start_sec…end_sec`, `pad` keeps natural pace and pads silence,
> `natural` ignores cue timing and re-flows.

---

## 5. Level 3 — `characters[].head`

The `Person` column already encodes *who to insert* and *which on-screen person to replace*:
`Nancy Pelosi (older woman -- insert head)`.

```jsonc
"characters": [
  {
    "id": "nancy-pelosi",
    "name": "Nancy Pelosi",
    "line_ids": ["sub-0"],
    "appears": [ { "start_sec": 13.0, "end_sec": 15.0 } ],

    "head": {
      "operation": "insert_head",        // insert_head | face_swap
      "target_role": "older woman",      // which on-screen person to replace
      "target_track_id": null,           // optional explicit track if you pre-detect faces
      "reference_images": [
        "s3://xavier-assets/faces/nancy-pelosi/01.jpg",
        "s3://xavier-assets/faces/nancy-pelosi/02.jpg"
      ],
      "preserve_expression": true
    }
  }
],

"lipsync": {
  "enabled": true,
  "driver": "generated_audio",   // generated_audio (from a level-2 job) | original_audio
  "source_job_id": "b3f1c2a4-..." // optional: chain onto the L2 result
}
```

**Chaining L2 → L3.** If a job needs both new voices *and* swapped heads, send L2 first, then
send L3 with `source_video.url` = the L2 output and `lipsync.source_job_id` = the L2 job.

---

## 6. What the next xlsx should carry

To make character mapping deterministic (rather than parsed out of prose), the sheet ideally adds:

| Column | Why |
|---|---|
| `character_id` | Stable slug per speaker; survives renames. Falls back to slug(`Person`). |
| `character_group` | Members for lines like *"Both, in unison"* → `scientist-1,scientist-2`. |
| `action` | Stage direction in its own column instead of parentheses inside `text`. |
| `target_role` (L3) | The on-screen person to replace, e.g. `older woman`. |
| `reference_asset` (L3) | URL/key of the face reference for that character. |

Until then the parser derives all of these from `Person` + parentheses, which works but is
sensitive to typos (e.g. `(FullNameX]` and a stray `"` already exist in the current sheet).

---

## 7. Responses

**Ack (sync):**
```json
{ "job_id": "b3f1c2a4-...", "status": "queued", "accepted_at": "2026-07-22T10:04:12Z", "estimated_sec": 900 }
```

**Callback (async):**
```json
{
  "job_id": "b3f1c2a4-...",
  "status": "succeeded",
  "outputs": {
    "video_url": "s3://xavier-videos/jobs/b3f1c2a4/final.mp4",
    "srt_url":   "s3://xavier-videos/jobs/b3f1c2a4/subs.srt",
    "audio_stems": [ { "character_id": "scientist-1", "url": "s3://.../scientist-1.wav" } ]
  },
  "error": null,
  "finished_at": "2026-07-22T10:18:40Z"
}
```

**Failure:** `status: "failed"`, `error: { "code": "TTS_PROVIDER_ERROR", "message": "...", "retryable": true }`.

**Status codes:** `queued → running → succeeded | failed | cancelled`.
