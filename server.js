import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ffprobePath = ffprobeStatic.path;
const WORK = path.join(__dirname, 'work');
const VIDEOS_DIR = path.join(__dirname, 'videos');            // base video library
const TEMPLATES_DIR = path.join(__dirname, 'templates', 'subtitles'); // subtitle xlsx templates
for (const d of [WORK, VIDEOS_DIR, TEMPLATES_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(VIDEOS_DIR, { acceptRanges: true })); // range-enabled preview streaming

const upload = multer({ dest: WORK, limits: { fileSize: 1024 * 1024 * 1024 } });
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const metaCache = new Map(); // videoPath -> probe meta

function listVideos() {
  return fs.readdirSync(VIDEOS_DIR)
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ id: f, name: prettyName(f), url: `/videos/${encodeURIComponent(f)}` }));
}
function listTemplates() {
  return fs.readdirSync(TEMPLATES_DIR)
    .filter((f) => path.extname(f).toLowerCase() === '.xlsx')
    .sort()
    .map((f) => ({ id: f, name: prettyName(f) }));
}
function prettyName(f) {
  return path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Generate a few sample clips on first run so the library isn't empty.
async function seedSampleVideos() {
  if (listVideos().length) return;
  const samples = [
    { name: 'Sample - Bars.mp4', src: 'testsrc2=size=1280x720:rate=25' },
    { name: 'Sample - Gradient.mp4', src: 'gradients=size=1280x720:rate=25' },
    { name: 'Sample - Mandelbrot.mp4', src: 'mandelbrot=size=1280x720:rate=25' },
  ];
  for (const s of samples) {
    const out = path.join(VIDEOS_DIR, s.name);
    try {
      await run(ffmpegPath, [
        '-f', 'lavfi', '-i', `${s.src}`,
        '-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=44100',
        '-t', '8', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-shortest', '-y', out,
      ]);
    } catch (e) { console.error('seed failed', s.name, e.message); }
  }
}

// ---------- xlsx parsing ----------
const READ_SPEED = 15; // chars/sec for auto black-screen duration
const MIN_SCREEN = 1.5; // seconds

function timeCellToSeconds(v) {
  // xlsx time cells come through as a fraction of a day (number) with cellDates off,
  // or as a Date when cellDates on. We read raw values, so handle both.
  if (v instanceof Date) {
    return v.getUTCHours() * 3600 + v.getUTCMinutes() * 60 + v.getUTCSeconds() + v.getUTCMilliseconds() / 1000;
  }
  if (typeof v === 'number') return v * 86400; // fraction of day
  return null;
}

function autoDuration(text) {
  const n = (text || '').trim().length;
  return Math.max(MIN_SCREEN, +(n / READ_SPEED).toFixed(2));
}

function parseWorkbook(buf) {
  const wb = XLSX.read(buf); // raw: time cells come as fraction-of-day numbers (avoids TZ shift)
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const header = rows[0].map((h) => String(h || '').trim());
  const col = (name) => header.indexOf(name);
  const ci = {
    start: col('timestamp_start'),
    end: col('timestamp_end'),
    person: col('Person'),
    text: col('new_text_1'),
    old: col('text'),
  };

  const subs = [];
  const intro = [];
  const outro = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const person = String(row[ci.person] ?? '').trim();
    const startRaw = row[ci.start];
    const text = row[ci.text] == null ? '' : String(row[ci.text]).trim();
    const oldText = row[ci.old] == null ? '' : String(row[ci.old]).trim();
    const label = String(startRaw ?? '').trim().toLowerCase();

    // meta data rows (title/description) -> skipped entirely
    if (person.toLowerCase() === 'meta data') continue;

    const startSec = timeCellToSeconds(startRaw);
    if (startSec == null) {
      // non-time row -> intro/outro black screen
      if (label === 'intro') intro.push({ text, oldText, person });
      else if (label === 'outro') outro.push({ text, oldText, person });
      // any other non-time label is ignored
      continue;
    }
    const endSec = timeCellToSeconds(row[ci.end]);
    if (!text) continue;
    subs.push({ start: startSec, end: endSec ?? startSec + 2, text, oldText, person });
  }

  // assign auto durations + ids to screens
  const introScreens = intro.map((s, i) => ({ id: `intro-${i}`, ...s, duration: autoDuration(s.text) }));
  const outroScreens = outro.map((s, i) => ({ id: `outro-${i}`, ...s, duration: autoDuration(s.text) }));
  const subCues = subs.map((s, i) => ({ id: `sub-${i}`, ...s }));
  return { intro: introScreens, subs: subCues, outro: outroScreens };
}

async function probe(videoPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
      '-of', 'json', videoPath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const st = j.streams[0];
        const [num, den] = (st.r_frame_rate || '30/1').split('/').map(Number);
        resolve({
          width: st.width,
          height: st.height,
          fps: den ? num / den : 30,
          duration: parseFloat(j.format.duration) || 0,
        });
      } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

// ---------- library + template API ----------
function resolveVideo(id) {
  const safe = path.basename(id || ''); // prevent traversal
  const p = path.join(VIDEOS_DIR, safe);
  return fs.existsSync(p) && VIDEO_EXTS.has(path.extname(p).toLowerCase()) ? p : null;
}
function resolveTemplate(id) {
  const safe = path.basename(id || '');
  const p = path.join(TEMPLATES_DIR, safe);
  return fs.existsSync(p) && path.extname(p).toLowerCase() === '.xlsx' ? p : null;
}

app.get('/api/videos', (req, res) => res.json(listVideos()));
app.get('/api/subtitle-templates', (req, res) => res.json(listTemplates()));

// parsed cues for a named template
app.get('/api/subtitle-templates/:id', (req, res) => {
  const p = resolveTemplate(req.params.id);
  if (!p) return res.status(404).json({ error: 'template not found' });
  try {
    res.json(parseWorkbook(fs.readFileSync(p)));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// upload-your-own subtitle xlsx (no video) -> parsed cues
app.post('/api/subtitles', upload.single('xlsx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'xlsx file required' });
  try {
    const parsed = parseWorkbook(fs.readFileSync(req.file.path));
    fs.unlinkSync(req.file.path);
    res.json(parsed);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- ASS subtitle generation ----------
function assTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function assEscape(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')');
}
function buildAss(subs, w, h) {
  const fontSize = Math.round(h * 0.055);
  const margin = Math.round(h * 0.06);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Def,DejaVu Sans,${fontSize},&H00FFFFFF,&H00000000,&H80000000,-1,1,3,1,2,60,60,${margin}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = subs
    .filter((s) => s.text && s.text.trim())
    .map((s) => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Def,,0,0,0,,${assEscape(s.text)}`)
    .join('\n');
  return head + lines + '\n';
}

// run ffmpeg; onProgress(seconds) fires as it encodes (parsed from -progress output)
function run(bin, args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    if (onProgress) {
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m) onProgress(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
        }
      });
    }
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-2000)))));
    p.on('error', reject);
  });
}
const PROG = ['-progress', 'pipe:1', '-nostats']; // machine-readable progress on stdout

// Bundled font so libass renders text even on minimal Linux hosts (Render) with no system fonts.
const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
const FONTS_ARG = escFilterPath(FONTS_DIR);

// Centered black-screen text as an ASS subtitle (uses libass — works everywhere,
// unlike the drawtext filter which is missing from many static ffmpeg builds).
function buildScreenAss(text, w, h, dur) {
  const fontSize = Math.round(h * 0.06);
  // wrap ~28 chars per line
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > 28) { lines.push(cur.trim()); cur = word; }
    else cur += ' ' + word;
  }
  if (cur.trim()) lines.push(cur.trim());
  const body = lines.join('\n'); // assEscape turns \n into \N
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Scr,DejaVu Sans,${fontSize},&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,40,40,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${assTime(0)},${assTime(dur)},Scr,,0,0,0,,${assEscape(body)}
`;
  return head;
}

const jobs = new Map(); // jobId -> { percent, stage, done, error, file, dir }

// Kick off an export job; returns immediately with a jobId. Progress via SSE.
app.post('/export', async (req, res) => {
  const { videoId, level = 1 } = req.body || {};
  if (+level >= 2) return res.status(400).json({ error: `Level ${level} (audio / lip-sync / face-swap) is not available yet.` });
  const videoPath = resolveVideo(videoId);
  if (!videoPath) return res.status(404).json({ error: 'video not found in library' });
  let meta = metaCache.get(videoPath);
  if (!meta) {
    try { meta = await probe(videoPath); metaCache.set(videoPath, meta); }
    catch (e) { return res.status(500).json({ error: 'could not read video: ' + e.message }); }
  }
  const jobId = randomUUID();
  jobs.set(jobId, { percent: 0, stage: 'Starting…', done: false, error: null, file: null, dir: null });
  res.json({ jobId });
  // Level 0 => no subtitles burned; Level 1 => burn subtitles.
  const body = { ...req.body, subs: +level >= 1 ? req.body.subs || [] : [] };
  runExportJob(jobId, { videoPath, meta }, body).catch((e) => {
    const job = jobs.get(jobId);
    if (job) { job.error = String(e.message || e); }
    console.error(e);
  });
});

// Defaults (env-overridable). Per-export the UI can override preset/crf/maxHeight.
const DEFAULT_MAX_HEIGHT = parseInt(process.env.MAX_HEIGHT || '1080', 10);
const DEFAULT_PRESET = process.env.X264_PRESET || 'ultrafast'; // fastest CPU encode
const DEFAULT_CRF = parseInt(process.env.X264_CRF || '23', 10); // lower = better quality/bigger
// Threads 0 = all cores. Set FFMPEG_THREADS=1 on a tiny 512MB host to cap RAM.
const THREADS = ['-threads', process.env.FFMPEG_THREADS || '0'];

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
const HEIGHTS = [480, 720, 1080, 1440, 2160];
const even = (n) => (n % 2 ? n - 1 : n); // x264 requires even dimensions
function outputDims(w, h, maxHeight) {
  if (h <= maxHeight) return { W: even(w), H: even(h) };
  const scale = maxHeight / h;
  return { W: even(Math.round(w * scale)), H: maxHeight };
}

async function runExportJob(jobId, s, { intro = [], subs = [], outro = [], preset, crf, maxHeight }) {
  const job = jobs.get(jobId);
  const { fps, duration: videoDur } = s.meta;
  // per-export quality controls, validated against allowlists
  const usePreset = PRESETS.includes(preset) ? preset : DEFAULT_PRESET;
  const useCrf = Number.isFinite(+crf) ? Math.min(35, Math.max(14, Math.round(+crf))) : DEFAULT_CRF;
  const useMaxH = HEIGHTS.includes(+maxHeight) ? +maxHeight : DEFAULT_MAX_HEIGHT;
  const enc = ['-c:v', 'libx264', '-preset', usePreset, '-crf', String(useCrf)];
  const { W: w, H: h } = outputDims(s.meta.width, s.meta.height, useMaxH); // OUTPUT dims
  const dir = fs.mkdtempSync(path.join(WORK, 'exp-'));
  job.dir = dir;
  const durOf = (sc) => Math.max(0.3, Number(sc.duration) || autoDuration(sc.text));
  const totalDur = intro.reduce((a, sc) => a + durOf(sc), 0) + (videoDur || 0) + outro.reduce((a, sc) => a + durOf(sc), 0) || 1;
  let processed = 0; // seconds fully finished
  const setPct = (now) => { job.percent = Math.min(99, Math.round(((processed + now) / totalDur) * 100)); };

  const blackClip = async (sc, label) => {
    const out = path.join(dir, `${sc.id}.mp4`);
    const dur = durOf(sc);
    job.stage = label;
    const scrAss = path.join(dir, `${sc.id}.ass`);
    fs.writeFileSync(scrAss, buildScreenAss(sc.text, w, h, dur));
    const scrArg = scrAss.replace(/\\/g, '/').replace(/:/g, '\\:');
    await run(ffmpegPath, [
      ...PROG,
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${fps}:d=${dur}`,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-vf', `subtitles='${scrArg}':fontsdir='${FONTS_ARG}'`,
      ...THREADS,
      '-t', String(dur), '-pix_fmt', 'yuv420p', ...enc,
      '-c:a', 'aac', '-ar', '44100', '-r', String(fps), '-y', out,
    ], (t) => setPct(Math.min(t, dur)));
    processed += dur;
    setPct(0);
    return out;
  };

  const parts = [];
  for (let i = 0; i < intro.length; i++) parts.push(await blackClip(intro[i], `Rendering intro ${i + 1}/${intro.length}…`));

  // main video with burned subs
  job.stage = 'Burning subtitles into video…';
  const assPath = path.join(dir, 'subs.ass');
  fs.writeFileSync(assPath, buildAss(subs, w, h));
  const mainOut = path.join(dir, 'main.mp4');
  const assArg = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  // Only rescale when the source is actually bigger than target — skips a full
  // per-frame scale pass (and its CPU cost) for videos already at/under MAX_HEIGHT.
  const needScale = s.meta.height !== h || s.meta.width !== w;
  const scalePre = needScale ? `scale=${w}:${h}:flags=bicubic,setsar=1,` : '';
  await run(ffmpegPath, [
    ...PROG, '-i', s.videoPath,
    '-vf', `${scalePre}subtitles='${assArg}':fontsdir='${FONTS_ARG}'`,
    ...THREADS,
    '-pix_fmt', 'yuv420p', ...enc,
    '-c:a', 'aac', '-ar', '44100', '-r', String(fps), '-y', mainOut,
  ], (t) => setPct(Math.min(t, videoDur || t)));
  processed += videoDur || 0;
  setPct(0);
  parts.push(mainOut);

  for (let i = 0; i < outro.length; i++) parts.push(await blackClip(outro[i], `Rendering outro ${i + 1}/${outro.length}…`));

  // concat
  job.stage = 'Stitching final video…';
  const finalOut = path.join(dir, 'final.mp4');
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], finalOut);
  } else {
    const listPath = path.join(dir, 'list.txt');
    fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    await run(ffmpegPath, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', finalOut]);
  }
  job.file = finalOut;
  job.percent = 100;
  job.stage = 'Done';
  job.done = true;
}

// SSE progress stream
app.get('/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = () => res.write(`data: ${JSON.stringify({ percent: job.percent, stage: job.stage, done: job.done, error: job.error })}\n\n`);
  send();
  const iv = setInterval(() => {
    send();
    if (job.done || job.error) { clearInterval(iv); res.end(); }
  }, 400);
  req.on('close', () => clearInterval(iv));
});

// download finished file
app.get('/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.file) return res.status(404).end();
  res.download(job.file, 'subtitled.mp4', () => {
    setTimeout(() => {
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      jobs.delete(req.params.jobId);
    }, 60000);
  });
});

const PORT = process.env.PORT || 5178;
app.listen(PORT, async () => {
  console.log(`Subtitle burner running on port ${PORT}`);
  await seedSampleVideos();
  console.log(`Library: ${listVideos().length} videos, ${listTemplates().length} subtitle templates`);
});
