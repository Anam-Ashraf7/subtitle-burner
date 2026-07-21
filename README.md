# Video Studio

Netflix-style web app to produce videos from a library: pick a base video, layer on
intro/outro screens and subtitles (from `.xlsx` templates or your own upload), preview
live, and burn & export an MP4.

## Levels
- **Level 0** — Intro & Outro black screens only (no subtitles)
- **Level 1** — Subtitles burned in (+ intro/outro)
- **Level 2** — Audio + Subtitles (placeholder, coming soon)
- **Level 3** — Lip-sync & Face Swap (placeholder, coming soon)

## Content
- Base videos live in `videos/` (auto-listed; a few samples are generated on first run).
  Drop your own `.mp4/.webm/.mov` files in there.
- Subtitle templates live in `templates/subtitles/*.xlsx` (auto-listed). Users can also
  upload their own xlsx per session.

## Run

```bash
npm install
npm start
```

Open http://localhost:5178

## How it works

1. **Upload** a video + the subtitles `.xlsx`.
2. Rows are parsed:
   - `Person = "meta data"` (title/description) → **skipped**.
   - `timestamp_start = intro/outro` with `Person = "black screen"` → **black-screen cards** (duration auto-computed from text length at ~15 chars/sec, min 1.5s — editable).
   - Rows with real `HH:MM:SS` timestamps → **burned subtitles** using the `new_text_1` column, shown over the video at those timestamps.
3. **Preview** the video with subtitles as a live HTML overlay. Edit any cue's text (and black-screen durations) and see it update instantly. "Preview full" plays intro screens → video → outro screens.
4. **Burn & Export** produces one combined MP4: intro black screens + video with subtitles burned in (ffmpeg `subtitles` filter via a styled `.ass`) + outro black screens, concatenated.

ffmpeg/ffprobe are bundled via `ffmpeg-static` / `ffprobe-static` — no system install needed.

The source subtitle column is `new_text_1`; the original `text` column is shown as "old:" reference under each cue.

## Deploy free on Render

1. Push this folder to a **GitHub** repo.
2. On [render.com](https://render.com) → **New → Web Service** → connect the repo.
   (Or **New → Blueprint** to auto-read `render.yaml`.)
3. Settings: **Runtime** Node · **Build** `npm install` · **Start** `npm start` · **Plan** Free.
4. Create. First deploy takes a few minutes (it downloads the Linux ffmpeg binary during `npm install`).
5. Open the `https://<name>.onrender.com` URL — done.

No env vars needed: the app reads Render's `PORT` automatically.

### Free-tier notes
- The instance **sleeps after ~15 min idle**; the next visit cold-starts in ~1 min.
- Disk is **ephemeral** — uploaded/exported files are per-session and cleared on restart. That's fine here.
- Free RAM/CPU is small, so **keep videos short** (a few minutes). Long videos encode slowly and a very long export request may be cut off. For heavy use, upgrade the Render plan.
