# Voiceover (audio replacement) API — standalone

`POST /v1/voiceover` · async · `schema_version: "1.0"`

Independent service. It takes **a video + timed lines + a voice per character**, generates the
speech, lays it onto the video, and returns a new video. Nothing else is required.

**Deliberately NOT sent** (the caller's business, not this API's):
publishing title/description · intro/outro black screens · subtitle styling · the details form
(name/email/party) · `[placeholder]` tokens (already substituted) · original sheet rows · stage
directions (they're never spoken, so they're stripped before sending).

---

## Request

```jsonc
{
  "job_id": "b3f1c2a4-7d1e-4a90-9d33-2f5c1a0e77bd",   // idempotency key
  "callback_url": "https://api.xavier.ai/webhooks/voiceover",

  "video_url": "s3://xavier-videos/generated/8f2c/lab-mask-convo.mp4",
  "language": "en-US",

  // How to reconcile generated speech with the line's time window.
  "timing": { "mode": "fit", "max_stretch": 1.25 },

  // What happens to the video's existing audio.
  "mix": { "keep_original_audio": false, "original_gain_db": -30, "normalize_lufs": -14 },

  "characters": [ /* one per speaker — the voice the user asked for */ ],
  "lines":      [ /* every spoken line, in order */ ],

  "output": { "bucket": "xavier-videos", "key_prefix": "voiceover/b3f1c2a4/", "deliver": ["video", "stems"] }
}
```

---

## Full example — 3 characters, 10 lines (real *Lab Mask Convo* script)

```json
{
  "job_id": "b3f1c2a4-7d1e-4a90-9d33-2f5c1a0e77bd",
  "callback_url": "https://api.xavier.ai/webhooks/voiceover",
  "video_url": "s3://xavier-videos/generated/8f2c/lab-mask-convo.mp4",
  "language": "en-US",
  "timing": { "mode": "fit", "max_stretch": 1.25 },
  "mix": { "keep_original_audio": false, "original_gain_db": -30, "normalize_lufs": -14 },

  "characters": [
    {
      "id": "scientist-1",
      "name": "Scientist 1",
      "voice_prompt": "Older male, thick Russian accent, manic and gleeful — mad-scientist energy",
      "voice_id": null,
      "settings": { "speed": 1.0, "stability": 0.5, "style": 0.4 }
    },
    {
      "id": "scientist-2",
      "name": "Scientist 2",
      "voice_prompt": "Younger male, nasal and eager, always impressed — the yes-man of the pair",
      "voice_id": null,
      "settings": { "speed": 1.05, "stability": 0.45, "style": 0.55 }
    },
    {
      "id": "both-in-unison",
      "name": "Both, in unison",
      "voice_prompt": "Both voices shouted together in unison, triumphant",
      "voice_id": null,
      "members": ["scientist-1", "scientist-2"],
      "settings": { "speed": 1.0 }
    }
  ],

  "lines": [
    { "id": "L1",  "character_id": "scientist-1",   "start_sec": 1.0,  "end_sec": 4.0,  "text": "Comrade, our Democratic Socialists finally have cracked it! Free sh*t for everyone!" },
    { "id": "L2",  "character_id": "scientist-2",   "start_sec": 5.0,  "end_sec": 6.0,  "text": "Genius. How do we pay for it?" },
    { "id": "L3",  "character_id": "scientist-1",   "start_sec": 7.0,  "end_sec": 9.0,  "text": "We tax the rich ... and then the upper middle class ... and then ... you!" },
    { "id": "L4",  "character_id": "scientist-2",   "start_sec": 11.0, "end_sec": 12.0, "text": "What about inflation?" },
    { "id": "L5",  "character_id": "scientist-1",   "start_sec": 13.0, "end_sec": 14.0, "text": "Freeze the prices!" },
    { "id": "L6",  "character_id": "scientist-2",   "start_sec": 15.0, "end_sec": 16.0, "text": "A new solution! I love it!" },
    { "id": "L7",  "character_id": "scientist-2",   "start_sec": 18.0, "end_sec": 19.0, "text": "Uh, what if it all explodes?" },
    { "id": "L8",  "character_id": "scientist-1",   "start_sec": 20.0, "end_sec": 22.0, "text": "Then we blame capitalism and pass another trillion-dollar bill!" },
    { "id": "L9",  "character_id": "scientist-2",   "start_sec": 23.0, "end_sec": 24.0, "text": "Brilliant. The science is settled." },
    { "id": "L10", "character_id": "both-in-unison","start_sec": 25.0, "end_sec": 26.0, "text": "Trust science!" }
  ],

  "output": { "bucket": "xavier-videos", "key_prefix": "voiceover/b3f1c2a4/", "deliver": ["video", "stems"] }
}
```

Adding a 4th speaker = one more object in `characters` + lines pointing at its `id`. Nothing else changes.

---

## Field reference

| Field | Req | Default | Notes |
|---|---|---|---|
| `job_id` | ✔ | — | UUID. Idempotency key — re-POSTing the same id returns the existing job. |
| `callback_url` | ✔ | — | POSTed on completion/failure. |
| `video_url` | ✔ | — | S3 URI (or presigned https) of the video to re-voice. |
| `language` | | `"en-US"` | BCP-47. Per-character `language` overrides this. |
| `timing.mode` | | `"fit"` | `natural` = ignore the window · `fit` = time-stretch into it · `pad` = natural pace + silence. |
| `timing.max_stretch` | | `1.25` | Ceiling on `fit`. Beyond it, fall back to `pad` and report a warning. |
| `mix.keep_original_audio` | | `false` | `true` keeps the original bed under the new voices. |
| `mix.original_gain_db` | | `-30` | Only when keeping the original. |
| `mix.normalize_lufs` | | `-14` | Final loudness target. |
| `characters[].id` | ✔ | — | Stable slug. `lines[].character_id` must reference one. |
| `characters[].name` | | — | Human label for logs/stems. |
| `characters[].voice_prompt` | ✔* | — | The user's description of the voice. *Required unless `voice_id` is set. |
| `characters[].voice_id` | | `null` | Pin a known provider voice; wins over `voice_prompt`. |
| `characters[].members` | | `null` | Group speakers ("Both, in unison") — render each member and layer. |
| `characters[].settings` | | `{}` | `speed`, `stability`, `style` — provider hints, all optional. |
| `lines[].id` | ✔ | — | Stable id; used to key stems and per-line warnings. |
| `lines[].character_id` | ✔ | — | Who speaks it. |
| `lines[].start_sec` / `end_sec` | ✔ | — | Float seconds against `video_url`'s timeline. |
| `lines[].text` | ✔ | — | **Spoken words only** — stage directions already stripped. |
| `output.bucket` / `key_prefix` | ✔ | — | Where results land. |
| `output.deliver` | | `["video"]` | `video` and/or `stems` (per-character wav). |

---

## Responses

**Ack (sync):**
```json
{ "job_id": "b3f1c2a4-...", "status": "queued", "estimated_sec": 240 }
```

**Callback:**
```json
{
  "job_id": "b3f1c2a4-...",
  "status": "succeeded",
  "video_url": "s3://xavier-videos/voiceover/b3f1c2a4/final.mp4",
  "stems": [
    { "character_id": "scientist-1",    "url": "s3://.../scientist-1.wav" },
    { "character_id": "scientist-2",    "url": "s3://.../scientist-2.wav" },
    { "character_id": "both-in-unison", "url": "s3://.../both-in-unison.wav" }
  ],
  "warnings": [
    { "line_id": "L2", "code": "STRETCHED", "detail": "1.6s of speech fitted into a 1.0s window (1.6x)" }
  ],
  "error": null,
  "finished_at": "2026-07-22T10:18:40Z"
}
```

**Failure:** `status: "failed"`, `error: { "code": "...", "message": "...", "retryable": true }`
Codes: `VIDEO_UNREADABLE` · `UNKNOWN_CHARACTER_REF` · `TTS_PROVIDER_ERROR` · `TIMING_IMPOSSIBLE`
**Flow:** `queued → running → succeeded | failed`

> **Why `warnings` matters:** `L2` is a 1.0 s window holding *"Genius. How do we pay for it?"*
> (~1.6 s natural). The job should still succeed, but say what it had to do.
