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
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load a local .env (KEY=VALUE per line) into process.env — no dependency. Existing
// env vars win, so `aws configure` / real env vars still take precedence.
(function loadDotenv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* ignore */ }
})();

const ffprobePath = ffprobeStatic.path;
const WORK = path.join(__dirname, 'work');
const TEMPLATES_DIR = path.join(__dirname, 'templates', 'subtitles'); // subtitle xlsx templates
const THUMBS_DIR = path.join(__dirname, 'thumbs');            // generated poster frames
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');  // cached speech-to-text per video
const PREVIEWS_DIR = path.join(__dirname, 'previews');        // audio-stripped copies for browsers that reject bad audio
const FACES_DIR = path.join(__dirname, 'faces');              // uploaded character faces, served publicly for the L3 API
for (const d of [WORK, TEMPLATES_DIR, THUMBS_DIR, TRANSCRIPTS_DIR, PREVIEWS_DIR, FACES_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json({ limit: '30mb' })); // face images arrive as base64 data URLs
app.use(express.static(path.join(__dirname, 'public')));
app.use('/fonts', express.static(path.join(__dirname, 'assets', 'fonts'))); // @font-face for WYSIWYG preview
app.use('/thumbs', express.static(THUMBS_DIR)); // static poster frames for template cards
app.use('/previews', express.static(PREVIEWS_DIR, { acceptRanges: true })); // audio-stripped preview clips
app.use('/faces', express.static(FACES_DIR)); // character faces (public URL for the Level 3 API)

const upload = multer({ dest: WORK, limits: { fileSize: 1024 * 1024 * 1024 } });
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const metaCache = new Map(); // video url -> probe meta

// ---------- source videos live in S3 (public-read bucket) ----------
const S3_BUCKET = process.env.S3_BUCKET || 'xavier-videos';
const S3_REGION = process.env.S3_REGION || 'eu-north-1';
const s3PublicUrl = (key) => `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
const s3Uri = (key) => `s3://${S3_BUCKET}/${key}`;
// Bucket ListBucket isn't public, so the available objects are catalogued in
// s3-videos.json (falls back to this list). Add a filename there to expose a new video.
const DEFAULT_S3_VIDEOS = ['crouching_tiger_9x16.mp4', 'korean_court_9x16.mp4', 'lab_mask_convo_9x16.mp4', 'mamdani_property_9x16.mp4', 'mamdani_property_alternative_9x16.mp4'];
function s3VideoKeys() {
  const f = path.join(__dirname, 's3-videos.json');
  if (fs.existsSync(f)) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j) && j.length) return j; } catch { /* fall through */ } }
  return DEFAULT_S3_VIDEOS;
}
function listVideos() {
  return s3VideoKeys().map((key) => ({ id: key, name: prettyName(key), url: s3PublicUrl(key), s3Uri: s3Uri(key) }));
}

// Some videos are their own template (no xlsx) — their subtitles come from
// transcribing the audio. Catalogued in video-templates.json.
function videoTemplates() {
  const f = path.join(__dirname, 'video-templates.json');
  let list = [];
  if (fs.existsSync(f)) { try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ } }
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && t.video && resolveVideo(t.video))
    .map((t) => ({ id: slug(t.name || t.video), name: t.name || prettyName(t.video), type: String(t.type || '3'), video: t.video, transcribe: t.transcribe !== false, preview: !!t.preview }));
}
const TYPE_LABEL = { '0': 'Intro & Outro', '1': 'Subtitles', '2': 'Voiceover', '3': 'Manipulate heads' };
function titleCase(s) { return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

// --- match each template to its source video by name ---
const nameTokens = (s) => String(s).toLowerCase().replace(/\.(mp4|webm|mov|m4v)$/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t && !/^\d+x\d+$/.test(t));
function matchTemplateVideos() {
  const vids = listVideos(), tpls = [...templates().values()];
  const pairs = [];
  for (const t of tpls) for (const v of vids) {
    const a = nameTokens(t.name), b = nameTokens(v.name);
    const inter = a.filter((x) => b.includes(x)).length;
    if (inter) pairs.push({ t: t.id, v: v.id, s: inter / new Set([...a, ...b]).size });
  }
  pairs.sort((x, y) => y.s - x.s); // greedy: best matches claim their video first
  const out = new Map(); const used = new Set();
  for (const p of pairs) { if (out.has(p.t) || used.has(p.v)) continue; out.set(p.t, p.v); used.add(p.v); }
  return out;
}
const thumbName = (videoId) => path.basename(videoId, path.extname(videoId)) + '.jpg';

function templateCard(t, match) {
  const vid = match.get(t.id) || null;
  return {
    id: t.id, name: titleCase(t.name), type: t.type, typeLabel: TYPE_LABEL[t.type] || '',
    subs: t.subs.length, placeholders: t.placeholders,
    videoId: vid, videoUrl: vid ? s3PublicUrl(vid) : null, videoS3: vid ? s3Uri(vid) : null,
    thumbUrl: vid ? `/thumbs/${encodeURIComponent(thumbName(vid))}` : null,
  };
}
function videoTemplateCard(t) {
  return {
    id: t.id, name: titleCase(t.name), type: t.type, typeLabel: TYPE_LABEL[t.type] || '',
    subs: 0, placeholders: [], transcribe: t.transcribe,
    videoId: t.video, videoUrl: s3PublicUrl(t.video), videoS3: s3Uri(t.video),
    thumbUrl: `/thumbs/${encodeURIComponent(thumbName(t.video))}`,
  };
}
function listTemplates() {
  const match = matchTemplateVideos();
  return [...[...templates().values()].map((t) => templateCard(t, match)), ...videoTemplates().map(videoTemplateCard)];
}

// ---------- browser preview clips (audio stripped) ----------
// Some source videos have a malformed audio track that makes browsers refuse to load
// the whole media element even though the video stream is fine. We serve an
// audio-stripped copy (video stream copied, no re-encode) for reliable in-browser preview.
const previewName = (key) => path.basename(key, path.extname(key)) + '.mp4';
const previewUrlFor = (key) => `/previews/${encodeURIComponent(previewName(key))}`;
// Duration of the video stream specifically (the container duration can be a lie
// when a malformed audio track is far longer than the actual video).
function videoStreamDuration(url) {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', url]);
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(parseFloat(out) || null));
    p.on('error', () => resolve(null));
  });
}
// Build a browser-friendly preview: a faststart remux trimmed to the video's real
// length. Trimming drops a corrupt over-long audio tail (a broken upload can have
// audio far longer than the video) that would otherwise block in-browser load.
// Stream-copy is fast; if the audio can't be copied cleanly, re-encode as a fallback.
let previewInFlight = new Set();
async function ensurePreview(key) {
  const out = path.join(PREVIEWS_DIR, previewName(key));
  if (fs.existsSync(out)) return out;
  const src = resolveVideo(key);
  if (!src) throw new Error('video not found in library');
  const vdur = await videoStreamDuration(src.url);
  const trim = vdur ? ['-t', String(vdur + 0.1)] : [];
  const base = ['-y', '-err_detect', 'ignore_err', '-max_error_rate', '1.0', '-i', src.url, '-map', '0:v:0', '-map', '0:a:0?'];
  const finish = ['-movflags', '+faststart', out];
  try {
    await run(ffmpegPath, [...base, '-c', 'copy', ...trim, ...finish]); // fast: stream copy
  } catch (e1) {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    try {
      await run(ffmpegPath, [...base, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', ...trim, ...finish]); // fallback: re-encode audio
    } catch (e2) {
      if (!(fs.existsSync(out) && fs.statSync(out).size > 100000)) throw e2;
    }
  }
  return out;
}
// Non-blocking warm: kick off preview generation without awaiting (dedup in-flight).
function warmPreview(key) {
  if (fs.existsSync(path.join(PREVIEWS_DIR, previewName(key))) || previewInFlight.has(key)) return;
  previewInFlight.add(key);
  ensurePreview(key).catch((e) => console.warn('preview failed', key, e.message)).finally(() => previewInFlight.delete(key));
}

// ---------- transcription (speech-to-text for video-native templates) ----------
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium';
const transcriptCacheFile = (key) => path.join(TRANSCRIPTS_DIR, path.basename(key, path.extname(key)) + '.json');

function runPython(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('transcription failed: ' + (err.slice(-400) || 'exit ' + code)))));
    p.on('error', (e) => reject(new Error(`python not available (${PYTHON_BIN}) — set PYTHON_BIN: ${e.message}`)));
  });
}

// Transcribe a catalogued video into subtitle cues, cached on disk. The cache is
// authoritative when present, so a committed transcript works without Python.
async function transcribeVideo(key) {
  const cache = transcriptCacheFile(key);
  if (fs.existsSync(cache)) { try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* re-run */ } }
  const src = resolveVideo(key);
  if (!src) throw new Error('video not found in library');
  const tmp = fs.mkdtempSync(path.join(WORK, 'tx-'));
  const media = path.join(tmp, 'in.mp4');
  try {
    // download once — streaming a URL into the decoder re-seeks over HTTP and is slow
    fs.writeFileSync(media, Buffer.from(await (await fetch(src.url)).arrayBuffer()));
    const j = JSON.parse(await runPython([path.join(__dirname, 'scripts', 'transcribe.py'), media, WHISPER_MODEL]));
    const subs = (j.segments || []).map((s, i) => ({ id: `sub-${i}`, start: +s.start, end: +s.end, text: s.text, person: s.speaker || 'Speaker 1' }));
    const result = { subs, language: j.language, duration: j.duration, coverage: { decoded_frames: j.decoded_frames, undecodable_frames: j.undecodable_frames } };
    fs.writeFileSync(cache, JSON.stringify(result, null, 2));
    return result;
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// Generate a static poster frame per video (used as the card thumbnail).
// Reads directly from the S3 public URL; -ss before -i seeks via range requests
// so ffmpeg only downloads a small slice rather than the whole file.
const thumbInFlight = new Map();
// Generate one poster frame: cached on disk, deduped per file, and time-bounded so a
// slow/awkward source on a small host can't hang the request or block other thumbs.
function ensureThumb(v) {
  const file = path.join(THUMBS_DIR, thumbName(v.id));
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (!thumbInFlight.has(file)) {
    const pr = run(ffmpegPath, ['-ss', '1', '-i', v.url, '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '3', '-y', file], null, 25000)
      .then(() => file)
      .catch((e) => { console.error('thumb failed', v.id, e.message); try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ } throw e; })
      .finally(() => thumbInFlight.delete(file));
    thumbInFlight.set(file, pr);
  }
  return thumbInFlight.get(file);
}
// Warm all thumbs in parallel at boot; failures are non-fatal — the /thumbs route
// regenerates any that are missing on demand.
function generateThumbs() {
  return Promise.allSettled(listVideos().map((v) => ensureThumb(v)));
}
function prettyName(f) {
  return path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- xlsx parsing ----------
const READ_SPEED = 15; // chars/sec for auto black-screen duration
const MIN_SCREEN = 1.5; // seconds

// Accepts Excel time numbers (fraction of a day), Date objects, and text forms
// like ":44", "1:23", "00:00:01.2". Returns null for non-time labels (title/intro/…).
function timeCellToSeconds(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getUTCHours() * 3600 + v.getUTCMinutes() * 60 + v.getUTCSeconds() + v.getUTCMilliseconds() / 1000;
  if (typeof v === 'number') return v * 86400;
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s); // H:M:S
  if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
  m = /^(\d*):(\d{1,2}(?:\.\d+)?)$/.exec(s); // M:S or :S
  if (m) return (m[1] ? +m[1] : 0) * 60 + parseFloat(m[2]);
  return null;
}

function autoDuration(text) {
  const n = (text || '').trim().length;
  return Math.max(MIN_SCREEN, +(n / READ_SPEED).toFixed(2));
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Speaker labels in sheets carry stage notes like "Scientist 1 (Insert voiceover)" —
// strip the parenthetical so they collapse to one character.
const cleanSpeaker = (name) => String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
// A "group" speaker ("Both, in unison") is voiced by its members, not its own prompt.
const GROUP_RE = /\b(unison|everyone|all|both|together|group|crowd)\b/i;
const isGroupSpeaker = (name) => GROUP_RE.test(String(name || ''));
// Dynamic fields look like [FullNameX] (some sheets have a stray "(" typo).
const PLACEHOLDER_RE = /[[(]\s*([A-Za-z][A-Za-z0-9]*)\s*\]/g;
function collectPlaceholders(text, set) {
  let m; PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text || ''))) set.add(m[1]);
}

// Turn a template group's rows into intro / subs / outro cues + placeholder list.
function rowsToCues(rows, ci) {
  const intro = [], outro = [], subs = [];
  const ph = new Set();
  for (const row of rows) {
    const person = cleanSpeaker(row[ci.person]);
    const text = row[ci.text] == null ? '' : String(row[ci.text]).trim();
    if (person.toLowerCase() === 'meta data') continue; // title/description not rendered
    collectPlaceholders(text, ph);
    const label = String(row[ci.start] ?? '').trim().toLowerCase();
    const startSec = timeCellToSeconds(row[ci.start]);
    if (startSec == null) {
      if (label === 'intro') intro.push({ text, person });
      else if (label === 'outro') outro.push({ text, person });
      continue;
    }
    if (!text) continue;
    const endSec = timeCellToSeconds(row[ci.end]);
    subs.push({ start: startSec, end: endSec != null ? endSec : startSec + 2, text, person });
  }
  return {
    intro: intro.map((s, i) => ({ id: `intro-${i}`, ...s, duration: autoDuration(s.text) })),
    outro: outro.map((s, i) => ({ id: `outro-${i}`, ...s, duration: autoDuration(s.text) })),
    subs: subs.map((s, i) => ({ id: `sub-${i}`, ...s })),
    placeholders: [...ph],
  };
}

// A sheet may hold multiple templates (grouped by template_name). Returns an array.
function parseTemplates(buf) {
  const wb = XLSX.read(buf);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const header = (rows[0] || []).map((h) => String(h || '').trim());
  const col = (name) => header.indexOf(name);
  const ci = { type: col('Template type'), name: col('template_name'), start: col('timestamp_start'), end: col('timestamp_end'), person: col('Person'), text: col('text') };
  const groups = new Map();
  let curName = null;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null)) continue;
    const name = ci.name >= 0 && row[ci.name] != null ? String(row[ci.name]).trim() : '';
    if (name) curName = name;
    if (!curName) continue;
    if (!groups.has(curName)) groups.set(curName, { name: curName, type: '', rows: [] });
    const g = groups.get(curName);
    if (g.type === '' && ci.type >= 0 && row[ci.type] != null) g.type = String(row[ci.type]).trim();
    g.rows.push(row);
  }
  return [...groups.values()].map((g) => {
    const cues = rowsToCues(g.rows, ci);
    return { id: slug(g.name), name: g.name, type: g.type, ...cues };
  });
}

// Back-compat: a single parsed set (first template) for uploaded files.
function parseWorkbook(buf) {
  const t = parseTemplates(buf);
  return t[0] || { intro: [], subs: [], outro: [], placeholders: [] };
}

// Parse every template file once and cache by id.
let TEMPLATE_CACHE = null;
function loadTemplates() {
  const map = new Map();
  for (const f of fs.readdirSync(TEMPLATES_DIR).filter((f) => path.extname(f).toLowerCase() === '.xlsx').sort()) {
    try {
      for (const t of parseTemplates(fs.readFileSync(path.join(TEMPLATES_DIR, f)))) {
        if (t.id) map.set(t.id, t);
      }
    } catch (e) { console.error('template parse failed', f, e.message); }
  }
  TEMPLATE_CACHE = map;
  return map;
}
const templates = () => TEMPLATE_CACHE || loadTemplates();

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
// Resolve an incoming videoId to a catalogued S3 object → { key, url, s3Uri }.
function resolveVideo(id) {
  const want = String(id || '').replace(/^\/+/, '');
  const keys = s3VideoKeys();
  const key = keys.includes(want) ? want : keys.find((k) => path.basename(k) === path.basename(want));
  if (!key) return null;
  return { key, url: s3PublicUrl(key), s3Uri: s3Uri(key) };
}
function resolveTemplate(id) {
  const safe = path.basename(id || '');
  const p = path.join(TEMPLATES_DIR, safe);
  return fs.existsSync(p) && path.extname(p).toLowerCase() === '.xlsx' ? p : null;
}

// Poster frames: the static middleware serves existing files; anything missing (boot
// warm-up not finished or failed) is generated on demand here so cards still get a thumb.
app.get('/thumbs/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(THUMBS_DIR, name);
  if (fs.existsSync(file)) return res.sendFile(file);
  const v = listVideos().find((x) => thumbName(x.id) === name);
  if (!v) return res.status(404).end();
  try { await ensureThumb(v); res.sendFile(file); }
  catch { res.status(404).end(); }
});

// TEMP diagnostic: isolate why ffmpeg can/can't produce thumbnails in prod.
function spawnDiag(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(bin, args);
    let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, errTail: err.slice(-350) }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ spawnError: e.message }); });
  });
}
app.get('/api/_diag', async (req, res) => {
  const out = { ffmpegPath };
  // A: ffmpeg encoding a local test pattern — no network at all.
  const lf = path.join(WORK, 'testsrc.jpg');
  out.localEncode = await spawnDiag(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=1', '-frames:v', '1', '-y', lf], 15000);
  out.localFileBytes = fs.existsSync(lf) ? fs.statSync(lf).size : 0;
  // B: can NODE reach the S3 object?
  const url = (listVideos()[0] || {}).url; out.url = url;
  try { const r = await fetch(url, { headers: { Range: 'bytes=0-2000' } }); const b = await r.arrayBuffer(); out.nodeFetch = { status: r.status, bytes: b.byteLength }; }
  catch (e) { out.nodeFetchErr = String(e.message); }
  // C: ffmpeg reading the S3 URL — capture exit code + signal.
  const sf = path.join(WORK, 'diag_s3.jpg');
  out.s3Thumb = await spawnDiag(ffmpegPath, ['-ss', '1', '-i', url, '-frames:v', '1', '-vf', 'scale=-2:120', '-q:v', '5', '-y', sf], 25000);
  out.s3ThumbBytes = fs.existsSync(sf) ? fs.statSync(sf).size : 0;
  res.json(out);
});

app.get('/api/videos', (req, res) => res.json(listVideos()));
app.get('/api/subtitle-templates', (req, res) => res.json(listTemplates()));

// parsed cues (+ placeholders) for a named template
app.get('/api/subtitle-templates/:id', async (req, res) => {
  const id = req.params.id;
  const wantType = req.query.type != null ? String(req.query.type) : null;
  const xlsx = templates().get(id);
  const vt0 = videoTemplates().find((x) => x.id === id);
  // A saved subtitle template and a video-native template can share an id (same name).
  // The card sends its type so we resolve to the right one; without a hint we keep the
  // old precedence (xlsx first).
  let useXlsx = xlsx, vt = xlsx ? null : vt0;
  if (wantType != null) {
    if (xlsx && String(xlsx.type) === wantType) { useXlsx = xlsx; vt = null; }
    else if (vt0 && String(vt0.type) === wantType) { useXlsx = null; vt = vt0; }
    else { useXlsx = xlsx; vt = xlsx ? null : vt0; } // no exact match → best effort
  }
  if (useXlsx) {
    const t = useXlsx;
    const card = templateCard(t, matchTemplateVideos());
    return res.json({ intro: t.intro, subs: t.subs, outro: t.outro, placeholders: t.placeholders, type: t.type, name: card.name, videoId: card.videoId, videoUrl: card.videoUrl, videoS3: card.videoS3, thumbUrl: card.thumbUrl });
  }
  // video-native template → subtitles transcribed from the audio (cached)
  if (!vt) return res.status(404).json({ error: 'template not found' });
  try {
    const tr = vt.transcribe ? await transcribeVideo(vt.video) : { subs: [] };
    const card = videoTemplateCard(vt);
    // A well-formed file plays straight from S3. Only videos flagged `preview:true`
    // (e.g. a broken audio track) get an audio-stripped/faststart preview instead.
    let previewUrl = null;
    if (vt.preview) {
      const ready = fs.existsSync(path.join(PREVIEWS_DIR, previewName(vt.video)));
      if (ready) previewUrl = previewUrlFor(vt.video); else warmPreview(vt.video);
    }
    res.json({ intro: [], subs: tr.subs || [], outro: [], placeholders: [], type: vt.type, name: card.name, videoId: card.videoId, videoUrl: card.videoUrl, videoS3: card.videoS3, previewUrl, thumbUrl: card.thumbUrl, transcribed: true, coverage: tr.coverage });
  } catch (e) { res.status(500).json({ error: 'transcription failed: ' + String(e.message || e) }); }
});

// upload-your-own subtitle xlsx (no video) -> parsed cues
app.post('/api/subtitles', upload.single('xlsx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'xlsx file required' });
  try {
    const parsed = parseWorkbook(fs.readFileSync(req.file.path));
    fs.unlinkSync(req.file.path);
    // best-effort: attach a library video whose name matches the sheet's template_name
    const vids = listVideos();
    const a = nameTokens(parsed.name || '');
    let best = null, bestScore = 0;
    for (const v of vids) {
      const b = nameTokens(v.name);
      const inter = a.filter((x) => b.includes(x)).length;
      const s = inter ? inter / new Set([...a, ...b]).size : 0;
      if (s > bestScore) { bestScore = s; best = v; }
    }
    if (best) { parsed.videoId = best.id; parsed.videoUrl = best.url; parsed.videoS3 = best.s3Uri; }
    res.json(parsed);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Opt-in: save an uploaded subtitle xlsx into the library so it shows up as a card and
// persists. We write it into the local templates dir (the library's source) AND upload
// a cloud copy to S3, so it survives restarts/redeploys (synced back on boot). Only
// called when the user explicitly clicks "Save to library" — never on a normal upload.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
app.post('/api/templates/save', upload.single('xlsx'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'xlsx file required' });
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } };
  try {
    const buf = fs.readFileSync(req.file.path);
    cleanup();
    // Parse first so we can report what landed in the library (and reject junk files).
    let parsed;
    try { parsed = parseTemplates(buf); } catch { parsed = []; }
    if (!parsed.length) return res.status(400).json({ error: 'No templates found in that sheet.' });
    const base = slug(String(req.body?.name || path.basename(req.file.originalname || 'template', '.xlsx'))) || 'template';
    const fileName = `${base}-${Date.now()}-${randomUUID().slice(0, 8)}.xlsx`;
    // 1) local library copy — the library reads templates/subtitles/*.xlsx
    fs.writeFileSync(path.join(TEMPLATES_DIR, fileName), buf);
    TEMPLATE_CACHE = null; // force reload so the new card appears immediately
    // 2) cloud copy (best-effort) so it isn't lost when local disk is ephemeral
    let url = null;
    if (s3Enabled) { try { url = await uploadToS3(`templates/${fileName}`, buf, XLSX_MIME); } catch (e) { console.warn('[templates] S3 copy failed:', e.message); } }
    console.log(`[templates] saved ${fileName} to library (${parsed.map((t) => t.id).join(', ')})${url ? ' + S3' : ''}`);
    res.json({ ids: parsed.map((t) => t.id), names: parsed.map((t) => t.name), file: fileName, url, bucket: s3Enabled ? S3_UPLOAD_BUCKET : null });
  } catch (e) { cleanup(); res.status(500).json({ error: String(e.message || e) }); }
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

// Subtitle fonts bundled in assets/fonts. `bold` = whether we render the bold weight.
const SUB_FONTS = {
  dejavu: { name: 'DejaVu Sans', bold: true },
  poppins: { name: 'Poppins', bold: true },
  ptserif: { name: 'PT Serif', bold: true },
  anton: { name: 'Anton', bold: false },
  bebas: { name: 'Bebas Neue', bold: false },
  pacifico: { name: 'Pacifico', bold: false },
};
const SIZE_FACTOR = { small: 0.045, medium: 0.055, large: 0.07 }; // legacy keyword fallback
// ASS colour is &HAABBGGRR — alpha 00 = opaque, FF = transparent.
const assColor = (hex, alpha = '00') => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffffff'));
  const v = m ? m[1] : 'ffffff';
  return `&H${alpha}${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`.toUpperCase();
};
const hexToAss = (hex) => assColor(hex, '00');
function resolveStyle(style = {}) {
  const f = SUB_FONTS[style.font] || SUB_FONTS.dejavu;
  // sizePct is the slider value (e.g. 5.5 = 5.5% of the shorter side); fall back to the old keyword.
  const factor = Number.isFinite(+style.sizePct) ? +style.sizePct / 100 : (SIZE_FACTOR[style.size] || SIZE_FACTOR.medium);
  return { font: f.name, bold: f.bold ? -1 : 0, factor, color: hexToAss(style.color), bg: style.bg || 'box' };
}

function buildAss(subs, w, h, style = {}) {
  const s = resolveStyle(style);
  // Size off the SHORTER side so portrait (9:16) captions aren't oversized — matches the
  // preview's cqmin. Landscape is unchanged since min(w,h) === h there.
  const fontSize = Math.round(Math.min(w, h) * s.factor);
  const margin = Math.round(h * 0.06);
  const ref = Math.min(w, h); // outline/box padding scales with the font, not the tall side
  const bgHex = /^#?([0-9a-f]{6})$/i.test(String(style.bgColor || '')) ? style.bgColor : '#000000';
  // BorderStyle 3 = box (filled with OutlineColour); 1 = text outline + shadow (no box).
  let borderStyle, outline, shadow, back, outlineCol;
  if (s.bg === 'none') { borderStyle = 1; outline = Math.max(2, Math.round(ref * 0.004)); shadow = Math.max(1, Math.round(ref * 0.002)); back = '&H00000000'; outlineCol = '&H00000000'; }
  else { borderStyle = 3; outline = Math.max(6, Math.round(ref * 0.008)); shadow = 0; back = '&H00000000'; outlineCol = assColor(bgHex, s.bg === 'solid' ? '00' : '80'); }
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Def,${s.font},${fontSize},${s.color},${outlineCol},${back},${s.bold},${borderStyle},${outline},${shadow},2,60,60,${margin}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = subs
    .filter((x) => x.text && x.text.trim())
    .map((x) => `Dialogue: 0,${assTime(x.start)},${assTime(x.end)},Def,,0,0,0,,${assEscape(x.text)}`)
    .join('\n');
  return head + lines + '\n';
}

// run ffmpeg; onProgress(seconds) fires as it encodes (parsed from -progress output)
function run(bin, args, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '', settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(arg); };
    const timer = timeoutMs ? setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } done(reject, new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs) : null;
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
    p.on('close', (code) => (code === 0 ? done(resolve) : done(reject, new Error(err.slice(-2000)))));
    p.on('error', (e) => done(reject, e));
  });
}
const PROG = ['-progress', 'pipe:1', '-nostats']; // machine-readable progress on stdout

// Bundled font so libass renders text even on minimal Linux hosts (Render) with no system fonts.
const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
const FONTS_ARG = escFilterPath(FONTS_DIR);

// Centered black-screen text as an ASS subtitle (uses libass — works everywhere,
// unlike the drawtext filter which is missing from many static ffmpeg builds).
function buildScreenAss(text, w, h, dur, fontName = 'DejaVu Sans') {
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
Style: Scr,${fontName},${fontSize},&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,40,40,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${assTime(0)},${assTime(dur)},Scr,,0,0,0,,${assEscape(body)}
`;
  return head;
}

// ---------- Level 2: voiceover (audio replacement) API ----------
const VOICEOVER_API_URL = process.env.VOICEOVER_API_URL || 'https://66e12pdg03.execute-api.eu-west-1.amazonaws.com/Prod/generate';

// Build the standalone voiceover payload from the studio's subs + per-character prompts,
// call the service, and return its JSON (presigned_url points at a timeline-placed mp3).
async function requestVoiceover({ s3Uri, language = 'en-US', subs, voices = {} }) {
  const names = new Map(); // character id (slug) -> display name, in first-seen order
  for (const c of subs) { const nm = cleanSpeaker(c.person); const id = slug(nm); if (id && !names.has(id)) names.set(id, nm); }
  const soloIds = [...names].filter(([, nm]) => !isGroupSpeaker(nm)).map(([id]) => id);
  const characters = [...names].map(([id, name]) => (
    isGroupSpeaker(name)
      ? { id, name, members: soloIds.filter((m) => m !== id) } // voiced by the individual voices together
      : { id, name, voice_prompt: (voices[id] || '').trim() }
  ));
  const subtitles = subs
    .filter((c) => c.text && c.text.trim() && slug(cleanSpeaker(c.person)))
    .map((c) => ({ id: c.id, character_id: slug(cleanSpeaker(c.person)), start_sec: +c.start, end_sec: +c.end, text: c.text }));
  if (!subtitles.length) throw new Error('voiceover needs at least one line with a speaker');
  const payload = { video_url: s3Uri, language, characters, subtitles };
  console.log('→ voiceover API request:\n' + JSON.stringify(payload, null, 2));
  const r = await fetch(VOICEOVER_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`voiceover API ${r.status}: ${txt.slice(0, 300)}`);
  let j; try { j = JSON.parse(txt); } catch { throw new Error('voiceover API returned non-JSON'); }
  if (!j.presigned_url) throw new Error('voiceover API returned no audio url');
  console.log(`← voiceover API ok: ${j.duration_seconds}s, cast=${JSON.stringify(j.cast)}, $${j.tts_cost_usd}`);
  return j;
}

// Browser preview: generate the voiceover mp3 and hand back its (presigned) url so the
// studio can play it in sync with the video before the user commits to an export.
app.post('/api/voiceover', async (req, res) => {
  try {
    const { videoId, subs = [], voices = {}, language = 'en-US' } = req.body || {};
    const src = resolveVideo(videoId);
    if (!src) return res.status(404).json({ error: 'video not found in library' });
    const vo = await requestVoiceover({ s3Uri: src.s3Uri, language, subs, voices });
    res.json({ presigned_url: vo.presigned_url, duration_seconds: vo.duration_seconds, cast: vo.cast, timeline: vo.timeline });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Snap subtitle cues to the spoken audio the API returned (matched by line id).
function applyTimeline(subs, timeline) {
  if (!Array.isArray(timeline)) return;
  const byId = new Map(timeline.map((e) => [e.id, e]));
  for (const c of subs) {
    const e = byId.get(c.id);
    if (!e) continue;
    if (Number.isFinite(+e.start_sec)) c.start = +e.start_sec;
    if (Number.isFinite(+e.end_sec)) c.end = +e.end_sec;
  }
}

// ---------- Level 3: face swap + AI dub + lip-sync (Cobra API) ----------
const COBRA_API_URL = process.env.COBRA_API_URL || 'https://a7c6n0seh4.execute-api.eu-west-1.amazonaws.com/Prod';
// The Cobra pipeline must be able to download the face images, so they need a public
// URL. Set PUBLIC_BASE_URL to the deployed origin; locally we fall back to the request
// host (only reachable by the API if the server itself is public / tunnelled).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const publicBase = (req) => (PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
// The Cobra pipeline runs on AWS, so a face URL on localhost / a private LAN address
// is unreachable. Detect that so we can reject before wasting a paid job.
function isReachableBase(base) {
  try {
    const h = new URL(base).hostname;
    return !(/^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|169\.254\.)/i.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
  } catch { return false; }
}

function parseImageDataUrl(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('face image must be a PNG/JPG/WebP data URL');
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  return { ext, mime: m[1], buffer: Buffer.from(m[3], 'base64') };
}
function saveFaceImage(id, dataUrl) {
  const { ext, buffer } = parseImageDataUrl(dataUrl);
  const file = `${slug(id) || 'face'}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(FACES_DIR, file), buffer);
  return file;
}

// Optional S3 upload for faces. When S3_UPLOAD_BUCKET is set (+ AWS creds from the
// default chain: `aws configure` locally, or AWS_* env vars in prod), an uploaded face
// is stored in S3 and referenced by a presigned GET URL — reachable by the face-swap
// service without making the bucket public. No config → falls back to local hosting.
const S3_UPLOAD_BUCKET = process.env.S3_UPLOAD_BUCKET || '';
const S3_UPLOAD_REGION = process.env.S3_UPLOAD_REGION || S3_REGION;
const S3_UPLOAD_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'faces/').replace(/^\/+/, '');
const S3_UPLOAD_PUBLIC = process.env.S3_UPLOAD_PUBLIC === 'true'; // bucket serves objects publicly
const s3Enabled = !!S3_UPLOAD_BUCKET;
const s3Client = s3Enabled ? new S3Client({ region: S3_UPLOAD_REGION }) : null;

async function uploadToS3(key, buffer, mime) {
  await s3Client.send(new PutObjectCommand({ Bucket: S3_UPLOAD_BUCKET, Key: key, Body: buffer, ContentType: mime }));
  if (S3_UPLOAD_PUBLIC) return `https://${S3_UPLOAD_BUCKET}.s3.${S3_UPLOAD_REGION}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_UPLOAD_BUCKET, Key: key }), { expiresIn: 604800 }); // 7 days
}
async function uploadFaceToS3(id, dataUrl) {
  const { ext, mime, buffer } = parseImageDataUrl(dataUrl);
  const key = `${S3_UPLOAD_PREFIX}${slug(id) || 'face'}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  return uploadToS3(key, buffer, mime);
}
// Trim the source video to its first `seconds` and upload the clip to S3 → reachable URL.
// `-t` makes ffmpeg stop reading early, so only the first slice is downloaded.
async function trimVideoAndUpload(src, seconds) {
  const tmp = fs.mkdtempSync(path.join(WORK, 'trim-'));
  const out = path.join(tmp, 'clip.mp4');
  try {
    await run(ffmpegPath, ['-y', '-i', src.url, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', out]);
    const key = `clips/${slug(path.basename(src.key, path.extname(src.key)))}-first${seconds}s-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
    return uploadToS3(key, fs.readFileSync(out), 'video/mp4');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// Pull any cloud-saved templates (templates/ prefix) down into the local library dir
// so "Save to library" survives restarts/redeploys on ephemeral disks. Best-effort.
async function s3BodyToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
async function syncTemplatesFromS3() {
  if (!s3Enabled) return 0;
  let count = 0, token;
  do {
    const out = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_UPLOAD_BUCKET, Prefix: 'templates/', ContinuationToken: token }));
    for (const obj of out.Contents || []) {
      if (!/\.xlsx$/i.test(obj.Key)) continue;
      const local = path.join(TEMPLATES_DIR, path.basename(obj.Key));
      if (fs.existsSync(local)) continue;
      try {
        const g = await s3Client.send(new GetObjectCommand({ Bucket: S3_UPLOAD_BUCKET, Key: obj.Key }));
        fs.writeFileSync(local, await s3BodyToBuffer(g.Body));
        count++;
      } catch (e) { console.warn('[templates] sync failed for', obj.Key, e.message); }
    }
    token = out.IsTruncated ? out.NextContinuationToken : null;
  } while (token);
  if (count) TEMPLATE_CACHE = null;
  return count;
}

// Upload a face image on the frontend's request; returns a reachable public URL.
app.post('/api/upload-face', async (req, res) => {
  try {
    const { dataUrl, id = 'face' } = req.body || {};
    if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });
    if (s3Enabled) return res.json({ url: await uploadFaceToS3(id, dataUrl), storage: 's3' });
    // No S3: host locally (only reachable by the API once the server is public)
    return res.json({ url: null, storage: 'local', hint: 'S3 not configured — set S3_UPLOAD_BUCKET (+ AWS creds) to make uploads reachable, or paste a public image URL.' });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Submit a Level 3 job: host any uploaded faces, build the Cobra payload, POST it.
// Local jobs bridge the slow prep work (trim → upload → Cobra submit) so the browser's
// POST returns instantly and the whole thing is pollable.  localId → { stage, cobraJobId, error }
const level3Jobs = new Map();

app.post('/level3', async (req, res) => {
  try {
    const { videoId, subs = [], faces = {}, language = 'en-US', limitSeconds, subsBurn = true, trimSeconds } = req.body || {};
    const src = resolveVideo(videoId);
    if (!src) return res.status(404).json({ error: 'video not found in library' });
    const trim = +trimSeconds > 0 ? +trimSeconds : 0;
    if (trim && !s3Enabled) return res.status(400).json({ error: 'Trimming needs S3 upload configured (S3_UPLOAD_BUCKET) to host the clip.' });
    const base = publicBase(req);
    const hasUploaded = Object.values(faces).some((f) => f && f.dataUrl && !(f.url && /^https?:\/\//i.test(f.url)));
    if (hasUploaded && !s3Enabled && !isReachableBase(base)) {
      return res.status(400).json({ error: `Uploaded faces are served from ${base}, which the face-swap service (on AWS) can't reach. Configure S3 upload (S3_UPLOAD_BUCKET), paste a public image URL, or set PUBLIC_BASE_URL to a reachable origin.` });
    }
    // Every character present in the clip (trim window, or the whole video) must have
    // a face uploaded — enforce it up front so the browser gets an immediate error.
    const effForCheck = trim ? subs.filter((c) => +c.start < trim) : subs;
    const presentIds = [...new Set(effForCheck.map((c) => slug(cleanSpeaker(c.person))).filter(Boolean))];
    const missingFace = presentIds.filter((id) => { const f = faces[id]; return !(f && (f.url || f.dataUrl)); });
    if (missingFace.length) return res.status(400).json({ error: `Upload a face for every character${trim ? ` in the first ${trim}s` : ''}: missing ${missingFace.join(', ')}.` });

    // Respond immediately with a local job id; do the heavy lifting in the background.
    const localId = `l3_${randomUUID()}`;
    const job = { stage: 'preparing', cobraJobId: null, error: null, createdAt: Date.now() };
    level3Jobs.set(localId, job);
    console.log(`[L3] ${localId} accepted — video=${videoId} trim=${trim || 'none'} faces=${Object.keys(faces).length} subs=${subs.length}`);
    res.json({ jobId: localId, status: 'preparing' });

    (async () => {
      try {
        let sourceUrl = src.url;
        let effSubs = subs;
        if (trim) {
          job.stage = 'trimming';
          console.log(`[L3] ${localId} trimming to first ${trim}s…`);
          sourceUrl = await trimVideoAndUpload(src, trim);
          effSubs = subs.filter((c) => +c.start < trim).map((c) => ({ ...c, end: Math.min(+c.end, trim) }));
          console.log(`[L3] ${localId} trimmed clip uploaded.`);
        }
        job.stage = 'uploading-faces';
        // Every speaker in the (trimmed) subtitles becomes a character. A face is attached
        // when one was provided; a speaker with no face keeps its original on-screen face
        // (still dubbed/lip-synced) — its lines are NOT dropped.
        const speakerName = new Map(); // id -> display name, first-seen order
        for (const c of effSubs) { const nm = cleanSpeaker(c.person); const id = slug(nm); if (id && !speakerName.has(id)) speakerName.set(id, nm); }
        const characters = [];
        for (const [id, name] of speakerName) {
          const f = faces[id];
          const ch = { id, name };
          let imageUrl = null;
          if (f && f.url && /^https?:\/\//i.test(f.url)) imageUrl = f.url.trim();
          else if (f && f.dataUrl) imageUrl = s3Enabled ? await uploadFaceToS3(id, f.dataUrl) : `${base}/faces/${saveFaceImage(id, f.dataUrl)}`;
          if (imageUrl) ch.face = { image_url: imageUrl, target_ref: (f && f.target_ref) || 'auto' };
          characters.push(ch);
        }
        // Every character present must have a face (validated synchronously above; this
        // is a backstop). No minimum-count rule.
        const faceless = characters.filter((c) => !c.face);
        if (faceless.length) throw new Error(`Missing a face for: ${faceless.map((c) => c.name).join(', ')}`);
        const subtitles = effSubs
          .filter((c) => c.text && c.text.trim() && slug(cleanSpeaker(c.person)))
          .map((c) => ({ id: c.id, character_id: slug(cleanSpeaker(c.person)), start_sec: +c.start, end_sec: +c.end, text: c.text }));
        if (!subtitles.length) throw new Error(trim ? `No spoken lines in the first ${trim}s.` : 'No spoken subtitle lines.');

        const payload = { video_url: sourceUrl, language, characters, subtitles };
        if (subsBurn === false) payload.subs = false;
        if (limitSeconds) payload.limit_seconds = limitSeconds;
        job.stage = 'submitting';
        console.log(`[L3] ${localId} → Cobra /generate (${characters.length} chars, ${subtitles.length} lines):\n` + JSON.stringify(payload, null, 2));
        const r = await fetch(`${COBRA_API_URL}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await r.json().catch(() => ({}));
        if (r.status !== 202) throw new Error(j.error || `Cobra API returned ${r.status}`);
        job.cobraJobId = j.job_id;
        job.stage = 'payload';
        console.log(`[L3] ${localId} submitted → Cobra job ${j.job_id}`);
      } catch (e) {
        job.error = String(e.message || e);
        console.error(`[L3] ${localId} prepare failed:`, job.error);
      }
    })();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Poll a Level 3 job. Reports our prep stages until Cobra has a job id, then proxies Cobra.
app.get('/level3/:jobId', async (req, res) => {
  try {
    const id = req.params.jobId;
    const local = level3Jobs.get(id);
    if (local) {
      if (local.error) return res.json({ status: 'failed', error: local.error });
      if (!local.cobraJobId) return res.json({ status: 'preparing', stage: local.stage });
    }
    const cobraId = local ? local.cobraJobId : id;
    const r = await fetch(`${COBRA_API_URL}/jobs/${encodeURIComponent(cobraId)}`);
    if (r.status === 404) return res.status(404).json({ error: 'job not found' });
    const out = await r.json();
    console.log(`[L3] poll ${id}${local ? ` (cobra ${cobraId})` : ''} → ${out.status || '?'}${out.stage ? '/' + out.stage : ''}`);
    res.json(out);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

const jobs = new Map(); // jobId -> { percent, stage, done, error, file, dir }

// Kick off an export job; returns immediately with a jobId. Progress via SSE.
app.post('/export', async (req, res) => {
  const { videoId, level = 1, sourceUrl } = req.body || {};
  // Burn & Export only burns subtitles (+ optional voiceover). Face swap is a separate
  // pipeline (POST /level3); its generated result can be burned here by passing sourceUrl.
  let src;
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) src = { key: path.basename(String(videoId || 'result.mp4')), url: sourceUrl, s3Uri: null };
  else { src = resolveVideo(videoId); if (!src) return res.status(404).json({ error: 'video not found in library' }); }
  let meta = metaCache.get(src.url);
  if (!meta) {
    try { meta = await probe(src.url); metaCache.set(src.url, meta); }
    catch (e) { return res.status(500).json({ error: 'could not read video: ' + e.message }); }
  }
  const jobId = randomUUID();
  jobs.set(jobId, { percent: 0, stage: 'Starting…', done: false, error: null, file: null, dir: null });
  res.json({ jobId });
  // Keep the script lines intact — they're the voiceover text at any level. Whether they
  // get *burned* onto the video is decided by `level` inside runExportJob.
  runExportJob(jobId, { src, meta }, { ...req.body, subs: req.body.subs || [] }).catch((e) => {
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

async function runExportJob(jobId, s, { level = 1, intro = [], subs = [], outro = [], preset, crf, maxHeight, subStyle, voiceover = false, voices = {}, language = 'en-US', voiceUrl = null }) {
  const job = jobs.get(jobId);
  const { fps, duration: videoDur } = s.meta;
  const burnSubs = +level >= 1 ? subs : []; // subtitles are only burned at Level 1
  const styleFont = resolveStyle(subStyle).font; // same font used for black screens
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
    fs.writeFileSync(scrAss, buildScreenAss(sc.text, w, h, dur, styleFont));
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

  // Level 2: generate the replacement voiceover before touching the video.
  let voiceMp3 = null;
  if (voiceover) {
    // Reuse the mp3 already generated for the preview when the client passes it back
    // (the client already snapped the subs to the timeline); otherwise generate fresh
    // and align the burned subs to the returned timeline here.
    job.stage = voiceUrl ? 'Fetching voiceover…' : 'Generating voiceover…';
    let url = voiceUrl;
    if (!url) {
      const vo = await requestVoiceover({ s3Uri: s.src.s3Uri, language, subs, voices });
      url = vo.presigned_url;
      applyTimeline(burnSubs, vo.timeline); // captions follow the spoken audio
    }
    voiceMp3 = path.join(dir, 'voice.mp3');
    fs.writeFileSync(voiceMp3, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }

  const parts = [];
  for (let i = 0; i < intro.length; i++) parts.push(await blackClip(intro[i], `Rendering intro ${i + 1}/${intro.length}…`));

  // main video: burn subs (if any) and swap in the generated voice track (if any)
  job.stage = voiceMp3 ? 'Applying voiceover & subtitles…' : 'Burning subtitles into video…';
  const assPath = path.join(dir, 'subs.ass');
  fs.writeFileSync(assPath, buildAss(burnSubs, w, h, subStyle));
  const mainOut = path.join(dir, 'main.mp4');
  const assArg = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  // Only rescale when the source is actually bigger than target — skips a full
  // per-frame scale pass (and its CPU cost) for videos already at/under MAX_HEIGHT.
  const needScale = s.meta.height !== h || s.meta.width !== w;
  const scalePre = needScale ? `scale=${w}:${h}:flags=bicubic,setsar=1,` : '';
  // The voice mp3 is timeline-placed (silence between lines) and usually shorter than
  // the clip, so map video from input 0 and audio from input 1 WITHOUT -shortest — the
  // video governs length and the voice simply ends when the last line does.
  const audioMap = voiceMp3 ? ['-map', '0:v:0', '-map', '1:a:0'] : [];
  await run(ffmpegPath, [
    ...PROG, '-i', s.src.url,
    ...(voiceMp3 ? ['-i', voiceMp3] : []),
    '-vf', `${scalePre}subtitles='${assArg}':fontsdir='${FONTS_ARG}'`,
    ...audioMap, ...THREADS,
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
  generateThumbs(); // warm poster frames in the background; /thumbs regenerates misses on demand
  if (s3Enabled) { try { const n = await syncTemplatesFromS3(); if (n) console.log(`Synced ${n} saved template(s) from cloud`); } catch (e) { console.warn('template cloud sync failed:', e.message); } }
  console.log(`Library: ${listVideos().length} videos, ${listTemplates().length} templates`);
  // Warm transcription + preview caches in the background so the first selection is instant.
  for (const vt of videoTemplates()) {
    if (vt.transcribe && !fs.existsSync(transcriptCacheFile(vt.video))) {
      transcribeVideo(vt.video).then((r) => console.log(`Transcribed ${vt.video}: ${r.subs.length} lines`)).catch((e) => console.warn(`Transcribe ${vt.video} failed: ${e.message}`));
    }
    if (vt.preview) warmPreview(vt.video);
  }
});
