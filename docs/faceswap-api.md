# Face swap & lip sync API — standalone

`POST /v1/faceswap` · async · `schema_version: "1.0"`

Independent service, and the twin of [`voiceover-api.md`](./voiceover-api.md). Same envelope, same
`characters` + `lines` shape — the **only** structural addition is a `face` object on each
character. It takes **a video + timed lines + a face per character**, swaps the faces and
lip-syncs them to the audio, and returns a new video.

**Deliberately NOT sent** (same exclusions as the voiceover API):
publishing title/description · intro/outro black screens · subtitle styling · the details form
(name/party/location) · `[placeholder]` tokens (already substituted) · original sheet rows ·
stage directions.

**Chaining:** when both Level 2 and Level 3 are selected, run voiceover first and pass its
`video_url` in here — the lip sync then matches the *new* speech, not the original. `lines[]` is
identical between the two calls, so the same array is reused verbatim.

---

## Request

```jsonc
{
  "video_url": "s3://xavier-videos/voiceover/b3f1c2a4/final.mp4",  // L2 output when chained
  "audio_url": "video", // if present

  "swap": { "mode": "face_and_lipsync", "identity_strength": 0.85, "restore_face": true },

  "characters": [ /* one per speaker — now carrying a face reference */ ],
  "lines":      [ /* every spoken line — same array sent to /v1/voiceover */ ],

  "output": { "bucket": "xavier-videos", "key_prefix": "faceswap/9c4e77a1/", "deliver": ["video"] }
}
```

---

## The one thing that's new: `characters[].face`

```jsonc
{
  "id": "scientist-1",
  "name": "Scientist 1",
  "face": {
    "image_url": "s3://xavier-uploads/faces/9c4e77a1/scientist-1.jpg",
    "images": [                       // optional extras — more angles = better identity lock
      "s3://xavier-uploads/faces/9c4e77a1/scientist-1-b.jpg"
    ],
    "target_ref": "auto"              // which on-screen face this replaces
  }
}
```

`target_ref` tells the service *whose* face on screen to replace:

| Value | Meaning |
|---|---|
| `"auto"` | Match by who is speaking during this character's `lines[]`. The default, and correct for dialogue. |
| `{ "track": 0 }` | Pin to a detected face track index, when auto-matching picks wrong. |
| `{ "bbox": [x, y, w, h], "at_sec": 3.2 }` | Point at the face directly on one frame; normalised 0–1 coords. |

---

## Full example — 3 characters, 10 lines (*Lab Mask Convo*)

```json
{
  "job_id": "9c4e77a1-2b30-4f18-8ac6-51d0e3b9f204",
  "callback_url": "https://api.xavier.ai/webhooks/faceswap",
  "video_url": "s3://xavier-videos/voiceover/b3f1c2a4/final.mp4",
  "audio_source": "video",
  "swap": { "mode": "face_and_lipsync", "identity_strength": 0.85, "restore_face": true },

  "characters": [
    {
      "id": "scientist-1",
      "name": "Scientist 1",
      "face": { "image_url": "s3://xavier-uploads/faces/9c4e77a1/scientist-1.jpg", "target_ref": "auto" }
    },
    {
      "id": "scientist-2",
      "name": "Scientist 2",
      "face": { "image_url": "s3://xavier-uploads/faces/9c4e77a1/scientist-2.jpg", "target_ref": "auto" }
    },
    {
      "id": "both-in-unison",
      "name": "Both, in unison",
      "members": ["scientist-1", "scientist-2"]
    }
  ],

  "lines": [
    { "id": "L1",  "character_id": "scientist-1",    "start_sec": 1.0,  "end_sec": 4.0,  "text": "Comrade, our Democratic Socialists finally have cracked it! Free sh*t for everyone!" },
    { "id": "L2",  "character_id": "scientist-2",    "start_sec": 5.0,  "end_sec": 6.0,  "text": "Genius. How do we pay for it?" },
    { "id": "L3",  "character_id": "scientist-1",    "start_sec": 7.0,  "end_sec": 9.0,  "text": "We tax the rich ... and then the upper middle class ... and then ... you!" },
    { "id": "L4",  "character_id": "scientist-2",    "start_sec": 11.0, "end_sec": 12.0, "text": "What about inflation?" },
    { "id": "L5",  "character_id": "scientist-1",    "start_sec": 13.0, "end_sec": 14.0, "text": "Freeze the prices!" },
    { "id": "L6",  "character_id": "scientist-2",    "start_sec": 15.0, "end_sec": 16.0, "text": "A new solution! I love it!" },
    { "id": "L7",  "character_id": "scientist-2",    "start_sec": 18.0, "end_sec": 19.0, "text": "Uh, what if it all explodes?" },
    { "id": "L8",  "character_id": "scientist-1",    "start_sec": 20.0, "end_sec": 22.0, "text": "Then we blame capitalism and pass another trillion-dollar bill!" },
    { "id": "L9",  "character_id": "scientist-2",    "start_sec": 23.0, "end_sec": 24.0, "text": "Brilliant. The science is settled." },
    { "id": "L10", "character_id": "both-in-unison", "start_sec": 25.0, "end_sec": 26.0, "text": "Trust science!" }
  ],

  "output": { "bucket": "xavier-videos", "key_prefix": "faceswap/9c4e77a1/", "deliver": ["video"] }
}
```

Note `both-in-unison` carries **no `face`** — it's a group speaker, so its `members` already point
at real faces. Both members get lip-synced across `L10`.

Adding a 4th speaker = one more object in `characters` (with its own `face`) + lines pointing at
its `id`. Nothing else changes.

---

## Field reference

Everything below `characters[].face` is shared with the voiceover API and behaves identically.

| Field | Req | Default | Notes |
|---|---|---|---|
| `job_id` | ✔ | — | UUID. Idempotency key. |
| `callback_url` | ✔ | — | POSTed on completion/failure. |
| `video_url` | ✔ | — | S3 URI of the video to alter. The L2 output when chained. |
| `audio_source` | | `"video"` | `video` = lip sync to its own track · or an S3 URI of a separate audio file. |
| `swap.mode` | | `"face_and_lipsync"` | `face_only` · `lipsync_only` · `face_and_lipsync`. |
| `swap.identity_strength` | | `0.85` | 0–1. Higher = closer to the uploaded face, lower = blends with the original. |
| `swap.restore_face` | | `true` | Run face restoration/upscale after the swap. |
| **`characters[].face.image_url`** | ✔* | — | **The uploaded photo.** *Required for every character that appears on screen; omit for group speakers. |
| **`characters[].face.images`** | | `[]` | Extra angles of the same person — improves identity consistency. |
| **`characters[].face.target_ref`** | | `"auto"` | Which on-screen face to replace — see the table above. |
| `characters[].id` | ✔ | — | Stable slug. `lines[].character_id` must reference one. |
| `characters[].name` | | — | Human label for logs. |
| `characters[].members` | | `null` | Group speakers — lip-sync every member across those lines. |
| `lines[].id` | ✔ | — | Stable id; keys per-line warnings. |
| `lines[].character_id` | ✔ | — | Who speaks it — this is what drives `target_ref: "auto"`. |
| `lines[].start_sec` / `end_sec` | ✔ | — | Float seconds against `video_url`'s timeline. |
| `lines[].text` | ✔ | — | Spoken words only. Used as a phoneme hint for the lip sync. |
| `output.bucket` / `key_prefix` | ✔ | — | Where results land. |
| `output.deliver` | | `["video"]` | `video` and/or `frames` (per-character preview stills). |

---

## Responses

**Ack (sync):**
```json
{ "job_id": "9c4e77a1-...", "status": "queued", "estimated_sec": 480 }
```

**Callback:**
```json
{
  "job_id": "9c4e77a1-...",
  "status": "succeeded",
  "video_url": "s3://xavier-videos/faceswap/9c4e77a1/final.mp4",
  "characters": [
    { "character_id": "scientist-1", "matched_track": 0, "frames_swapped": 412, "preview_url": "s3://.../scientist-1.jpg" },
    { "character_id": "scientist-2", "matched_track": 1, "frames_swapped": 388, "preview_url": "s3://.../scientist-2.jpg" }
  ],
  "warnings": [
    { "line_id": "L7", "code": "FACE_OCCLUDED", "detail": "Face partly out of frame for 0.4s — swap skipped on those frames" }
  ],
  "error": null,
  "finished_at": "2026-07-23T11:04:12Z"
}
```

**Failure:** `status: "failed"`, `error: { "code": "...", "message": "...", "retryable": true }`
Codes: `VIDEO_UNREADABLE` · `FACE_IMAGE_UNREADABLE` · `NO_FACE_IN_IMAGE` · `NO_FACE_IN_VIDEO` ·
`UNKNOWN_CHARACTER_REF` · `AMBIGUOUS_TARGET` (auto-matching couldn't decide — pin a `target_ref`)
**Flow:** `queued → running → succeeded | failed`

> **Why `characters[]` comes back in the callback:** `matched_track` tells you which on-screen face
> auto-matching chose. If a result looks wrong, that field is what you correct with an explicit
> `target_ref` on the retry.
