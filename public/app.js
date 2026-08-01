const $ = (s) => document.querySelector(s);
const state = { selected: {}, video: null, templateName: null, templateType: '', placeholders: [], rawSubs: [], intro: [], subs: [], outro: [], level: 0, introOutro: false, tplIntro: [], tplOutro: [],
  subStyle: { font: 'dejavu', sizePct: 5.5, color: '#ffffff', bg: 'box', bgColor: '#000000' },
  voices: {}, faces: {}, l3Trim: { on: false, seconds: 27 }, resultUrl: null, resultSubs: null, showingResult: false };
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
// Force a real download (the S3 presigned URL is cross-origin, so <a download> just opens
// it) — route through the same-origin /download proxy that sets attachment disposition.
const downloadHref = (url, name) => `/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name || 'video.mp4')}`;
// A thumbnail that fails to load (still generating, or generation failed) falls back to
// the placeholder icon instead of a broken-image glyph. img error doesn't bubble → capture.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.classList.contains('thumb')) {
    const ph = document.createElement('div'); ph.className = 'thumb placeholder'; ph.textContent = '🎬';
    t.replaceWith(ph);
  }
}, true);

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
  if (el && el.dataset.loading) return; // ignore repeat clicks while transcribing
  if (el) { el.dataset.loading = '1'; el.classList.add('loading-card'); }
  try {
    const r = await fetch(`/api/subtitle-templates/${encodeURIComponent(t.id)}?type=${encodeURIComponent(t.type ?? '')}`);
    const cues = await r.json();
    if (!r.ok) throw new Error(cues.error || 'load failed');
    applyCues({ ...cues, id: t.id }, cues.name || t.name, el);
  } catch (e) { alert('Failed to load template: ' + (e.message || e)); }
  finally { if (el) { delete el.dataset.loading; el.classList.remove('loading-card'); } }
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
  state.video = primary.videoId ? { id: primary.videoId, url: primary.videoUrl, preview: primary.previewUrl || null, s3: primary.videoS3, name: primary.name } : null;
  state.introOutro = (state.tplIntro.length || state.tplOutro.length) > 0;
  $('#selbar').hidden = false;
  deriveLevel();
  updateSelbar();
}

// Upload lives in the top bar (next to "My Renders")
$('#navUpload').addEventListener('click', () => $('#xlsxInput').click());

// Opt-in: save the last uploaded xlsx to S3 (templates/ prefix). Appears only after
// an upload; does nothing automatically.
$('#navSaveTpl').addEventListener('click', async () => {
  const p = state.pendingXlsx;
  if (!p || !p.file) { alert('Upload an xlsx first, then save it.'); return; }
  const btn = $('#navSaveTpl'); const prev = btn.textContent; btn.textContent = '☁ Saving…';
  try {
    const fd = new FormData(); fd.append('xlsx', p.file); fd.append('name', p.label || '');
    const r = await fetch('/api/templates/save', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'save failed');
    btn.textContent = '☁ Saved ✓'; btn.classList.add('saved');
    console.log('[templates] saved to library', j.file, j.ids, j.url || '(no cloud copy)');
    await boot(); // refresh the library rows so the new template card appears
    alert(`Saved to your library as “${(j.names && j.names[0]) || p.label}”. It now appears in the library${j.url ? ' and is backed up to the cloud' : ''}.`);
  } catch (e) { btn.textContent = prev; alert('Save failed: ' + e.message); }
});

$('#xlsxInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('xlsx', file);
  try {
    const r = await fetch('/api/subtitles', { method: 'POST', body: fd });
    const cues = await r.json();
    if (!r.ok) throw new Error(cues.error || 'parse failed');
    const label = cues.name ? String(cues.name).replace(/\b\w/g, (c) => c.toUpperCase()) : file.name.replace(/\.xlsx$/i, '');
    // Remember the raw file so the user can opt to save it to S3 (never automatic).
    state.pendingXlsx = { file, label };
    const stBtn = $('#navSaveTpl'); if (stBtn) { stBtn.hidden = false; stBtn.textContent = '☁ Save to library'; stBtn.classList.remove('saved'); }
    // In the studio, apply the uploaded sheet's subtitles to the current editor
    // straight away (keeping the current video); on the dashboard, add it as a card.
    if (document.body.classList.contains('studio-open')) { applyXlsxInStudio(cues, label); e.target.value = ''; return; }
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

// Apply an uploaded xlsx's subtitles (and any intro/outro screens) to the open
// studio editor, keeping the current source video. Nothing reaches export until the
// user clicks "Apply & save", so this just loads the lines for review.
function applyXlsxInStudio(cues, label) {
  state.rawSubs = cues.subs || [];
  state.subs = withLimits(mapCues(state.rawSubs, 'sub'));
  if ((cues.intro && cues.intro.length) || (cues.outro && cues.outro.length)) {
    state.tplIntro = cues.intro || []; state.tplOutro = cues.outro || [];
    state.intro = mapCues(state.tplIntro, 'intro'); state.outro = mapCues(state.tplOutro, 'outro');
    state.introOutro = (state.tplIntro.length || state.tplOutro.length) > 0;
  }
  state.placeholders = [...new Set([...(state.placeholders || []), ...(cues.placeholders || [])])];
  deriveLevel();
  autoTrimFromSubs(); // re-default the trim to the new subtitles' end
  $('#substyleBox').style.display = state.video && state.level >= 1 ? '' : 'none';
  renderPane('intro'); renderPane('subs'); renderPane('outro');
  updateTabCounts(); updateLevelUI(); renderCharacterBoxes(); updateSubOverlay();
  switchTab(state.subs.length ? 'subs' : 'intro');
  markDirty();
  maybeGenerateVoice();
  alert(`Loaded ${state.subs.length} subtitle line(s) from “${label}”. Review them, then click “Apply & save” to commit.`);
}

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
  // Restore a render for this video so a reload/reopen never loses the generated video —
  // it stays available via the preview toggle. A pinned render (opened from My Renders)
  // takes precedence and is shown by default; otherwise default to the original.
  const latestRender = state.pinnedRender || (state.video ? rendersForVideo(state.video.id)[0] : null);
  state.resultUrl = latestRender ? latestRender.url : null;
  state.resultSubs = latestRender ? latestRender.subs : null;
  state.showingResult = false;
  $('#previewToggle').hidden = !state.resultUrl;
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
  if (hasVideo) {
    // Reset any stale inline sizing from a previously-opened video, then force a
    // reload so loadedmetadata always re-fires and re-sizes the stage.
    const stage = document.querySelector('.stage');
    stage.style.aspectRatio = '16 / 9'; stage.style.height = ''; stage.style.width = '';
    video.src = state.video.preview || state.video.url; // stripped preview if the source audio is broken
    video.load();
    blackOverlay.hidden = true;
  } else { video.removeAttribute('src'); }
  $('#chosenVideo').textContent = state.templateName || (state.video && state.video.name) || '—';
  deriveLevel();
  // Snapshot the original video lines as the length baseline for this session.
  captureBaseline();
  // Default the Level 3 trim to the end of the chosen subtitles (rounded up) — but keep a
  // reopened render's own trim value as-is.
  if (!state.pinnedRender) autoTrimFromSubs();
  // Fresh Level 3 panel each time the studio opens — only an in-progress job re-attaches.
  setMsg('#level3Msg', '', ''); $('#level3Progress').hidden = true; $('#l3Result').hidden = true; $('#l3Dismiss').hidden = true; $('#level3Btn').disabled = false;
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
  // Opened from My Renders → show the generated video straight away.
  if (state.pinnedRender && state.resultUrl) setPreviewSource('result');
  state.pinnedRender = null; // one-shot: normal reopens default to the original
  updateExportSource();
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

// Rename a character everywhere: rewrites the speaker label on all of its subtitle
// lines (the single source of truth) and migrates any voice/face data to the new id.
function renameCharacter(ch, rawName) {
  const newName = (rawName || '').trim();
  if (!newName || newName === ch.name) return false;
  const newId = slug(newName);
  state.subs.forEach((c) => { if (slug((c.person || '').trim()) === ch.id) c.person = newName; });
  if (newId !== ch.id) {
    if (state.voices[ch.id]) { state.voices[newId] = { ...state.voices[ch.id] }; if (newId !== ch.id) delete state.voices[ch.id]; }
    if (state.faces[ch.id]) { state.faces[newId] = { ...state.faces[ch.id] }; delete state.faces[ch.id]; }
  }
  if (state.voices[newId]) state.voices[newId].name = newName;
  if (state.faces[newId]) state.faces[newId].name = newName;
  renderPane('subs'); updateTabCounts(); renderCharacterBoxes(); updateSubOverlay(); markDirty();
  return true;
}

// When trimming to the first N seconds, only the characters who speak in that window
// need faces — everyone else is off-clip.
function charFirstStart(id) {
  let min = Infinity;
  for (const c of state.subs) if (slug((c.person || '').trim()) === id && +c.start < min) min = +c.start;
  return min;
}
function activeCharacters() {
  const all = characters();
  if (!state.l3Trim.on) return all;
  return all.filter((ch) => charFirstStart(ch.id) < state.l3Trim.seconds);
}

// When a subtitle set + a Level 3 video are chosen, default the trim to the end of the
// subtitles: round the last line's end up to a whole second and turn trim on. Keeps the
// face-swap clip only as long as the dialogue (e.g. last line ends 14.4s → trim 15s).
function autoTrimFromSubs() {
  if (!state.selected['3'] || !state.subs.length) return;
  const lastEnd = Math.max(...state.subs.map((c) => +c.end || 0));
  if (!isFinite(lastEnd) || lastEnd <= 0) return;
  state.l3Trim.on = true;
  state.l3Trim.seconds = Math.ceil(lastEnd);
  const cb = $('#l3Trim'); if (cb) cb.checked = true;
  const ns = $('#l3TrimSecs'); if (ns) ns.value = state.l3Trim.seconds;
}

// ===================== LIP-SYNC LENGTH GUARD (Level 3) =====================
// For face-swap/lip-sync, each new subtitle must be close in length to the ORIGINAL
// video line at the same slot (position). We snapshot the original lines when the
// studio opens, then hold every replacement line to ±10% of the original at its index.
const LEN_TOL = 0.10;
function captureBaseline() {
  state.baseline = (state.subs || []).slice().sort((a, b) => a.start - b.start)
    .map((c) => ({ len: (c.text || '').trim().length }));
}
// Allowed [min,max] length for the sub at slot `index`, or null if no original there.
function lenBounds(index) {
  const b = state.baseline && state.baseline[index];
  if (!b || !b.len) return null;
  return { base: b.len, min: Math.round(b.len * (1 - LEN_TOL)), max: Math.round(b.len * (1 + LEN_TOL)) };
}
// Subs (in the visible/trim window) whose length falls outside their slot's ±10% band.
function lengthViolations() {
  const out = [];
  visibleSubs().forEach((c, i) => {
    const b = lenBounds(i); if (!b) return;
    const n = (c.text || '').trim().length;
    if (n < b.min || n > b.max) out.push({ text: c.text || '', len: n, min: b.min, max: b.max });
  });
  return out;
}

function renderCharacterBoxes() {
  const chars = characters();
  const wantVoice = !!state.selected['2'], wantFace = !!state.selected['3'];
  $('#voiceBox').hidden = !(wantVoice && chars.length);
  $('#faceBox').hidden = !(wantFace && chars.length);
  if (wantVoice) renderVoiceChars(chars);
  if (wantFace) { renderFaceChars(activeCharacters()); resumeL3(); }
}

// A group speaker ("Both, in unison") is voiced by the individual voices together —
// it needs no prompt of its own. Mirrors the server's isGroupSpeaker.
const GROUP_RE = /\b(unison|everyone|all|both|together|group|crowd)\b/i;
const isGroup = (name) => GROUP_RE.test(String(name || ''));

// Attach the editable-name behaviour to a character row's `.charname-edit` input.
// Commits on blur/Enter; `after` runs an extra refresh (e.g. the form's face list).
function wireRename(row, ch, after) {
  const inp = row.querySelector('.charname-edit');
  if (!inp) return;
  const commit = () => { const changed = renameCharacter(ch, inp.value); if (changed && after) after(); if (!changed) inp.value = ch.name; };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
}

function renderVoiceChars(chars) {
  const box = $('#voiceChars'); box.innerHTML = '';
  chars.forEach((ch) => {
    if (isGroup(ch.name)) {
      const row = document.createElement('div');
      row.className = 'charrow group';
      row.innerHTML = `
        <div class="avatar sm" style="--sc:${speakerColor(ch.name)}">${escapeHtml(initials(ch.name))}</div>
        <div class="charbody">
          <input class="charname-edit" value="${escapeHtml(ch.name)}" title="Rename this character" />
          <div class="group-note">🎙 Spoken by the individual voices together — no separate description needed.</div>
        </div>`;
      wireRename(row, ch);
      box.appendChild(row);
      return;
    }
    state.voices[ch.id] ??= { name: ch.name, prompt: '' };
    const row = document.createElement('div');
    row.className = 'charrow';
    row.innerHTML = `
      <div class="avatar sm" style="--sc:${speakerColor(ch.name)}">${escapeHtml(initials(ch.name))}</div>
      <div class="charbody">
        <input class="charname-edit" value="${escapeHtml(ch.name)}" title="Rename this character" />
        <textarea rows="2" placeholder="Describe this voice — age, accent, tone, energy…">${escapeHtml(state.voices[ch.id].prompt)}</textarea>
      </div>`;
    row.querySelector('textarea').addEventListener('input', (e) => { state.voices[ch.id].prompt = e.target.value; markDirty(); });
    wireRename(row, ch);
    box.appendChild(row);
  });
}

function renderFaceChars(chars, sel = '#faceChars') {
  const box = $(sel); box.innerHTML = '';
  chars.forEach((ch) => {
    state.faces[ch.id] ??= { name: ch.name, dataUrl: null, fileName: null, url: '' };
    const f = state.faces[ch.id];
    const thumb = f.dataUrl || f.url;
    const row = document.createElement('div');
    row.className = 'charrow face';
    row.innerHTML = `
      <div class="facepic${thumb ? ' has' : ''}" style="--sc:${speakerColor(ch.name)}">${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : escapeHtml(initials(ch.name))}</div>
      <div class="charbody">
        <input class="charname-edit" value="${escapeHtml(ch.name)}" title="Rename this character" />
        <div class="facectrl">
          <button class="mini pick">${f.dataUrl ? 'Replace image' : '⬆ Upload face'}</button>
          <span class="facename${f.uploaded ? ' ok' : ''}">${f.uploaded ? '✓ uploaded to S3' : (f.fileName ? escapeHtml(f.fileName) : 'JPG or PNG · clear, front-facing')}</span>
          ${f.dataUrl ? '<button class="mini del">✕</button>' : ''}
        </div>
        <input class="tin face-url" type="url" placeholder="…or paste a public image URL" value="${escapeHtml(f.uploaded ? '' : (f.url || ''))}" />
        <input type="file" accept="image/*" hidden />
      </div>`;
    const input = row.querySelector('input[type=file]');
    row.querySelector('.pick').addEventListener('click', () => input.click());
    row.querySelector('.del')?.addEventListener('click', () => { state.faces[ch.id] = { name: ch.name, dataUrl: null, fileName: null, url: '' }; renderFaceChars(chars, sel); markDirty(); });
    input.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = async () => {
        state.faces[ch.id] = { name: ch.name, dataUrl: rd.result, fileName: file.name, url: '' };
        renderFaceChars(chars, sel); markDirty();
        // Upload to S3 (if configured) so the face is reachable by the face-swap API.
        try {
          const j = await (await fetch('/api/upload-face', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ch.id, dataUrl: rd.result }) })).json();
          if (j.url) { state.faces[ch.id].url = j.url; state.faces[ch.id].uploaded = true; renderFaceChars(chars, sel); }
        } catch { /* fall back to local hosting / paste-URL */ }
      };
      rd.readAsDataURL(file);
    });
    row.querySelector('.face-url').addEventListener('input', (e) => { state.faces[ch.id].url = e.target.value.trim(); state.faces[ch.id].name = ch.name; markDirty(); });
    wireRename(row, ch, () => { if (sel === '#formFaces') renderFaceChars(characters(), '#formFaces'); });
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
// If the media fails to load (e.g. a corrupt audio track), keep the layout intact
// and tell the user instead of leaving a blank/collapsed preview.
video.addEventListener('error', () => {
  if (!state.video) return;
  const stage = document.querySelector('.stage');
  stage.style.aspectRatio = '16 / 9'; stage.style.height = ''; stage.style.width = '';
  blackOverlay.hidden = false; blackText.textContent = 'This video could not be loaded in the browser (its media may be malformed). The export still runs server-side.';
});
// Switch the preview between the original source and the generated (Level 3) result.
function setPreviewSource(which) {
  const showResult = which === 'result' && !!state.resultUrl;
  state.showingResult = showResult;
  const src = showResult ? state.resultUrl : (state.video && (state.video.preview || state.video.url));
  if (!src) return;
  stopPreview(); voiceAudio.pause();
  const stage = document.querySelector('.stage');
  stage.style.aspectRatio = '16 / 9'; stage.style.height = ''; stage.style.width = '';
  video.src = src; video.load(); video.muted = false;
  $('#previewToggle').textContent = showResult ? '▶ Showing: new video · tap for original' : '▶ Showing: original · tap for new video';
  updateSubOverlay();
  updateExportSource();
}
$('#previewToggle').addEventListener('click', () => setPreviewSource(state.showingResult ? 'original' : 'result'));

// Tell the user which video Burn & Export will act on (matches the preview toggle).
function updateExportSource() {
  const el = $('#exportSource'); if (!el) return;
  if (state.showingResult && state.resultUrl) el.textContent = '⬇ Export will burn your captions onto the generated face-swap video (currently shown).';
  else if (state.resultUrl) el.textContent = 'Export will use the original video. Tap the toggle above the preview to burn onto the generated video instead.';
  else el.textContent = '';
}

video.addEventListener('timeupdate', updateSubOverlay);
function updateSubOverlay() {
  if (state.showingResult) {
    // The generated result has NO burned-in captions (we send subs:false), so overlay
    // the subtitles used for it — falling back to the current editor subs when the render
    // stored none ([] is truthy, so check length, not just existence).
    const list = (state.resultSubs && state.resultSubs.length) ? state.resultSubs : state.subs;
    const t = video.currentTime;
    let active = null;
    for (const c of list) { if (t >= c.start && t <= c.end) { active = c; break; } }
    subOverlay.innerHTML = active && active.text ? `<span>${escapeHtml(active.text)}</span>` : '';
    return;
  }
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

// ===================== MY RENDERS (generated videos) =====================
// Generated Level 3 videos are kept in localStorage while their download link is valid
// (the presigned URL lasts ~7 days). Each entry stores the video URL plus the subtitles
// and style used, so we can re-show it — with captions overlaid — after a reload.
const RENDERS_KEY = 'sb.renders';
const RENDER_TTL = 7 * 24 * 3600 * 1000; // matches the presigned link validity
function loadRenders() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RENDERS_KEY) || '[]'); } catch { list = []; }
  const now = Date.now();
  const live = list.filter((r) => r && r.url && (!r.expiresAt || r.expiresAt > now)); // drop expired
  if (live.length !== list.length) localStorage.setItem(RENDERS_KEY, JSON.stringify(live));
  return live;
}
function saveRender(entry) {
  const list = loadRenders();
  const existing = list.find((r) => r.url === entry.url);
  // Re-saving the same render (e.g. on reload) must not reset its created/expiry time.
  if (existing) { entry.createdAt = existing.createdAt; entry.expiresAt = existing.expiresAt; entry.subs = entry.subs && entry.subs.length ? entry.subs : existing.subs; }
  const rest = list.filter((r) => r.url !== entry.url);
  rest.unshift(entry);
  localStorage.setItem(RENDERS_KEY, JSON.stringify(rest.slice(0, 50)));
}
function removeRender(url) { localStorage.setItem(RENDERS_KEY, JSON.stringify(loadRenders().filter((r) => r.url !== url))); }
function rendersForVideo(id) { return loadRenders().filter((r) => r.videoId === id); }
// Record a finished job as a render. createdAt/expiresAt are set once (not on reload).
function recordRender(saved, s) {
  if (!saved || !s || !s.video_url) return;
  const now = Date.now();
  saveRender({ id: saved.jobId, videoId: saved.videoId, videoName: saved.videoName || saved.videoId,
    videoUrl: saved.videoUrl || null, videoPreview: saved.videoPreview || null,
    url: s.video_url, createdAt: now, expiresAt: now + RENDER_TTL, cost: s.cost_usd, elapsed: s.elapsed_seconds,
    subs: saved.subs || [], subStyle: saved.subStyle || null, trim: saved.trim || 0, faces: saved.faces || {} });
}

// Apply a saved subtitle style to any overlay element (mirrors applySubStyle).
function styleOverlay(o, st) {
  st = st || state.subStyle;
  o.style.setProperty('--sub-font', FONT_CSS[st.font] || FONT_CSS.dejavu);
  o.style.setProperty('--sub-weight', FONT_WEIGHT[st.font] || 700);
  o.style.setProperty('--sub-color', st.color || '#ffffff');
  o.style.setProperty('--sub-factor', st.sizePct || 5.5);
  let bg = 'transparent';
  if (st.bg === 'solid') bg = st.bgColor || '#000000';
  else if (st.bg !== 'none') bg = hexToRgba(st.bgColor || '#000000', 0.5);
  o.style.setProperty('--sub-bg', bg);
  o.classList.remove('bg-box', 'bg-solid', 'bg-none');
  o.classList.add('bg-' + (st.bg || 'box'));
}

const agoStr = (ts) => { const s = Math.round((Date.now() - ts) / 1000); if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
const expiryStr = (ts) => { const d = Math.max(0, ts - Date.now()); const days = Math.floor(d / 86400000); const hrs = Math.floor((d % 86400000) / 3600000); return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`; };

function renderCardEl(r) {
  const el = document.createElement('div');
  el.className = 'render-item';
  el.innerHTML = `
    <div class="render-stage">
      <video src="${escapeHtml(r.url)}" playsinline controls preload="metadata"></video>
      <div class="render-ov sub-overlay"></div>
    </div>
    <div class="render-info">
      <div class="render-title">${escapeHtml(r.videoName || r.videoId)}</div>
      <div class="render-meta">Generated ${agoStr(r.createdAt)}${r.cost != null ? ` · $${r.cost}` : ''}${r.trim ? ` · first ${r.trim}s` : ''} · link expires in ${expiryStr(r.expiresAt)}</div>
      <div class="render-actions">
        <button class="mini open">▶ Open in studio</button>
        <a class="mini" href="${escapeHtml(downloadHref(r.url, (r.videoName || 'render') + '.mp4'))}">⬇ Download</a>
        <button class="mini del">✕ Remove</button>
      </div>
    </div>`;
  el.querySelector('.open').addEventListener('click', () => openRenderInStudio(r));
  const v = el.querySelector('video');
  const ov = el.querySelector('.render-ov');
  styleOverlay(ov, r.subStyle);
  // Match the frame to the real video shape so captions sit at the video's bottom.
  v.addEventListener('loadedmetadata', () => { if (v.videoWidth && v.videoHeight) el.querySelector('.render-stage').style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`; });
  const subs = r.subs || [];
  v.addEventListener('timeupdate', () => {
    const t = v.currentTime; let a = null;
    for (const c of subs) { if (t >= c.start && t <= c.end) { a = c; break; } }
    ov.innerHTML = a && a.text ? `<span>${escapeHtml(a.text)}</span>` : '';
  });
  el.querySelector('.del').addEventListener('click', () => { removeRender(r.url); el.remove(); if (!loadRenders().length) openRenders(); });
  return el;
}

// Reopen a saved render in the studio with everything reconstructed: source video,
// subtitles, style, trim, faces — and the generated video shown in the preview.
async function openRenderInStudio(r) {
  let video = r.videoUrl ? { id: r.videoId, url: r.videoUrl, preview: r.videoPreview || null, name: r.videoName || r.videoId } : null;
  if (!video) {
    try { const vids = await (await fetch('/api/videos')).json(); const v = vids.find((x) => x.id === r.videoId); if (v) video = { id: v.id, url: v.url, preview: null, s3: v.s3Uri, name: v.name || r.videoId }; } catch { /* ignore */ }
  }
  if (!video) video = { id: r.videoId, url: null, preview: null, name: r.videoName || r.videoId };
  state.video = video;
  state.selected = { '1': { type: '1', name: video.name }, '3': { type: '3', name: video.name } };
  state.templateName = video.name; state.templateType = '3'; state.placeholders = [];
  state.rawSubs = r.subs || [];
  state.subs = withLimits(mapCues(r.subs || [], 'sub'));
  state.intro = []; state.outro = []; state.tplIntro = []; state.tplOutro = []; state.introOutro = false;
  if (r.subStyle) state.subStyle = { font: 'dejavu', sizePct: 5.5, color: '#ffffff', bg: 'box', bgColor: '#000000', ...r.subStyle };
  state.faces = {};
  Object.entries(r.faces || {}).forEach(([k, f]) => { state.faces[k] = { name: f.name, url: f.url || '', dataUrl: null, fileName: null, uploaded: !!f.url }; });
  state.l3Trim = { on: !!r.trim, seconds: r.trim || 27 };
  state.pinnedRender = r; // openStudio pins this exact result and shows it
  deriveLevel();
  $('#rendersView').hidden = true;
  openStudio();
}

function openRenders() {
  const list = loadRenders();
  const box = $('#rendersList'); box.innerHTML = '';
  if (!list.length) box.innerHTML = '<div class="empty">No renders yet. Generate a Level 3 face-swap video and it will appear here while its download link is valid (~7 days).</div>';
  else list.forEach((r) => box.appendChild(renderCardEl(r)));
  $('#browseView').hidden = true; $('#formView').hidden = true; $('#studio').hidden = true; $('#selbar').hidden = true;
  $('#rendersView').hidden = false;
  document.body.classList.remove('studio-open');
  window.scrollTo({ top: 0 });
}
$('#navRenders').addEventListener('click', openRenders);
$('#navHome').addEventListener('click', () => { $('#rendersView').hidden = true; $('#formView').hidden = true; $('#studio').hidden = true; document.body.classList.remove('studio-open'); $('#browseView').hidden = false; $('#selbar').hidden = !Object.keys(state.selected).length; window.scrollTo({ top: 0 }); });
$('#rendersBack').addEventListener('click', () => { $('#rendersView').hidden = true; $('#browseView').hidden = false; $('#selbar').hidden = !Object.keys(state.selected).length; });

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
// Subtitles shown/edited in the timeline. When trimming, only the in-window lines.
function visibleSubs() { return state.l3Trim.on ? state.subs.filter((c) => c.start < state.l3Trim.seconds) : state.subs; }
function updateTabCounts() {
  const labels = { intro: 'Intro', subs: 'Subtitles', outro: 'Outro' };
  const count = { intro: state.intro.length, subs: visibleSubs().length, outro: state.outro.length };
  document.querySelectorAll('.tab').forEach((t) => { const k = t.dataset.tab; t.innerHTML = `${labels[k]} <span class="badge">${count[k]}</span>`; });
}

function renderPane(kind) {
  const pane = $('#pane-' + kind);
  pane.innerHTML = '';
  const list = kind === 'subs' ? visibleSubs() : state[kind];
  const isScreen = kind !== 'subs';
  const trimmed = kind === 'subs' && state.l3Trim.on;

  const head = document.createElement('div');
  head.className = 'pane-head';
  head.textContent = isScreen
    ? `Black-screen text shown ${kind === 'intro' ? 'before' : 'after'} the video. Add as many as you like.`
    : trimmed
    ? `Showing the ${list.length} line(s) within the first ${state.l3Trim.seconds}s (of ${state.subs.length}). Lines after ${state.l3Trim.seconds}s are excluded from this clip.`
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
    // Hold every subtitle to ±10% of the original line's length at this slot.
    const bounds = isScreen ? null : lenBounds(idx);
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
        <textarea rows="2" ${isScreen ? '' : `maxlength="${bounds ? bounds.max : c.maxLen}"`} placeholder="${isScreen ? 'Screen text…' : 'Subtitle text…'}">${escapeHtml(c.text || '')}</textarea>
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
      if (bounds) {
        cc.textContent = `${n} / ${bounds.min}–${bounds.max} (orig ${bounds.base})`;
        const bad = n < bounds.min || n > bounds.max;
        cc.className = 'charcount' + (bad ? ' bad' : (n === bounds.min || n === bounds.max) ? ' warn' : '');
        cc.title = bad ? `Lip-sync: keep within ±10% of the original line here (${bounds.min}–${bounds.max} chars).` : '';
        return;
      }
      cc.textContent = `${n} / ${c.maxLen} chars`;
      cc.className = 'charcount' + (n >= c.maxLen ? ' bad' : n > c.maxLen * 0.85 ? ' warn' : '');
      cc.title = n >= c.maxLen ? 'Limit reached — a line can grow to 1.5× its original length.' : '';
    };
    updCC();
    // Floor to match the maxlength ceiling: block deletions that would drop the line
    // below its slot's ±10% minimum (select-all then retype is still available).
    if (bounds) ta.addEventListener('beforeinput', (e) => {
      if (!/^delete/.test(e.inputType || '')) return;
      const sel = Math.max(1, ta.selectionEnd - ta.selectionStart);
      if (ta.value.length - sel < bounds.min) e.preventDefault();
    });
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
  // The ±10% length rule applies throughout — can't apply/export while any line breaks it.
  const bad = lengthViolations();
  if (bad.length) {
    const eg = bad.slice(0, 3).map((v) => `"${v.text.slice(0, 24)}" ${v.len}→need ${v.min}-${v.max}`).join('; ');
    switchTab('subs');
    setMsg('#exportMsg', `${bad.length} subtitle(s) outside ±10% of the original length: ${eg}${bad.length > 3 ? '…' : ''}. Fix them to apply.`, 'err');
    return; // stays dirty — not applied
  }
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
  // Burn & Export only burns subtitles — face swap is the separate "Generate" flow.
  // If the generated result is the one being previewed, burn the captions onto it.
  const useResult = state.showingResult && !!state.resultUrl;
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
        sourceUrl: useResult ? state.resultUrl : undefined,
        intro: state.intro, subs: state.subs, outro: state.outro,
        subStyle: state.subStyle, ...qual, maxHeight,
        voiceover: wantVoice, language: 'en-US',
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

// ===================== LEVEL 3: FACE SWAP + DUB (Cobra async job) =====================
const L3_PREP = ['preparing', 'trimming', 'uploading-faces', 'submitting']; // our server-side prep
const L3_STAGES = ['payload', 'download', 'annotate', 'track', 'preflight', 'swap+dub', 'lipsync', 'glasses', 'assemble', 'upload']; // Cobra
const L3_ALL = [...L3_PREP, ...L3_STAGES];
const L3_STORE = 'level3.job';
let l3Timer = null;

function facesPayload() {
  const out = {};
  activeCharacters().forEach((ch) => {
    const f = state.faces[ch.id];
    if (f && (f.dataUrl || f.url)) out[ch.id] = { name: ch.name, dataUrl: f.dataUrl || undefined, url: f.url || undefined, target_ref: 'auto' };
  });
  return out;
}

// Trim controls
$('#l3Trim').addEventListener('change', (e) => { state.l3Trim.on = e.target.checked; renderPane('subs'); updateTabCounts(); renderCharacterBoxes(); });
$('#l3TrimSecs').addEventListener('input', (e) => { state.l3Trim.seconds = Math.max(1, parseInt(e.target.value, 10) || 27); if (state.l3Trim.on) { renderPane('subs'); updateTabCounts(); renderCharacterBoxes(); } });

function l3SetStage(stage) {
  const i = Math.max(0, L3_ALL.indexOf(stage));
  $('#l3Bar').style.width = Math.round(((i + 1) / L3_ALL.length) * 100) + '%';
  $('#l3Stage').textContent = stage ? `Stage: ${stage}` : 'Working…';
}
function l3Elapsed(since) { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}m ${s % 60}s`; }

function stopL3Poll() { if (l3Timer) { clearTimeout(l3Timer); l3Timer = null; } }
function clearL3() { stopL3Poll(); localStorage.removeItem(L3_STORE); $('#level3Progress').hidden = true; $('#l3Result').hidden = true; $('#l3Dismiss').hidden = true; $('#level3Btn').disabled = false; $('#l3Banner').hidden = true; }
// The banner shows the job from anywhere (dashboard, after a reload), so it's never lost.
function updateL3Banner(text, link) {
  $('#l3Banner').hidden = false;
  $('#l3BannerStage').textContent = text;
  const a = $('#l3BannerLink');
  if (link) { a.href = link; a.hidden = false; } else { a.hidden = true; }
}
$('#l3BannerX').addEventListener('click', clearL3);

// Self-scheduling poll: fast (5s) during our server-side prep, 60s once Cobra is running.
async function l3Poll() {
  const saved = JSON.parse(localStorage.getItem(L3_STORE) || 'null');
  if (!saved) { stopL3Poll(); return; }
  $('#l3Elapsed').textContent = l3Elapsed(saved.at);
  // Per the API: normal wait is 35–55 min; give up after 90 min (stuck jobs auto-fail by then).
  if (Date.now() - saved.at > 90 * 60 * 1000) {
    stopL3Poll();
    localStorage.setItem(L3_STORE, JSON.stringify({ ...saved, status: 'failed' }));
    setMsg('#level3Msg', 'Timed out after 90 min — the job is likely stuck. Try again.', 'err');
    $('#l3Dismiss').hidden = false; $('#level3Btn').disabled = false; return;
  }
  let next = 60000;
  try {
    const s = await (await fetch(`/level3/${encodeURIComponent(saved.jobId)}`)).json();
    console.log('[L3] poll', saved.jobId, '→', s.status, s.stage || '', s.video_url ? '(has video_url)' : '');
    if (s.status === 'done') {
      stopL3Poll();
      localStorage.setItem(L3_STORE, JSON.stringify({ ...saved, status: 'done', video_url: s.video_url }));
      if (s.video_url) recordRender(saved, s); // keep it in "My Renders" while the link is valid
      l3SetStage('upload');
      const cost = `$${s.cost_usd ?? '—'}, ${Math.round((s.elapsed_seconds || 0) / 60)}m`;
      const dl = downloadHref(s.video_url, (state.video && state.video.name ? state.video.name : 'faceswap') + '.mp4');
      setMsg('#level3Msg', `Done! (${cost}) — link valid 7 days.${s.job_id ? ` · job ${s.job_id}` : ''}`, 'ok');
      const r = $('#l3Result'); r.href = dl; r.hidden = false; $('#l3Dismiss').hidden = false; $('#level3Btn').disabled = false;
      updateL3Banner(`Done! (${cost})`, dl);
      // Swap the preview to the new video when we're in the studio for this job's video.
      if (s.video_url && document.body.classList.contains('studio-open') && saved.videoId === (state.video && state.video.id)) {
        state.resultUrl = s.video_url;
        state.resultSubs = saved.subs || state.subs; // captions used for this render
        $('#previewToggle').hidden = false;
        setPreviewSource('result');
      }
      return; // terminal — no reschedule
    }
    if (s.status === 'failed') {
      stopL3Poll();
      localStorage.setItem(L3_STORE, JSON.stringify({ ...saved, status: 'failed' }));
      setMsg('#level3Msg', 'Failed: ' + (s.error || 'unknown'), 'err'); $('#l3Dismiss').hidden = false; $('#level3Btn').disabled = false;
      updateL3Banner('Failed — ' + (s.error || 'unknown'), null);
      return; // terminal
    }
    l3SetStage(s.stage || 'running');
    updateL3Banner(`${s.status === 'preparing' ? (s.stage || 'preparing') : (s.stage || 'running')} · ${l3Elapsed(saved.at)}`, null);
    next = s.status === 'preparing' ? 5000 : 60000; // poll our prep fast, Cobra every 60s
  } catch (e) { console.warn('[L3] poll error (will retry)', e); next = 10000; }
  l3Timer = setTimeout(l3Poll, next);
}

function resumeL3() {
  const saved = JSON.parse(localStorage.getItem(L3_STORE) || 'null');
  if (!saved || !state.selected['3'] || saved.videoId !== (state.video && state.video.id)) return;
  // A finished (done/failed) run must not re-populate the panel on reopen — leave it
  // clean for a new run. The dismissible banner still carries the last result.
  if (saved.status === 'done' || saved.status === 'failed') return;
  // A stale/timed-out job (past the 90-min cap) is stuck — drop it, don't resurrect it.
  if (Date.now() - saved.at > 90 * 60 * 1000) { localStorage.removeItem(L3_STORE); $('#l3Banner').hidden = true; return; }
  $('#level3Progress').hidden = false; $('#level3Btn').disabled = true;
  setMsg('#level3Msg', 'Resuming an in-progress job…', '');
  console.log('[L3] resuming job', saved.jobId);
  stopL3Poll(); l3Poll();
}

$('#level3Btn').addEventListener('click', async () => {
  if (!state.video) return;
  if (state.dirty) { setMsg('#level3Msg', 'Apply your changes first.', 'err'); return; }
  const chars = activeCharacters();
  if (!chars.length) { setMsg('#level3Msg', 'No characters to send — add at least one subtitle line with a speaker.', 'err'); return; }
  const faces = facesPayload();
  // Every character present in this clip (trim window, or the whole video) must have a face.
  const missing = chars.filter((ch) => !faces[ch.id]);
  if (missing.length) { setMsg('#level3Msg', `Upload a face for every character${state.l3Trim.on ? ` in the first ${state.l3Trim.seconds}s` : ''} — missing: ${missing.map((c) => c.name).join(', ')}.`, 'err'); return; }
  // Lip-sync: every line must be within ±10% of the original line's length at its slot.
  const bad = lengthViolations();
  if (bad.length) {
    const eg = bad.slice(0, 3).map((v) => `"${v.text.slice(0, 24)}" ${v.len}→need ${v.min}-${v.max}`).join('; ');
    setMsg('#level3Msg', `${bad.length} line(s) outside ±10% of the original length (needed for lip-sync): ${eg}${bad.length > 3 ? '…' : ''}`, 'err');
    return;
  }
  const trim = state.l3Trim.on ? state.l3Trim.seconds : 0;
  const ok = confirm(
    `Generate a face-swap + dub video for ${chars.length} character${chars.length === 1 ? '' : 's'} (all swapped)` +
    (trim ? ` — first ${trim}s only` : '') +
    `.\n\nThis runs a paid AI pipeline${trim ? ' (cheaper on a short clip)' : ': ~$5–8 and ~35–55 minutes'}. Proceed?`);
  if (!ok) return;
  $('#level3Btn').disabled = true;
  setMsg('#level3Msg', 'Submitting…', '');
  $('#level3Progress').hidden = false; $('#l3Result').hidden = true; $('#l3Dismiss').hidden = true; l3SetStage('preparing');
  // Captions are never burned by the face-swap pipeline — the studio's own export
  // burns them, so we always send subsBurn:false (no user option for it anymore).
  const reqBody = { videoId: state.video.id, language: 'en-US', subs: state.subs, faces, subsBurn: false, trimSeconds: trim || undefined };
  console.log('[L3] submitting', { video: reqBody.videoId, characters: chars.map((c) => c.id), subs: state.subs.length, trim });
  try {
    const r = await fetch('/level3', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) });
    const j = await r.json();
    console.log('[L3] submit response', r.status, j);
    if (!r.ok) throw new Error(j.error || 'submit failed');
    // Snapshot exactly what was sent (trim-filtered subs + style) so the render can be
    // shown later with captions overlaid, matching the trimmed result's timeline.
    const sentSubs = (trim ? state.subs.filter((c) => c.start < trim).map((c) => ({ ...c, end: Math.min(c.end, trim) })) : state.subs)
      .map((c) => ({ start: c.start, end: c.end, text: c.text, person: c.person }));
    const slimFaces = Object.fromEntries(Object.entries(faces).map(([k, f]) => [k, { name: f.name, url: f.url || null }]));
    localStorage.setItem(L3_STORE, JSON.stringify({ jobId: j.jobId, at: Date.now(), videoId: state.video.id, videoName: state.video.name || state.video.id, videoUrl: state.video.url || null, videoPreview: state.video.preview || null, subs: sentSubs, subStyle: { ...state.subStyle }, trim, faces: slimFaces }));
    setMsg('#level3Msg', 'Submitted — preparing the clip, then the AI pipeline (~35–55 min). You can leave this open.', 'ok');
    stopL3Poll(); l3Poll();
  } catch (e) { console.error('[L3] submit failed', e); setMsg('#level3Msg', e.message, 'err'); $('#level3Btn').disabled = false; $('#level3Progress').hidden = true; }
});
$('#l3Dismiss').addEventListener('click', clearL3);

// On load, resume any in-progress Level 3 job globally (banner + polling) so a page
// reload or navigating back to the dashboard never orphans a running job.
(function resumeL3OnLoad() {
  const saved = JSON.parse(localStorage.getItem(L3_STORE) || 'null');
  if (!saved || !saved.jobId) return;
  // Finished runs just show a dismissible banner — no polling, no panel takeover.
  if (saved.status === 'done') {
    if (saved.video_url) recordRender(saved, { video_url: saved.video_url, cost_usd: saved.cost, elapsed_seconds: saved.elapsed }); // ensure it's in My Renders
    updateL3Banner('Done!', saved.video_url ? downloadHref(saved.video_url, (saved.videoName || 'faceswap') + '.mp4') : null); return;
  }
  if (saved.status === 'failed') { updateL3Banner('Failed', null); return; }
  // Stale/stuck job (past the 90-min cap) — drop it silently instead of resurrecting.
  if (Date.now() - saved.at > 90 * 60 * 1000) { localStorage.removeItem(L3_STORE); return; }
  console.log('[L3] pending job found on load — resuming', saved.jobId);
  updateL3Banner('resuming…', null);
  stopL3Poll(); l3Poll();
})();

boot();
