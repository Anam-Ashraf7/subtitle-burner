const $ = (s) => document.querySelector(s);
const state = { selected: {}, video: null, templateName: null, templateType: '', placeholders: [], rawSubs: [], intro: [], subs: [], outro: [], level: 0, introOutro: false, tplIntro: [], tplOutro: [],
  subStyle: { font: 'dejavu', sizePct: 5.5, color: '#ffffff', bg: 'box', bgColor: '#000000' },
  voices: {}, faces: {} };
let cueSeq = 0;

// Preview styling that mirrors the server's libass output (WYSIWYG)
const FONT_CSS = { dejavu: "'DejaVu Sans'", poppins: "'Poppins'", ptserif: "'PT Serif'", anton: "'Anton'", bebas: "'Bebas Neue'", pacifico: "'Pacifico'" };
const FONT_WEIGHT = { dejavu: 700, poppins: 700, ptserif: 700, anton: 400, bebas: 400, pacifico: 400 };
const hexToRgba = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000'); const [r, g, b] = m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [0, 0, 0]; return `rgba(${r},${g},${b},${a})`; };
function applySubStyle() {
  const st = state.subStyle;
  const o = document.querySelector('#subOverlay');
  o.style.setProperty('--sub-font', FONT_CSS[st.font] || FONT_CSS.dejavu);
  o.style.setProperty('--sub-weight', FONT_WEIGHT[st.font] || 700);
  o.style.setProperty('--sub-color', st.color || '#ffffff');
  o.style.setProperty('--sub-factor', st.sizePct || 5.5);
  const sz = document.querySelector('#sizeSel'); if (sz) sz.value = st.sizePct || 5.5;
  const szv = document.querySelector('#sizeVal'); if (szv) szv.textContent = sizeReadout(st.sizePct || 5.5);
  let bg = 'transparent';
  if (st.bg === 'solid') bg = st.bgColor || '#000000';
  else if (st.bg !== 'none') bg = hexToRgba(st.bgColor || '#000000', 0.5);
  o.style.setProperty('--sub-bg', bg);
  o.classList.remove('bg-box', 'bg-solid', 'bg-none');
  o.classList.add('bg-' + (st.bg || 'box'));
}
const mapCues = (arr, prefix) => (arr || []).map((s) => ({ id: `${prefix}-${cueSeq++}`, ...s }));

// Show the real burned pixel height when we know the video dims (min side × pct),
// matching the server; fall back to the raw percent before the video loads.
function sizeReadout(pct) {
  const v = document.querySelector('#video');
  if (v && v.videoWidth && v.videoHeight) return Math.round(Math.min(v.videoWidth, v.videoHeight) * pct / 100) + ' px';
  return pct + '%';
}

// Editing guard: a line may grow to at most 1.5x its original character length.
// Lines added from scratch get a budget from their duration instead (~15 chars/sec).
const CPS = 15;
function capFor(c) {
  const len = (c.text || '').trim().length;
  const base = len || Math.max(1, (c.end - c.start) || 2) * CPS;
  return Math.max(24, Math.ceil(base * 1.5));
}
const withLimits = (arr) => arr.map((c) => ({ ...c, maxLen: c.maxLen ?? capFor(c) }));

const video = $('#video');
const subOverlay = $('#subOverlay');
const blackOverlay = $('#blackOverlay');
const blackText = $('#blackText');
const voiceAudio = $('#voiceAudio');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (t) => { const m = Math.floor(t / 60), s = (t % 60); return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const autoDur = (text) => Math.max(1.5, +(((text || '').trim().length) / 15).toFixed(2));
function setMsg(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || ''); }

// ===================== LOAD TEMPLATES INTO LEVEL ROWS =====================
const LEVEL_ROWS = { '0': '#railLevel0', '1': '#railLevel1', '2': '#railLevel2', '3': '#railLevel3' };

async function boot() {
  try {
    const tpls = await (await fetch('/api/subtitle-templates')).json();
    renderLevels(tpls);
  } catch {
    Object.values(LEVEL_ROWS).forEach((s) => ($(s).innerHTML = '<div class="loading">Failed to load templates.</div>'));
  }
}

function card({ cls = '', thumbHtml, cap, sub, onClick }) {
  const el = document.createElement('div');
  el.className = 'card ' + cls;
  el.innerHTML = `${thumbHtml}<div class="cap">${escapeHtml(cap)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
const placeholderThumb = (icon) => `<div class="thumb placeholder">${icon}</div>`;

function renderLevels(tpls) {
  const byType = { '0': [], '1': [], '2': [], '3': [] };
  tpls.forEach((t) => { if (byType[t.type]) byType[t.type].push(t); });
  for (const [type, sel] of Object.entries(LEVEL_ROWS)) renderRail(sel, byType[type]);
  if (!byType['1'].length) $('#railLevel1').innerHTML = '<div class="loading">No subtitle templates yet — use <b>⬆ Upload xlsx</b> in the top bar.</div>';
}

function renderRail(sel, list) {
  const rail = $(sel);
  rail.innerHTML = '';
  if (!list || !list.length) { rail.innerHTML = '<div class="loading">Nothing here yet.</div>'; return; }
  list.forEach((t) => {
    const thumb = t.thumbUrl ? `<img class="thumb" src="${t.thumbUrl}" alt="" loading="lazy" />` : placeholderThumb('🎬');
    const el = card({ thumbHtml: thumb, cap: t.name, sub: t.typeLabel + (t.videoId ? '' : ' · no video'), onClick: () => selectTemplate(t, el) });
    el.dataset.id = t.id;
    rail.appendChild(el);
  });
}

// ===================== SELECTION (browse view — no navigation) =====================
// "level" here means: are subtitles burned into the video? Yes whenever the chosen
// script has lines — a Level 2/3 template still carries its dialogue as subtitles.
function deriveLevel() { state.level = state.subs.length ? 1 : 0; }

async function selectTemplate(t, el) {
  try {
    const cues = await (await fetch(`/api/subtitle-templates/${encodeURIComponent(t.id)}`)).json();
    applyCues({ ...cues, id: t.id }, cues.name || t.name, el);
  } catch { alert('Failed to load template.'); }
}

// Levels are independent: one pick per level row, any number of levels at once.
function applyCues(cues, name, el) {
  const type = String(cues.type ?? '');
  const already = el && el.classList.contains('selected');
  if (el) el.closest('.rail')?.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
  if (already) delete state.selected[type];
  else {
    if (el) el.classList.add('selected');
    state.selected[type] = { ...cues, type, name };
  }
  composeSelection();
}

// Compose the active script from whatever levels are selected:
//   level 0 -> intro/outro · level 1 -> subtitles · highest level -> source video
function composeSelection() {
  const s = state.selected;
  const order = ['3', '2', '1', '0'];
  const primary = order.map((t) => s[t]).find(Boolean) || null;
  if (!primary) {
    Object.assign(state, { templateName: null, templateType: '', placeholders: [], rawSubs: [], subs: [], intro: [], outro: [], tplIntro: [], tplOutro: [], video: null, introOutro: false });
    deriveLevel(); updateSelbar(); $('#selbar').hidden = true; return;
  }
  const scriptSrc = s['1'] || primary;          // subtitles come from the Subtitles pick when present
  const screensSrc = s['0'] || primary;         // intro/outro come from the Intro & Outro pick when present
  state.templateName = primary.name;
  state.templateType = primary.type;
  state.placeholders = [...new Set(Object.values(s).flatMap((x) => x.placeholders || []))];
  state.rawSubs = scriptSrc.subs || [];
  state.subs = withLimits(mapCues(state.rawSubs, 'sub'));
  state.tplIntro = screensSrc.intro || [];
  state.tplOutro = screensSrc.outro || [];
  state.video = primary.videoId ? { id: primary.videoId, url: primary.videoUrl, s3: primary.videoS3, name: primary.name } : null;
  state.introOutro = (state.tplIntro.length || state.tplOutro.length) > 0;
  $('#selbar').hidden = false;
  deriveLevel();
  updateSelbar();
}

// Upload lives in the top bar (next to "My Renders")
$('#navUpload').addEventListener('click', () => $('#xlsxInput').click());

$('#xlsxInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('xlsx', file);
  try {
    const r = await fetch('/api/subtitles', { method: 'POST', body: fd });
    const cues = await r.json();
    if (!r.ok) throw new Error(cues.error || 'parse failed');
    const label = cues.name ? String(cues.name).replace(/\b\w/g, (c) => c.toUpperCase()) : file.name.replace(/\.xlsx$/i, '');
    applyCues(cues, label, null);
    // show the uploaded sheet as a selected card in its level row
    const rail = $(LEVEL_ROWS[cues.type] || '#railLevel1');
    const thumb = state.video ? `<img class="thumb" src="/thumbs/${encodeURIComponent(state.video.id.replace(/\.[^.]+$/, ''))}.jpg" alt="" />` : placeholderThumb('📄');
    if (rail.querySelector('.loading')) rail.innerHTML = '';
    const el = card({ cls: 'selected', thumbHtml: thumb, cap: label, sub: 'uploaded' + (state.video ? '' : ' · no video') });
    rail.prepend(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) { alert(err.message); }
  e.target.value = '';
});

function activeLayers() {
  const parts = [];
  if (state.introOutro || state.intro.length || state.outro.length) parts.push('Intro & Outro');
  if (state.subs.length) parts.push('Subtitles');
  return parts;
}
function modeName() { const p = activeLayers(); return p.length ? p.join(' + ') : 'Video only'; }
const LEVEL_NAME = { '0': 'Intro & Outro', '1': 'Subtitles', '2': 'Voiceover', '3': 'Manipulate heads' };
function updateSelbar() {
  const info = document.querySelector('#selbar .selbar-info');
  const picks = Object.keys(state.selected).sort();
  info.innerHTML = picks.length
    ? picks.map((t) => `<span class="selbar-chip"><b>L${t}</b> ${escapeHtml(state.selected[t].name)}</span>`).join('')
      + `<span class="selbar-chip alt">${state.subs.length} lines${state.video ? '' : ' · no video'}</span>`
    : '<span class="selbar-chip">Nothing selected</span>';
  $('#continueBtn').disabled = !picks.length;
}

// ===================== CONTINUE → FORM → STUDIO =====================
$('#continueBtn').addEventListener('click', openForm);
$('#backBtn').addEventListener('click', closeStudio);
$('#formBack').addEventListener('click', () => { $('#formView').hidden = true; $('#browseView').hidden = false; $('#selbar').hidden = false; });

// ---- Form data ----
const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia'];
const PARTIES = [['democrat', 'Democrat'], ['republican', 'Republican']];
const POSITIONS = ['Mayor', 'Governor', 'Lieutenant Governor', 'Attorney General', 'Secretary of State', 'U.S. Senator', 'U.S. Representative', 'State Senator', 'State Representative', 'Council member', 'County Commissioner', 'Sheriff', 'District Attorney', 'Judge', 'School Board Member', 'City Clerk', 'Treasurer', 'Assessor', 'Auditor', 'Comptroller'];

const prettyToken = (t) => t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2');
// EVERY placeholder in the template becomes its own field.
const dynamicTokens = () => [...new Set(state.placeholders)];

// Standard fields conveniently auto-fill the matching placeholder field (until the
// user edits that field directly). LastNameX derives from the full name's last word.
function syncStandardToTokens() {
  const fn = $('#f-fullname').value.trim();
  const set = (tok, val) => { const inp = document.querySelector(`#dynFields [data-token="${tok}"]`); if (inp && !inp.dataset.dirty && val) inp.value = val; };
  set('FullNameX', fn);
  set('LastNameX', fn ? fn.split(/\s+/).pop() : '');
  set('OfficeX', $('#f-position').value);
  set('CityX', $('#f-city').value.trim());
}
$('#f-fullname').addEventListener('input', syncStandardToTokens);
$('#f-position').addEventListener('change', syncStandardToTokens);
$('#f-city').addEventListener('input', syncStandardToTokens);

function fillOnce() {
  const sel = $('#f-state'); if (sel.options.length) return;
  $('#f-position').innerHTML = '<option value="">Choose title…</option>' + POSITIONS.map((p) => `<option>${p}</option>`).join('');
  $('#f-state').innerHTML = '<option value="">Choose state…</option>' + STATES.map((s) => `<option${s === 'Wisconsin' ? ' selected' : ''}>${s}</option>`).join('');
  $('#f-party').innerHTML = '<option value="">Choose party…</option>' + PARTIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

function openForm() {
  if (!state.video) return;
  fillOnce();
  $('#formTitle').textContent = state.templateName || state.video.name;
  const typeLabel = { '0': 'No text', '1': 'Subtitles', '2': 'Voiceover', '3': 'Head swap' }[state.templateType];
  $('#formType').textContent = typeLabel || ''; $('#formType').style.display = typeLabel ? '' : 'none';
  // hints removed — every placeholder now has its own field below
  ['map-fullname', 'map-position', 'map-city'].forEach((id) => ($('#' + id).textContent = ''));
  // one field for EVERY placeholder found in the script (any [Token] / (Token])
  const dyn = $('#dynFields'); dyn.innerHTML = '';
  const toks = dynamicTokens();
  if (toks.length) {
    dyn.insertAdjacentHTML('beforeend', '<div class="dyn-head">Script placeholders</div><div class="dyn-note">A field for every ' + '[placeholder]' + ' in the script. Ones matching the fields above pre-fill automatically — edit any of them freely.</div>');
    toks.forEach((t) => {
      const wrap = document.createElement('div'); wrap.className = 'fld';
      wrap.innerHTML = `<span class="fld-label"><i>◆</i> ${escapeHtml(prettyToken(t))} <span class="tok">[${escapeHtml(t)}]</span></span><input class="tin dyn-in" data-token="${t}" type="text" placeholder="Enter ${escapeHtml(prettyToken(t)).toLowerCase()}" />`;
      const inp = wrap.querySelector('input');
      inp.addEventListener('input', () => { inp.dataset.dirty = '1'; });
      dyn.appendChild(wrap);
    });
  }
  // Level 3 picked → collect a face per character right here in the form
  const chars = characters();
  const wantFaces = !!state.selected['3'] && chars.length > 0;
  $('#formFaceWrap').hidden = !wantFaces;
  if (wantFaces) renderFaceChars(chars, '#formFaces');

  syncStandardToTokens(); // pre-fill overlapping tokens from any values already typed
  $('#browseView').hidden = true; $('#selbar').hidden = true; $('#formView').hidden = false;
  window.scrollTo({ top: 0 });
}

// replace [Token] (and stray "(Token]") with entered values
function fillPlaceholders(text, values) {
  return String(text).replace(/[[(]\s*([A-Za-z][A-Za-z0-9]*)\s*\]/g, (m, tok) => (values[tok] != null && values[tok] !== '' ? values[tok] : m));
}

$('#genForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const values = {};
  // per-placeholder fields are the source of truth
  document.querySelectorAll('#dynFields .dyn-in').forEach((inp) => { if (inp.value.trim()) values[inp.dataset.token] = inp.value.trim(); });
  // fallback to the standard fields for any overlapping token left blank
  const fullName = $('#f-fullname').value.trim();
  if (fullName) { values.FullNameX ??= fullName; values.LastNameX ??= fullName.split(/\s+/).pop(); }
  if ($('#f-position').value) values.OfficeX ??= $('#f-position').value;
  if ($('#f-city').value.trim()) values.CityX ??= $('#f-city').value.trim();

  // build filled cues from the raw template text
  const fill = (arr) => arr.map((c) => ({ ...c, text: fillPlaceholders(c.text, values) }));
  state.subs = withLimits(mapCues(fill(state.rawSubs), 'sub'));
  if (state.introOutro) { state.intro = mapCues(fill(state.tplIntro), 'intro'); state.outro = mapCues(fill(state.tplOutro), 'outro'); }
  else { state.intro = []; state.outro = []; }
  deriveLevel();
  $('#formView').hidden = true;
  openStudio();
});

function openStudio() {
  document.body.classList.add('studio-open');
  // a template may have no source video yet (it'll come from the generator)
  const hasVideo = !!state.video;
  $('#noVideoNote').hidden = hasVideo;
  document.querySelector('.stage').style.display = hasVideo ? '' : 'none';
  document.querySelector('.preview-controls').style.display = hasVideo ? '' : 'none';
  $('#exportBtn').disabled = !hasVideo;
  $('#substyleBox').style.display = hasVideo && state.level >= 1 ? '' : 'none';
  $('#browseView').hidden = true;
  $('#selbar').hidden = true;
  $('#studio').hidden = false;
  if (hasVideo) { video.src = state.video.url; blackOverlay.hidden = true; }
  else { video.removeAttribute('src'); }
  $('#chosenVideo').textContent = state.templateName || (state.video && state.video.name) || '—';
  deriveLevel();
  applySubStyle();
  renderPane('intro'); renderPane('subs'); renderPane('outro');
  updateTabCounts();
  switchTab(state.subs.length ? 'subs' : 'intro');
  updateLevelUI();
  renderCharacterBoxes();
  markClean();
  updateSubOverlay();
  clearVoiceAudio();
  maybeGenerateVoice(); // build the Level 2 voice track up front so it's previewable
  window.scrollTo({ top: 0 });
}
function closeStudio() {
  stopPreview();
  video.pause();
  voiceAudio.pause();
  document.body.classList.remove('studio-open');
  $('#studio').hidden = true;
  $('#browseView').hidden = false;
  $('#selbar').hidden = false;
}

// ===================== SUBTITLE STYLE =====================
$('#fontSel').addEventListener('change', (e) => { state.subStyle.font = e.target.value; applySubStyle(); markDirty(); });
$('#sizeSel').addEventListener('input', (e) => { state.subStyle.sizePct = parseFloat(e.target.value); $('#sizeVal').textContent = sizeReadout(state.subStyle.sizePct); applySubStyle(); markDirty(); });
$('#bgSel').addEventListener('change', (e) => { state.subStyle.bg = e.target.value; applySubStyle(); markDirty(); });
$('#bgColorSel').addEventListener('input', (e) => { state.subStyle.bgColor = e.target.value; applySubStyle(); markDirty(); });
$('#colorSel').addEventListener('input', (e) => { state.subStyle.color = e.target.value; applySubStyle(); markDirty(); });

// ===================== LEVEL 2 / 3 CHARACTER BOXES =====================
// Characters come from the script's speaker column, in order of first appearance.
function characters() {
  const seen = new Map();
  state.subs.forEach((c) => { const n = (c.person || '').trim(); if (n && !seen.has(n)) seen.set(n, { id: slug(n), name: n }); });
  return [...seen.values()];
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';

function renderCharacterBoxes() {
  const chars = characters();
  const wantVoice = !!state.selected['2'], wantFace = !!state.selected['3'];
  $('#voiceBox').hidden = !(wantVoice && chars.length);
  $('#faceBox').hidden = !(wantFace && chars.length);
  if (wantVoice) renderVoiceChars(chars);
  if (wantFace) renderFaceChars(chars);
}

// A group speaker ("Both, in unison") is voiced by the individual voices together —
// it needs no prompt of its own. Mirrors the server's isGroupSpeaker.
const GROUP_RE = /\b(unison|everyone|all|both|together|group|crowd)\b/i;
const isGroup = (name) => GROUP_RE.test(String(name || ''));

function renderVoiceChars(chars) {
  const box = $('#voiceChars'); box.innerHTML = '';
  chars.forEach((ch) => {
    if (isGroup(ch.name)) {
      const row = document.createElement('div');
      row.className = 'charrow group';
      row.innerHTML = `
        <div class="avatar sm" style="--sc:${speakerColor(ch.name)}">${escapeHtml(initials(ch.name))}</div>
        <div class="charbody">
          <div class="charname">${escapeHtml(ch.name)}</div>
          <div class="group-note">🎙 Spoken by the individual voices together — no separate description needed.</div>
        </div>`;
      box.appendChild(row);
      return;
    }
    state.voices[ch.id] ??= { name: ch.name, prompt: '' };
    const row = document.createElement('div');
    row.className = 'charrow';
    row.innerHTML = `
      <div class="avatar sm" style="--sc:${speakerColor(ch.name)}">${escapeHtml(initials(ch.name))}</div>
      <div class="charbody">
        <div class="charname">${escapeHtml(ch.name)}</div>
        <textarea rows="2" placeholder="Describe this voice — age, accent, tone, energy…">${escapeHtml(state.voices[ch.id].prompt)}</textarea>
      </div>`;
    row.querySelector('textarea').addEventListener('input', (e) => { state.voices[ch.id].prompt = e.target.value; markDirty(); });
    box.appendChild(row);
  });
}

function renderFaceChars(chars, sel = '#faceChars') {
  const box = $(sel); box.innerHTML = '';
  chars.forEach((ch) => {
    state.faces[ch.id] ??= { name: ch.name, dataUrl: null, fileName: null };
    const f = state.faces[ch.id];
    const row = document.createElement('div');
    row.className = 'charrow face';
    row.innerHTML = `
      <div class="facepic${f.dataUrl ? ' has' : ''}" style="--sc:${speakerColor(ch.name)}">${f.dataUrl ? `<img src="${f.dataUrl}" alt="" />` : escapeHtml(initials(ch.name))}</div>
      <div class="charbody">
        <div class="charname">${escapeHtml(ch.name)}</div>
        <div class="facectrl">
          <button class="mini pick">${f.dataUrl ? 'Replace image' : '⬆ Upload face'}</button>
          <span class="facename">${f.fileName ? escapeHtml(f.fileName) : 'JPG or PNG · clear, front-facing'}</span>
          ${f.dataUrl ? '<button class="mini del">✕</button>' : ''}
        </div>
        <input type="file" accept="image/*" hidden />
      </div>`;
    const input = row.querySelector('input[type=file]');
    row.querySelector('.pick').addEventListener('click', () => input.click());
    row.querySelector('.del')?.addEventListener('click', () => { state.faces[ch.id] = { name: ch.name, dataUrl: null, fileName: null }; renderFaceChars(chars, sel); markDirty(); });
    input.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = () => { state.faces[ch.id] = { name: ch.name, dataUrl: rd.result, fileName: file.name }; renderFaceChars(chars, sel); markDirty(); };
      rd.readAsDataURL(file);
    });
    box.appendChild(row);
  });
}

// ===================== MODE BADGE (studio) =====================
function updateLevelUI() {
  deriveLevel();
  $('#levelBadge').textContent = modeName();
  const ct = $('#chosenTemplate');
  if (state.subs.length && state.templateName) { ct.style.display = ''; ct.textContent = `Subtitles: ${state.templateName} (${state.subs.length} lines)`; }
  else ct.style.display = 'none';
}

// ===================== PREVIEW OVERLAY =====================
// Match the preview frame to the video's real aspect ratio so the subtitle
// size/position previews exactly like the burn (portrait 9:16 vs landscape 16:9).
video.addEventListener('loadedmetadata', () => {
  const ar = (video.videoWidth || 16) / (video.videoHeight || 9);
  const stage = document.querySelector('.stage');
  stage.style.aspectRatio = String(ar);
  if (ar < 1) { stage.style.height = '72vh'; stage.style.width = 'auto'; }
  else { stage.style.height = ''; stage.style.width = ''; }
  const szv = $('#sizeVal'); if (szv) szv.textContent = sizeReadout(state.subStyle.sizePct || 5.5);
});
video.addEventListener('timeupdate', updateSubOverlay);
function updateSubOverlay() {
  if (state.level < 1) { subOverlay.innerHTML = ''; return; }
  const t = video.currentTime;
  let active = null;
  for (const c of state.subs) { if (t >= c.start && t <= c.end) { active = c; break; } }
  subOverlay.innerHTML = active && active.text ? `<span>${escapeHtml(active.text)}</span>` : '';
  document.querySelectorAll('#pane-subs .cue').forEach((el) => el.classList.toggle('active', active && el.dataset.id === active.id));
  // keep the active cue visible by scrolling ONLY its list box — never the page,
  // so the video preview on the left stays put (unless the user is typing)
  if (active && !$('#pane-subs').hidden && document.activeElement?.tagName !== 'TEXTAREA') {
    scrollCueIntoView($('#pane-subs'), document.querySelector(`#pane-subs .cue[data-id="${active.id}"]`));
  }
}
// Adjust only the container's scrollTop to reveal el; leaves window scroll untouched.
function scrollCueIntoView(pane, el) {
  if (!pane || !el) return;
  const pr = pane.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.top < pr.top + 8) pane.scrollTop += er.top - pr.top - 8;
  else if (er.bottom > pr.bottom - 8) pane.scrollTop += er.bottom - pr.bottom + 8;
}

// ===================== EDITOR TABS =====================
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['intro', 'subs', 'outro'].forEach((k) => { $('#pane-' + k).hidden = k !== tab; });
}

const SPK_COLORS = ['#6ea8fe', '#f6c945', '#7ee787', '#ff7b9c', '#c39bff', '#4fd1c5', '#ff9d5c'];
function speakerColor(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SPK_COLORS[h % SPK_COLORS.length]; }
function initials(name) { const w = String(name).trim().split(/\s+/); return (((w[0] || '')[0] || '') + ((w[1] || '')[0] || '')).toUpperCase() || '•'; }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function updateTabCounts() {
  const labels = { intro: 'Intro', subs: 'Subtitles', outro: 'Outro' };
  document.querySelectorAll('.tab').forEach((t) => { const k = t.dataset.tab; t.innerHTML = `${labels[k]} <span class="badge">${state[k].length}</span>`; });
}

function renderPane(kind) {
  const pane = $('#pane-' + kind);
  pane.innerHTML = '';
  const list = state[kind];
  const isScreen = kind !== 'subs';

  const head = document.createElement('div');
  head.className = 'pane-head';
  head.textContent = isScreen
    ? `Black-screen text shown ${kind === 'intro' ? 'before' : 'after'} the video. Add as many as you like.`
    : 'Burned onto the video at each timestamp. Edit text and the preview updates live.';
  pane.appendChild(head);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = isScreen ? `No ${kind} screens yet — add one below.` : 'No subtitles in this set.';
    pane.appendChild(empty);
  }

  list.forEach((c, idx) => {
    const div = document.createElement('div');
    div.className = 'cue' + (idx === 0 ? ' first' : '');
    div.dataset.id = c.id;
    const color = isScreen ? 'var(--red)' : speakerColor(c.person || kind);
    const avatarTxt = isScreen ? String(idx + 1) : initials(c.person || kind);
    const nameTxt = isScreen ? `${cap(kind)} screen ${idx + 1}` : (c.person || 'Speaker');
    const timeLabel = isScreen ? `${c.duration ?? autoDur(c.text)}s` : `${fmt(c.start)} – ${fmt(c.end)}`;
    div.innerHTML = `
      <div class="avatar" style="--sc:${color}">${escapeHtml(avatarTxt)}</div>
      <div class="cue-body">
        <div class="cue-head">
          ${isScreen
            ? `<span class="speaker" style="--sc:${color}">${escapeHtml(nameTxt)}</span>`
            : `<select class="speaker-sel" style="--sc:${color}">${speakerOptions(nameTxt)}</select>`}
          <span class="cue-time">${!isScreen ? `<button class="jump" style="--sc:${color}" data-jump="${c.start}">▶ ${timeLabel}</button>` : `⏱ ${timeLabel}`}</span>
        </div>
        <textarea rows="2" ${isScreen ? '' : `maxlength="${c.maxLen}"`} placeholder="${isScreen ? 'Screen text…' : 'Subtitle text…'}">${escapeHtml(c.text || '')}</textarea>
        <div class="cue-foot">
          <span class="charcount"></span>
          ${c.oldText ? `<span class="old" title="original text">was: ${escapeHtml(c.oldText)}</span>` : '<span></span>'}
          ${isScreen ? `<span class="screen-ctrl"><label>dur</label><input type="number" class="dur-in" step="0.1" min="0.3" value="${c.duration ?? autoDur(c.text)}" /><button class="mini del" title="remove">✕</button></span>`
            : `<span class="time-ctrl"><label>in</label><input type="number" class="t-start" step="0.1" min="0" value="${c.start.toFixed(1)}" /><label>out</label><input type="number" class="t-end" step="0.1" min="0" value="${c.end.toFixed(1)}" /><button class="mini del" title="remove">✕</button></span>`}
        </div>
      </div>`;
    const spk = div.querySelector('.speaker-sel');
    if (spk) spk.addEventListener('change', () => {
      if (spk.value === '__new__') {
        const name = (prompt('New character name:') || '').trim();
        if (!name) { spk.value = c.person || 'Speaker'; return; }
        c.person = name;
      } else c.person = spk.value;
      renderPane('subs'); renderCharacterBoxes(); markDirty();
    });
    const ta = div.querySelector('textarea');
    const cc = div.querySelector('.charcount');
    const updCC = () => {
      const n = ta.value.length;
      if (isScreen) { cc.textContent = `${n} chars`; cc.className = 'charcount' + (n > 84 ? ' bad' : n > 42 ? ' warn' : ''); return; }
      cc.textContent = `${n} / ${c.maxLen} chars`;
      cc.className = 'charcount' + (n >= c.maxLen ? ' bad' : n > c.maxLen * 0.85 ? ' warn' : '');
      cc.title = n >= c.maxLen ? 'Limit reached — a line can grow to 1.5× its original length.' : '';
    };
    updCC();
    ta.addEventListener('input', () => { c.text = ta.value; updCC(); markDirty(); if (kind === 'subs') updateSubOverlay(); });
    const dur = div.querySelector('.dur-in');
    if (dur) dur.addEventListener('input', () => { c.duration = Math.max(0.3, parseFloat(dur.value) || 0.3); markDirty(); });
    const tStart = div.querySelector('.t-start');
    const tEnd = div.querySelector('.t-end');
    if (tStart && tEnd) {
      const commit = () => {
        let s = Math.max(0, parseFloat(tStart.value) || 0);
        let e = Math.max(s + 0.2, parseFloat(tEnd.value) || s + 0.2);
        c.start = +s.toFixed(2); c.end = +e.toFixed(2);
        tStart.value = c.start.toFixed(1); tEnd.value = c.end.toFixed(1);
        div.querySelector('[data-jump]').textContent = `▶ ${fmt(c.start)} – ${fmt(c.end)}`;
        div.querySelector('[data-jump]').dataset.jump = c.start;
        updateSubOverlay();
      };
      [tStart, tEnd].forEach((i) => i.addEventListener('change', () => {
        const before = state.subs.map((x) => x.id).join();
        commit(); resortSubs(); markDirty();
        if (state.subs.map((x) => x.id).join() !== before) renderPane('subs'); // order changed
      }));
    }
    const jump = div.querySelector('[data-jump]');
    if (jump) jump.addEventListener('click', () => { video.currentTime = parseFloat(jump.dataset.jump); video.play(); });
    const del = div.querySelector('.del');
    if (del) del.addEventListener('click', () => { state[kind] = state[kind].filter((x) => x.id !== c.id); renderPane(kind); updateTabCounts(); markDirty(); if (kind === 'subs') { renderCharacterBoxes(); updateSubOverlay(); } });
    pane.appendChild(div);
  });

  const add = document.createElement('button');
  add.className = 'addline';
  add.innerHTML = isScreen ? `＋ Add ${kind} screen` : '＋ Add subtitle';
  add.addEventListener('click', () => {
    if (isScreen) state[kind].push({ id: `${kind}-${cueSeq++}`, text: '', duration: 2.5, person: 'black screen' });
    else {
      const last = state.subs[state.subs.length - 1];
      const start = +((last ? last.end + 0.2 : (video.currentTime || 0))).toFixed(2);
      const c = { id: `sub-${cueSeq++}`, text: '', start, end: +(start + 2).toFixed(2), person: last?.person || 'Speaker' };
      c.maxLen = capFor(c);
      state.subs.push(c);
      resortSubs();
    }
    renderPane(kind); updateTabCounts(); markDirty();
    pane.querySelector('.cue:last-of-type textarea')?.focus();
  });
  pane.appendChild(add);
}

function resortSubs() { state.subs.sort((a, b) => a.start - b.start); }

// Speaker dropdown: every character already in the script, plus a way to name a new one.
function speakerOptions(current) {
  const names = [...new Set(state.subs.map((c) => (c.person || '').trim()).filter(Boolean))];
  if (current && !names.includes(current)) names.unshift(current);
  return names.map((n) => `<option${n === current ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')
    + '<option value="__new__">＋ New character…</option>';
}

// ===================== APPLY / SAVE GATE =====================
// Nothing reaches the export until the user commits it here.
function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  $('.applybar').classList.add('dirty');
  $('#applyState').textContent = 'Unsaved changes';
  $('#applyHint').textContent = 'Apply them before exporting';
  $('#applyBtn').disabled = false;
  $('#exportBtn').disabled = true;
}
function markClean(hint) {
  state.dirty = false;
  $('.applybar').classList.remove('dirty');
  $('#applyState').textContent = 'All changes applied';
  $('#applyHint').textContent = hint || 'Your edits are ready to export';
  $('#applyBtn').disabled = true;
  $('#exportBtn').disabled = !state.video;
}
$('#applyBtn').addEventListener('click', async () => {
  state.subs.forEach((c) => { c.text = (c.text || '').trim(); });
  resortSubs();
  renderPane('subs'); renderPane('intro'); renderPane('outro');
  updateTabCounts(); updateLevelUI(); renderCharacterBoxes(); updateSubOverlay();
  const chars = characters().length;
  markClean(`${state.subs.length} lines · ${chars} character${chars === 1 ? '' : 's'} · ready to export`);
  setMsg('#exportMsg', '', '');
  await maybeGenerateVoice(); // Level 2: build the voice track so the user can preview it
});

// ===================== LEVEL 2 VOICE PREVIEW =====================
// Only re-generate when something that affects the audio actually changed.
function voiceSignature() {
  // `end` is excluded on purpose: the API decides each line's real end from the
  // generated speech and we write it back, so it must not feed regeneration.
  return JSON.stringify({
    v: state.video && state.video.id, lang: 'en-US',
    subs: state.subs.map((c) => ({ p: c.person, s: c.start, t: c.text })),
    voices: Object.fromEntries(Object.entries(state.voices).map(([k, v]) => [k, v.prompt || ''])),
  });
}

// Snap subtitle timings to the spoken audio the API returned (keyed by line id) so
// the captions match the voice. Derived, not a user edit — does not mark dirty.
function applyVoiceTimeline(timeline) {
  if (!Array.isArray(timeline)) return;
  const byId = new Map(timeline.map((e) => [e.id, e]));
  let changed = false;
  state.subs.forEach((c) => {
    const e = byId.get(c.id);
    if (!e) return;
    if (Number.isFinite(+e.start_sec)) c.start = +e.start_sec;
    if (Number.isFinite(+e.end_sec)) c.end = +e.end_sec;
    changed = true;
  });
  if (changed) { resortSubs(); renderPane('subs'); updateTabCounts(); updateSubOverlay(); }
}
function clearVoiceAudio() { state.voiceUrl = null; state.voiceSig = null; voiceAudio.pause(); voiceAudio.removeAttribute('src'); video.muted = false; }
const voicePromptMap = () => Object.fromEntries(Object.entries(state.voices).map(([k, v]) => [k, v.prompt || '']));

async function maybeGenerateVoice() {
  const wantVoice = !!state.selected['2'];
  if (!wantVoice || !state.subs.length || !state.video) { clearVoiceAudio(); return; }
  const missing = characters().filter((ch) => !isGroup(ch.name) && !(state.voices[ch.id] && state.voices[ch.id].prompt.trim()));
  if (missing.length) { clearVoiceAudio(); $('#applyHint').textContent = `Add a voice for: ${missing.map((c) => c.name).join(', ')}`; return; }
  const sig = voiceSignature();
  if (sig === state.voiceSig && state.voiceUrl) { $('#applyHint').textContent = '🔊 Voiceover ready · press ▶ to preview'; return; }
  $('#applyHint').textContent = 'Generating voiceover…';
  try {
    const r = await fetch('/api/voiceover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: state.video.id, language: 'en-US', subs: state.subs, voices: voicePromptMap() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'voiceover failed');
    state.voiceUrl = j.presigned_url; state.voiceSig = sig;
    applyVoiceTimeline(j.timeline); // align captions to the spoken audio
    voiceAudio.src = j.presigned_url; voiceAudio.load(); video.muted = true;
    if (!video.paused && !previewing) { voiceAudio.currentTime = video.currentTime; voiceAudio.play().catch(() => {}); }
    $('#applyHint').textContent = `🔊 Voiceover ready · press ▶ to preview (${(+j.duration_seconds || 0).toFixed(1)}s)`;
  } catch (e) { clearVoiceAudio(); $('#applyHint').textContent = 'Voiceover failed: ' + e.message; }
}

// Lock the generated voice track to the video during normal playback / scrubbing.
video.addEventListener('play', () => { if (state.voiceUrl && !previewing) { voiceAudio.currentTime = video.currentTime; voiceAudio.play().catch(() => {}); } });
video.addEventListener('pause', () => { voiceAudio.pause(); });
video.addEventListener('seeking', () => { if (state.voiceUrl) voiceAudio.currentTime = video.currentTime; });
video.addEventListener('timeupdate', () => { if (state.voiceUrl && !voiceAudio.paused && Math.abs(voiceAudio.currentTime - video.currentTime) > 0.3) voiceAudio.currentTime = video.currentTime; });

// ===================== FULL PREVIEW =====================
let previewTimer = null, previewing = false, suppressIntro = false;
const stopBtn = $('#stopPreview');
const clearTimer = () => { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } };
function playScreens(list, i, done) {
  if (!previewing) return;
  if (i >= list.length) return done();
  const sc = list[i];
  blackOverlay.hidden = false; blackText.textContent = sc.text || '';
  previewTimer = setTimeout(() => playScreens(list, i + 1, done), (Number(sc.duration) || autoDur(sc.text)) * 1000);
}
function runIntroThenVideo() {
  clearTimer(); previewing = true; video.pause(); stopBtn.hidden = false;
  playScreens(state.intro, 0, () => { previewing = false; blackOverlay.hidden = true; suppressIntro = true; video.currentTime = 0; video.play(); });
}
function runOutro() { clearTimer(); previewing = true; stopBtn.hidden = false; playScreens(state.outro, 0, () => { previewing = false; blackOverlay.hidden = true; stopBtn.hidden = true; }); }
function stopPreview() { previewing = false; suppressIntro = false; clearTimer(); blackOverlay.hidden = true; stopBtn.hidden = true; video.pause(); voiceAudio.pause(); }
$('#playFull').addEventListener('click', () => { stopPreview(); video.currentTime = 0; suppressIntro = false; runIntroThenVideo(); });
stopBtn.addEventListener('click', stopPreview);
video.addEventListener('play', () => {
  if (previewing) return;
  if (suppressIntro) { suppressIntro = false; return; }
  if (video.currentTime <= 0.3 && state.intro.length) runIntroThenVideo();
});
video.addEventListener('ended', () => { voiceAudio.pause(); if (!previewing && state.outro.length) runOutro(); });

// ===================== EXPORT =====================
function setProgress(pct, stage) { $('#progressBar').style.width = pct + '%'; $('#progressPct').textContent = pct + '%'; if (stage) $('#progressStage').textContent = stage; }
$('#exportBtn').addEventListener('click', async () => {
  if (!state.video) { setMsg('#exportMsg', 'No base video selected.', 'err'); return; }
  if (state.dirty) {
    setMsg('#exportMsg', 'You have unsaved changes — click “Apply and save changes” first.', 'err');
    $('.applybar').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const wantVoice = !!state.selected['2'];
  const wantFace = !!state.selected['3'];
  if (state.level === 1 && !state.subs.length) { setMsg('#exportMsg', 'Level 1 needs a subtitle set — pick one or switch to Level 0.', 'err'); return; }
  if (wantVoice && !state.subs.length) { setMsg('#exportMsg', 'Voiceover (Level 2) needs subtitle lines to speak — none found.', 'err'); return; }
  if (wantVoice) {
    const missing = characters().filter((ch) => !isGroup(ch.name) && !(state.voices[ch.id] && state.voices[ch.id].prompt.trim()));
    if (missing.length) { setMsg('#exportMsg', `Add a voice description for: ${missing.map((c) => c.name).join(', ')}`, 'err'); return; }
  }
  $('#exportBtn').disabled = true;
  setMsg('#exportMsg', '', '');
  $('#progressWrap').hidden = false;
  setProgress(0, 'Starting…');
  try {
    const qual = { fast: { preset: 'ultrafast', crf: 26 }, balanced: { preset: 'veryfast', crf: 23 }, high: { preset: 'medium', crf: 20 } }[$('#qualitySel').value];
    const maxHeight = parseInt($('#resSel').value, 10);
    const r = await fetch('/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: state.video.id, level: state.level,
        intro: state.intro, subs: state.subs, outro: state.outro,
        subStyle: state.subStyle, ...qual, maxHeight,
        voiceover: wantVoice, faceswap: wantFace, language: 'en-US',
        voices: voicePromptMap(), voiceUrl: wantVoice ? state.voiceUrl : null,
      }),
    });
    const first = await r.json();
    if (!r.ok) throw new Error(first.error || 'export failed');
    const { jobId } = first;
    await new Promise((resolve, reject) => {
      const es = new EventSource(`/progress/${jobId}`);
      es.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.error) { es.close(); reject(new Error(d.error)); return; }
        setProgress(d.percent, d.stage);
        if (d.done) { es.close(); resolve(); }
      };
      es.onerror = () => { es.close(); reject(new Error('lost connection to server')); };
    });
    setProgress(100, 'Downloading…');
    const blob = await (await fetch(`/result/${jobId}`)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.mp4'; a.click();
    URL.revokeObjectURL(url);
    setMsg('#exportMsg', 'Done! Downloaded export.mp4', 'ok');
    setTimeout(() => { $('#progressWrap').hidden = true; }, 1500);
  } catch (e) {
    setMsg('#exportMsg', e.message, 'err');
    $('#progressWrap').hidden = true;
  } finally {
    $('#exportBtn').disabled = false;
  }
});

boot();
