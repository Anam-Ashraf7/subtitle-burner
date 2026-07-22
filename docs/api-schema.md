# Job API schema — Level 2 (Voiceover) & Level 3 (Manipulate heads)

`schema_version: "1.1"` · one `POST /api/v1/jobs` per job · async with callback.

**Goal: the xlsx is translated to JSON with *nothing lost*.** Every row, every column, every
timestamp — including the `title` / `description` meta rows — survives the trip.

---

## 1. Principles

1. **Lossless.** Each sheet row becomes an object; the original cell values are kept verbatim in
   `source_row` alongside the parsed/normalised values. Round-tripping back to a sheet is possible.
2. **One envelope, per-level blocks.** Every level shares the same top level. Only the
   per-character block changes: `voice` (L2), `head` (L3).
3. **Characters are first-class.** The user configures a character once (a voice prompt, a face);
   lines reference `character_id`. N characters = N entries — see §4 for the full 3-character case.
4. **Spoken text is separated from stage directions.** TTS must never say
   *"(They swap tools, mix solutions)"*.
5. **Every timestamp is carried twice**: `raw` (exactly as typed in the sheet, e.g. `":07"`) and
   `sec` (parsed float). Meta/label rows keep their label (`"title"`, `"intro"`, `"outro"`).

---

## 2. Envelope

```jsonc
{
  "schema_version": "1.1",
  "job_id": "b3f1c2a4-7d1e-4a90-9d33-2f5c1a0e77bd",   // client UUID = idempotency key
  "level": 2,
  "created_at": "2026-07-22T10:04:11Z",
  "callback_url": "https://api.xavier.ai/webhooks/jobs",

  "template": {
    "id": "lab-mask-convo",
    "name": "Lab Mask Convo",
    "template_type": 2,          // "Template type" column
    "template_id": null,         // "template_id" column (1111 for dimitri, blank here)
    "template_name": "lab mask convo",
    "source_file": "master.xlsx",
    "sheet": "Sheet",
    "row_range": [46, 61]
  },

  "source_video": {              // produced by the generator step (the form)
    "url": "s3://xavier-videos/generated/8f2c/lab-mask-convo.mp4",
    "duration_sec": 26.4, "width": 608, "height": 1080, "fps": 25
  },

  "meta":       { /* §3 — title & description rows */ },
  "script":     { /* §3 — intro / subtitles / outro */ },
  "characters": [ /* §4 (L2) or §5 (L3) */ ],
  "audio":      { /* §4 */ },

  "placeholders": {
    "resolved": { "FullNameX": "Zohran Mamdani" },
    "found":    ["FullNameX"]        // every [token] detected in this template
  },

  "form": {
    "full_name": "Zohran Mamdani", "email": "a@b.com", "position": "Mayor",
    "state": "New York", "city": "New York", "county": "", "party": "democrat", "style": "realistic"
  },

  "output": {
    "bucket": "xavier-videos", "key_prefix": "jobs/b3f1c2a4/",
    "formats": ["mp4"], "deliver": ["video", "srt", "audio_stems"]
  }
}
```

---

## 3. `meta` + `script` — every row preserved

The `title` / `description` rows (`Person = "meta data"`) are **not** rendered into the video, but
they're carried for YouTube/publishing:

```jsonc
"meta": {
  "title": {
    "text": "Mad scientists are cooking up toxic ideas for you, your family, your community, your nation",
    "length_characters": 91,
    "source_row": { "row": 46, "timestamp_start": "title", "timestamp_end": "title", "Person": "meta data" }
  },
  "description": {
    "text": "Desperate to regain power, Democrats are toying with their party's chemistry, allowing radical ideas into the mix to stir their base.",
    "length_characters": 132,
    "source_row": { "row": 47, "timestamp_start": "description", "timestamp_end": "description", "Person": "meta data" }
  }
}
```

```jsonc
"script": {
  "intro": [
    {
      "id": "intro-0", "index": 0, "kind": "black_screen",
      "text": "The party of Democrat Zohran Mamdani has some novel solutions for you.",
      "text_template": "The party of Democrat [FullNameX] has some novel solutions for you.",
      "duration_sec": 4.6, "duration_source": "auto",     // auto = derived from length
      "source_row": { "row": 48, "timestamp_start": "intro", "timestamp_end": "intro",
                      "Person": "black screen",
                      "text": "The party of Democrat (FullNameX] has some novel solutions for you." }
    }
  ],

  "subtitles": [ /* §4 — all 10 lines */ ],

  "outro": [
    { "id": "outro-0", "index": 0, "kind": "black_screen", "text": "Trust your common sense.",
      "duration_sec": 1.6, "source_row": { "row": 59, "Person": "black screen" } },
    { "id": "outro-1", "index": 1, "kind": "black_screen", "text": "Vote for real solutions.",
      "duration_sec": 1.6, "source_row": { "row": 60, "Person": "black screen" } },
    { "id": "outro-2", "index": 2, "kind": "black_screen",
      "text": "Vote for Republican Zohran Mamdani on November 3.",
      "text_template": "Vote for Republican [FullNameX] on November 3.",
      "duration_sec": 3.3, "source_row": { "row": 61, "Person": "black screen" } }
  ]
}
```

---

## 4. Level 2 — full worked example (**3 characters, 10 lines**)

This is the real *Lab Mask Convo* sheet. It has **Scientist 1**, **Scientist 2**, and a group
speaker **Both, in unison** — so it shows exactly how N characters scale.

### 4a. `script.subtitles` — every line

```jsonc
"subtitles": [
  { "id": "sub-0", "index": 0,
    "start": { "raw": ":01", "sec": 1.0 }, "end": { "raw": ":04", "sec": 4.0 }, "duration_sec": 3.0,
    "character_id": "scientist-1", "speaker_label": "Scientist 1",
    "text": "Comrade, our Democratic Socialists finally have cracked it! Free sh*t for everyone!",
    "action": null, "direction": "Insert voiceover",
    "source_row": { "row": 49, "Person": "Scientist 1 (Insert voiceover)",
                    "text": "Comrade, our Democratic Socialists finally have cracked it! Free sh*t for everyone!" } },

  { "id": "sub-1", "index": 1,
    "start": { "raw": ":05", "sec": 5.0 }, "end": { "raw": ":06", "sec": 6.0 }, "duration_sec": 1.0,
    "character_id": "scientist-2", "speaker_label": "Scientist 2",
    "text": "Genius. How do we pay for it?",
    "action": null, "direction": "insert voiceover",
    "source_row": { "row": 50, "Person": "Scientist 2 (insert voiceover)" } },

  { "id": "sub-2", "index": 2,
    "start": { "raw": ":07", "sec": 7.0 }, "end": { "raw": ":09", "sec": 9.0 }, "duration_sec": 2.0,
    "character_id": "scientist-1", "speaker_label": "Scientist 1",
    "text": "We tax the rich ... and then the upper middle class ... and then ... you!",
    "action": null, "direction": null,
    "source_row": { "row": 51, "Person": "Scientist 1" } },

  { "id": "sub-3", "index": 3,
    "start": { "raw": ":11", "sec": 11.0 }, "end": { "raw": ":12", "sec": 12.0 }, "duration_sec": 1.0,
    "character_id": "scientist-2", "speaker_label": "Scientist 2",
    "text": "What about inflation?",
    "action": "They swap tools, mix solutions",          // pulled OUT of the dialogue
    "direction": null,
    "source_row": { "row": 52, "Person": "Scientist 2",
                    "text": "(They swap tools, mix solutions) What about inflation?\"" } },

  { "id": "sub-4", "index": 4,
    "start": { "raw": ":13", "sec": 13.0 }, "end": { "raw": ":14", "sec": 14.0 }, "duration_sec": 1.0,
    "character_id": "scientist-1", "speaker_label": "Scientist 1",
    "text": "Freeze the prices!", "action": null, "direction": null,
    "source_row": { "row": 53, "Person": "Scientist 1" } },

  { "id": "sub-5", "index": 5,
    "start": { "raw": ":15", "sec": 15.0 }, "end": { "raw": ":16", "sec": 16.0 }, "duration_sec": 1.0,
    "character_id": "scientist-2", "speaker_label": "Scientist 2",
    "text": "A new solution! I love it!", "action": null, "direction": null,
    "source_row": { "row": 54, "Person": "Scientist 2" } },

  { "id": "sub-6", "index": 6,
    "start": { "raw": ":18", "sec": 18.0 }, "end": { "raw": ":19", "sec": 19.0 }, "duration_sec": 1.0,
    "character_id": "scientist-2", "speaker_label": "Scientist 2",
    "text": "Uh, what if it all explodes?",
    "action": "Scientist 1 holds up red vial proudly, Scientist 2 examines beaker",
    "direction": null,
    "source_row": { "row": 55, "Person": "Scientist 2" } },

  { "id": "sub-7", "index": 7,
    "start": { "raw": ":20", "sec": 20.0 }, "end": { "raw": ":22", "sec": 22.0 }, "duration_sec": 2.0,
    "character_id": "scientist-1", "speaker_label": "Scientist 1",
    "text": "Then we blame capitalism and pass another trillion-dollar bill!",
    "action": null, "direction": null,
    "source_row": { "row": 56, "Person": "Scientist 1" } },

  { "id": "sub-8", "index": 8,
    "start": { "raw": ":23", "sec": 23.0 }, "end": { "raw": ":24", "sec": 24.0 }, "duration_sec": 1.0,
    "character_id": "scientist-2", "speaker_label": "Scientist 2",
    "text": "Brilliant. The science is settled.", "action": null, "direction": null,
    "source_row": { "row": 57, "Person": "Scientist 2" } },

  { "id": "sub-9", "index": 9,
    "start": { "raw": ":25", "sec": 25.0 }, "end": { "raw": ":26", "sec": 26.0 }, "duration_sec": 1.0,
    "character_id": "both-in-unison", "speaker_label": "Both, in unison",
    "text": "Trust science!", "action": null, "direction": null,
    "source_row": { "row": 58, "Person": "Both, in unison" } }
]
```

### 4b. `characters` — one entry per speaker

**This is the answer to "what if there's a Scientist 2?"** — each speaker gets its own object with
its own prompt and its own `line_ids`. Adding a 4th/5th character just appends more objects.

```jsonc
"characters": [
  {
    "id": "scientist-1",
    "name": "Scientist 1",
    "aliases": ["Scientist 1 (Insert voiceover)"],   // every raw Person spelling seen
    "is_group": false,
    "members": [],
    "line_ids": ["sub-0", "sub-2", "sub-4", "sub-7"],
    "line_count": 4,
    "total_speech_sec": 8.0,
    "first_appearance_sec": 1.0,

    "voice": {
      "prompt": "Older male, thick Russian accent, manic and gleeful — mad-scientist energy",
      "language": "en-US",
      "voice_id": null,               // pin a known voice, or null = derive from prompt
      "provider": "auto",
      "settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0.4, "speed": 1.0 }
    }
  },

  {
    "id": "scientist-2",
    "name": "Scientist 2",
    "aliases": ["Scientist 2 (insert voiceover)"],
    "is_group": false,
    "members": [],
    "line_ids": ["sub-1", "sub-3", "sub-5", "sub-6", "sub-8"],
    "line_count": 5,
    "total_speech_sec": 5.0,
    "first_appearance_sec": 5.0,

    "voice": {
      "prompt": "Younger male, nasal and eager, always impressed — the yes-man of the pair",
      "language": "en-US",
      "voice_id": null,
      "provider": "auto",
      "settings": { "stability": 0.45, "similarity_boost": 0.8, "style": 0.55, "speed": 1.05 }
    }
  },

  {
    "id": "both-in-unison",
    "name": "Both, in unison",
    "aliases": [],
    "is_group": true,
    "members": ["scientist-1", "scientist-2"],   // needs the sheet to declare this — §6
    "line_ids": ["sub-9"],
    "line_count": 1,
    "total_speech_sec": 1.0,
    "first_appearance_sec": 25.0,

    "voice": {
      "mode": "layered",                 // render each member and mix, vs one blended voice
      "prompt": "Both voices shouted together in unison, triumphant",
      "language": "en-US",
      "settings": { "speed": 1.0 }
    }
  }
],

"audio": {
  "keep_original_audio": false,
  "original_gain_db": -30,
  "music_url": null,
  "normalize_lufs": -14,
  "fit_to_timing": "fit",        // natural | fit (time-stretch into start..end) | pad
  "max_stretch": 1.25            // refuse to squash speech beyond this to hit a cue
}
```

> **Why `fit_to_timing` + `max_stretch` matter:** `sub-1` is a 1.0 s cue holding
> *"Genius. How do we pay for it?"* — that's ~1.6 s of natural speech. The renderer needs an
> explicit rule: stretch, pad, or let it run long.

---

## 5. Level 3 — full worked example (**3 characters**)

Real *Crouching Tiger* sheet. The `Person` column already encodes both the real person **and**
the on-screen role to replace: `Nancy Pelosi (older woman -- insert head)`.

```jsonc
"characters": [
  {
    "id": "nancy-pelosi", "name": "Nancy Pelosi",
    "aliases": ["Nancy Pelosi (older woman -- insert head)"],
    "line_ids": ["sub-0"], "line_count": 1,
    "appears": [ { "start_sec": 13.0, "end_sec": 15.0 } ],
    "head": {
      "operation": "insert_head",
      "target_role": "older woman",
      "target_track_id": null,
      "reference_images": ["s3://xavier-assets/faces/nancy-pelosi/01.jpg"],
      "preserve_expression": true
    }
  },
  {
    "id": "chuck-schumer", "name": "Chuck Schumer",
    "aliases": ["Chuck Schumer (man -- insert head)"],
    "line_ids": ["sub-1", "sub-2", "sub-4"], "line_count": 3,
    "appears": [ { "start_sec": 23.0, "end_sec": 27.0 }, { "start_sec": 31.0, "end_sec": 34.0 } ],
    "head": {
      "operation": "insert_head", "target_role": "man", "target_track_id": null,
      "reference_images": ["s3://xavier-assets/faces/chuck-schumer/01.jpg"],
      "preserve_expression": true
    }
  },
  {
    "id": "alexandria-ocasio-cortez", "name": "Alexandria Ocasio-Cortez",
    "aliases": ["Alexandria Ocasio-Cortez (younger woman -- insert head)"],
    "line_ids": ["sub-3", "sub-5"], "line_count": 2,
    "appears": [ { "start_sec": 28.0, "end_sec": 30.0 }, { "start_sec": 35.0, "end_sec": 37.0 } ],
    "head": {
      "operation": "insert_head", "target_role": "younger woman", "target_track_id": null,
      "reference_images": ["s3://xavier-assets/faces/aoc/01.jpg"],
      "preserve_expression": true
    }
  }
],

"lipsync": {
  "enabled": true,
  "driver": "generated_audio",        // generated_audio (chain a L2 job) | original_audio
  "source_job_id": "b3f1c2a4-..."     // the L2 job whose audio drives the mouths
}
```

**Chaining L2 → L3:** run L2 first, then send L3 with `source_video.url` = the L2 output and
`lipsync.source_job_id` = the L2 `job_id`.

---

## 6. Sheet → JSON field map (nothing dropped)

| xlsx column | JSON path |
|---|---|
| `Template type` | `template.template_type` |
| `template_id` | `template.template_id` |
| `template_name` | `template.template_name` (+ slug → `template.id`) |
| `timestamp_start` | `start.raw` + `start.sec` — or the label (`title`/`intro`/`outro`) |
| `timestamp_end` | `end.raw` + `end.sec` |
| `Person` = `meta data` | `meta.title` / `meta.description` |
| `Person` = `black screen` | `script.intro[]` / `script.outro[]` (`kind: "black_screen"`) |
| `Person` = `Name (direction)` | `speaker_label` + `direction`; slug → `character_id`; raw → `aliases[]` |
| `text` | `text` (spoken) + `action` (parenthetical) + `text_template` (pre-substitution) |
| `length_characters` | `meta.*.length_characters` |
| *(row number)* | `source_row.row` |
| *(whole raw row)* | `source_row` |

### What the next xlsx should add
| Column | Why |
|---|---|
| `character_id` | Stable slug; survives renames/typos. Today derived from `Person`. |
| `character_group` | Members for *"Both, in unison"* → `scientist-1,scientist-2`. |
| `action` | Stage direction in its own column instead of parentheses inside `text`. |
| `target_role` (L3) | On-screen person to replace (`older woman`). Today parsed from `Person`. |
| `reference_asset` (L3) | Face reference URL per character. |
| `voice_prompt` (L2) | Optional default voice prompt per character. |

Current data snags this would fix: `(FullNameX]` (row 48, wrong bracket) and a stray `"` at the end of row 52.

---

## 7. Responses

**Ack:** `{ "job_id": "...", "status": "queued", "accepted_at": "...", "estimated_sec": 900 }`

**Callback:**
```json
{
  "job_id": "b3f1c2a4-...",
  "status": "succeeded",
  "outputs": {
    "video_url": "s3://xavier-videos/jobs/b3f1c2a4/final.mp4",
    "srt_url":   "s3://xavier-videos/jobs/b3f1c2a4/subs.srt",
    "audio_stems": [
      { "character_id": "scientist-1", "url": "s3://.../scientist-1.wav" },
      { "character_id": "scientist-2", "url": "s3://.../scientist-2.wav" },
      { "character_id": "both-in-unison", "url": "s3://.../both.wav" }
    ]
  },
  "error": null,
  "finished_at": "2026-07-22T10:18:40Z"
}
```

**Failure:** `status: "failed"`, `error: { "code": "TTS_PROVIDER_ERROR", "message": "...", "retryable": true }`
**Status flow:** `queued → running → succeeded | failed | cancelled`
