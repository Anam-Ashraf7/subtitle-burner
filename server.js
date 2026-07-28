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
const TEMPLATES_DIR = path.join(__dirname, 'templates', 'subtitles'); // subtitle xlsx templates
const THUMBS_DIR = path.join(__dirname, 'thumbs');            // generated poster frames
for (const d of [WORK, TEMPLATES_DIR, THUMBS_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/fonts', express.static(path.join(__dirname, 'assets', 'fonts'))); // @font-face for WYSIWYG preview
app.use('/thumbs', express.static(THUMBS_DIR)); // static poster frames for template cards

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
function listTemplates() {
  const match = matchTemplateVideos();
  return [...templates().values()].map((t) => templateCard(t, match));
}

// Generate a static poster frame per video (used as the card thumbnail).
// Reads directly from the S3 public URL; -ss before -i seeks via range requests
// so ffmpeg only downloads a small slice rather than the whole file.
async function generateThumbs() {
  for (const v of listVideos()) {
    const out = path.join(THUMBS_DIR, thumbName(v.id));
    if (fs.existsSync(out)) continue;
    try {
      await run(ffmpegPath, ['-ss', '1', '-i', v.url, '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '3', '-y', out]);
    } catch (e) { console.error('thumb failed', v.id, e.message); }
  }
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

app.get('/api/videos', (req, res) => res.json(listVideos()));
app.get('/api/subtitle-templates', (req, res) => res.json(listTemplates()));

// parsed cues (+ placeholders) for a named template
app.get('/api/subtitle-templates/:id', (req, res) => {
  const t = templates().get(req.params.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  const card = templateCard(t, matchTemplateVideos());
  res.json({ intro: t.intro, subs: t.subs, outro: t.outro, placeholders: t.placeholders, type: t.type, name: card.name, videoId: card.videoId, videoUrl: card.videoUrl, videoS3: card.videoS3, thumbUrl: card.thumbUrl });
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

const jobs = new Map(); // jobId -> { percent, stage, done, error, file, dir }

// Kick off an export job; returns immediately with a jobId. Progress via SSE.
app.post('/export', async (req, res) => {
  const { videoId, level = 1, faceswap = false } = req.body || {};
  if (faceswap) return res.status(400).json({ error: 'Level 3 (face swap & lip sync) is not available yet.' });
  const src = resolveVideo(videoId);
  if (!src) return res.status(404).json({ error: 'video not found in library' });
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
    // Reuse the mp3 already generated for the preview when the client passes it back;
    // otherwise generate fresh. Either way the same track ends up on the export.
    job.stage = voiceUrl ? 'Fetching voiceover…' : 'Generating voiceover…';
    const url = voiceUrl || (await requestVoiceover({ s3Uri: s.src.s3Uri, language, subs, voices })).presigned_url;
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
  await generateThumbs();
  console.log(`Library: ${listVideos().length} videos, ${listTemplates().length} templates`);
});
