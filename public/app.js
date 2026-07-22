const $ = (s) => document.querySelector(s);
const state = { video: null, templateName: null, templateType: '', placeholders: [], rawSubs: [], intro: [], subs: [], outro: [], level: 0, introOutro: false, tplIntro: [], tplOutro: [],
  subStyle: { font: 'dejavu', size: 'medium', color: '#ffffff', bg: 'box', bgColor: '#000000' } };
let cueSeq = 0;

// Preview styling that mirrors the server's libass output (WYSIWYG)
const FONT_CSS = { dejavu: "'DejaVu Sans'", poppins: "'Poppins'", ptserif: "'PT Serif'", anton: "'Anton'", bebas: "'Bebas Neue'", pacifico: "'Pacifico'" };
const FONT_WEIGHT = { dejavu: 700, poppins: 700, ptserif: 700, anton: 400, bebas: 400, pacifico: 400 };
const SIZE_CQH = { small: 4.5, medium: 5.5, large: 7.0 }; // matches server SIZE_FACTOR * 100
const hexToRgba = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000'); const [r, g, b] = m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [0, 0, 0]; return `rgba(${r},${g},${b},${a})`; };
function applySubStyle() {
  const st = state.subStyle;
  const o = document.querySelector('#subOverlay');
  o.style.setProperty('--sub-font', FONT_CSS[st.font] || FONT_CSS.dejavu);
  o.style.setProperty('--sub-weight', FONT_WEIGHT[st.font] || 700);
  o.style.setProperty('--sub-color', st.color || '#ffffff');
  o.style.setProperty('--sub-factor', SIZE_CQH[st.size] || 5.5);
  let bg = 'transparent';
  if (st.bg === 'solid') bg = st.bgColor || '#000000';
  else if (st.bg !== 'none') bg = hexToRgba(st.bgColor || '#000000', 0.5);
  o.style.setProperty('--sub-bg', bg);
  o.classList.remove('bg-box', 'bg-solid', 'bg-none');
  o.classList.add('bg-' + (st.bg || 'box'));
}
const mapCues = (arr, prefix) => (arr || []).map((s) => ({ id: `${prefix}-${cueSeq++}`, ...s }));

const video = $('#video');
const subOverlay = $('#subOverlay');
const blackOverlay = $('#blackOverlay');
const blackText = $('#blackText');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (t) => { const m = Math.floor(t / 60), s = (t % 60); return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const autoDur = (text) => Math.max(1.5, +(((text || '').trim().length) / 15).toFixed(2));
function setMsg(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || ''); }

// ===================== LOAD LIBRARY =====================
async function boot() {
  renderLevel0Card();
  renderLevel2and3();
  try {
    const videos = await (await fetch('/api/videos')).json();
    renderVideoRail(videos);
    if (videos[0]) { $('#bbVideo').src = videos[0].url; $('#bbVideo').play?.().catch(() => {}); }
  } catch { $('#railVideos').innerHTML = '<div class="loading">Failed to load videos.</div>'; }
  try {
    const tpls = await (await fetch('/api/subtitle-templates')).json();
    renderTemplateRail(tpls);
  } catch { $('#railLevel1').innerHTML = '<div class="loading">Failed to load templates.</div>'; }
}

$('#bbBrowse').addEventListener('click', () => $('#railVideos').scrollIntoView({ behavior: 'smooth', block: 'center' }));

function card({ cls = '', thumbHtml, cap, sub, onClick }) {
  const el = document.createElement('div');
  el.className = 'card ' + cls;
  el.innerHTML = `${thumbHtml}<div class="cap">${escapeHtml(cap)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
const placeholderThumb = (icon) => `<div class="thumb placeholder">${icon}</div>`;

function renderVideoRail(videos) {
  const rail = $('#railVideos');
  rail.innerHTML = '';
  if (!videos.length) { rail.innerHTML = '<div class="loading">No videos yet. Drop mp4s into the server /videos folder.</div>'; return; }
  videos.forEach((v) => {
    const thumb = `<video class="thumb" muted playsinline preload="metadata" src="${v.url}#t=0.5"></video>`;
    const el = card({ cls: 'video-card', thumbHtml: thumb, cap: v.name, sub: 'base video', onClick: () => selectVideo(v, el) });
    el.dataset.id = v.id;
    rail.appendChild(el);
  });
}

function renderLevel0Card() {
  const rail = $('#railLevel0');
  rail.innerHTML = '';
  const el = card({ cls: 'action level0', thumbHtml: placeholderThumb('✎'), cap: 'Intro & Outro', sub: 'black-screen text — combines with subtitles', onClick: () => toggleIntroOutro(el) });
  rail.appendChild(el);
}

function renderTemplateRail(tpls) {
  const rail = $('#railLevel1');
  rail.innerHTML = '';
  tpls.forEach((t) => {
    const el = card({ thumbHtml: placeholderThumb('📝'), cap: t.name, sub: 'subtitle set', onClick: () => selectTemplate(t, el) });
    el.dataset.id = t.id;
    rail.appendChild(el);
  });
  const up = card({ cls: 'action', thumbHtml: placeholderThumb('＋'), cap: 'Upload your own', sub: '.xlsx subtitle file', onClick: () => $('#xlsxInput').click() });
  rail.appendChild(up);
}

function renderLevel2and3() {
  $('#railLevel2').appendChild(card({ cls: 'soon action', thumbHtml: placeholderThumb('＋'), cap: 'Render new audio', sub: 'coming soon', onClick: () => comingSoon(2) }));
  $('#railLevel3').appendChild(card({ cls: 'soon action', thumbHtml: placeholderThumb('＋'), cap: 'Lip-sync & Face Swap', sub: 'coming soon', onClick: () => comingSoon(3) }));
}
function comingSoon(lvl) { alert(`Level ${lvl} (${lvl === 2 ? 'audio rendering' : 'lip-sync & face swap'}) is coming soon.`); }

// ===================== SELECTION (browse view — no navigation) =====================
function selectVideo(v, el) {
  state.video = v;
  document.querySelectorAll('#railVideos .card').forEach((c) => c.classList.toggle('selected', c === el));
  $('#selbar').hidden = false;
  updateSelbar();
}

function deriveLevel() { state.level = state.subs.length ? 1 : 0; }

// Intro & Outro is an independent layer — toggles on/off, stacks with subtitles.
function toggleIntroOutro(el) {
  state.introOutro = !state.introOutro;
  el.classList.toggle('selected', state.introOutro);
  if (state.introOutro) {
    if (!state.intro.length) state.intro = mapCues(state.tplIntro, 'intro'); // seed from chosen template if any
    if (!state.outro.length) state.outro = mapCues(state.tplOutro, 'outro');
  } else {
    state.intro = []; state.outro = [];
  }
  updateSelbar();
}

async function selectTemplate(t, el) {
  try {
    const cues = await (await fetch(`/api/subtitle-templates/${encodeURIComponent(t.id)}`)).json();
    applyCues(cues, t.name, el);
  } catch { alert('Failed to load template.'); }
}

// Subtitle layer — independent of Intro & Outro. Click a selected one to clear it.
function applyCues(cues, name, el) {
  const already = el && el.classList.contains('selected');
  document.querySelectorAll('#railLevel1 .card').forEach((c) => c.classList.remove('selected'));
  if (already) { // toggle off
    state.subs = []; state.templateName = null; state.placeholders = []; state.rawSubs = [];
    deriveLevel(); updateSelbar(); return;
  }
  state.templateName = name;
  state.templateType = cues.type || '';
  state.placeholders = cues.placeholders || [];
  state.rawSubs = cues.subs || [];       // keep raw (with [placeholders]) for filling
  state.subs = mapCues(cues.subs, 'sub');
  state.tplIntro = cues.intro || [];     // remembered so Intro & Outro can seed from it
  state.tplOutro = cues.outro || [];
  // include the template's intro/outro by default (part of the script)
  state.introOutro = (state.tplIntro.length || state.tplOutro.length) > 0;
  document.querySelectorAll('#railLevel0 .card').forEach((c) => c.classList.toggle('selected', state.introOutro));
  deriveLevel();
  if (el) el.classList.add('selected');
  updateSelbar();
}

$('#xlsxInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('xlsx', file);
  try {
    const r = await fetch('/api/subtitles', { method: 'POST', body: fd });
    const cues = await r.json();
    if (!r.ok) throw new Error(cues.error || 'parse failed');
    document.querySelectorAll('#railLevel1 .card').forEach((c) => c.classList.remove('selected'));
    applyCues(cues, file.name.replace(/\.xlsx$/i, ''), null);
    if (state.video) $('#selbar').hidden = false;
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
function updateSelbar() {
  $('#selVideo').textContent = state.video ? `🎬 ${state.video.name}` : 'No video';
  $('#selLevel').textContent = modeName();
  const tpl = $('#selTemplate');
  if (state.subs.length && state.templateName) { tpl.hidden = false; tpl.textContent = `${state.templateName} (${state.subs.length} lines)`; }
  else tpl.hidden = true;
  $('#continueBtn').disabled = !state.video;
}

// ===================== CONTINUE → FORM → STUDIO =====================
$('#continueBtn').addEventListener('click', openForm);
$('#backBtn').addEventListener('click', closeStudio);
$('#formBack').addEventListener('click', () => { $('#formView').hidden = true; $('#browseView').hidden = false; $('#selbar').hidden = false; });

// ---- Form data ----
const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia'];
const PARTIES = [['democrat', 'Democrat'], ['republican', 'Republican']];
const POSITIONS = ['Mayor', 'Governor', 'Lieutenant Governor', 'Attorney General', 'Secretary of State', 'U.S. Senator', 'U.S. Representative', 'State Senator', 'State Representative', 'Council member', 'County Commissioner', 'Sheriff', 'District Attorney', 'Judge', 'School Board Member', 'City Clerk', 'Treasurer', 'Assessor', 'Auditor', 'Comptroller'];

// placeholders that map onto the standard Webflow fields; the rest become dynamic inputs
const MAPPED = { FullNameX: 'fullname', OfficeX: 'position', CityX: 'city' };
const prettyToken = (t) => t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2');
const dynamicTokens = () => state.placeholders.filter((t) => !MAPPED[t] && t !== 'LastNameX');

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
  // dynamic fields for template-specific placeholders
  const dyn = $('#dynFields'); dyn.innerHTML = '';
  const toks = dynamicTokens();
  if (toks.length) {
    dyn.insertAdjacentHTML('beforeend', '<div class="dyn-head">Script details</div>');
    toks.forEach((t) => {
      const wrap = document.createElement('div'); wrap.className = 'fld';
      wrap.innerHTML = `<span class="fld-label"><i>◆</i> ${escapeHtml(prettyToken(t))}</span><input class="tin dyn-in" data-token="${t}" type="text" placeholder="Enter ${escapeHtml(prettyToken(t)).toLowerCase()}" />`;
      dyn.appendChild(wrap);
    });
  }
  $('#browseView').hidden = true; $('#selbar').hidden = true; $('#formView').hidden = false;
  window.scrollTo({ top: 0 });
}

// replace [Token] (and stray "(Token]") with entered values
function fillPlaceholders(text, values) {
  return String(text).replace(/[[(]\s*([A-Za-z][A-Za-z0-9]*)\s*\]/g, (m, tok) => (values[tok] != null && values[tok] !== '' ? values[tok] : m));
}

$('#genForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fullName = $('#f-fullname').value.trim();
  const values = {};
  if (fullName) { values.FullNameX = fullName; values.LastNameX = fullName.split(/\s+/).pop(); }
  const pos = $('#f-position').value; if (pos) values.OfficeX = pos;
  const city = $('#f-city').value.trim(); if (city) values.CityX = city;
  document.querySelectorAll('#dynFields .dyn-in').forEach((inp) => { if (inp.value.trim()) values[inp.dataset.token] = inp.value.trim(); });

  // build filled cues from the raw template text
  const fill = (arr) => arr.map((c) => ({ ...c, text: fillPlaceholders(c.text, values) }));
  state.subs = mapCues(fill(state.rawSubs), 'sub');
  if (state.introOutro) { state.intro = mapCues(fill(state.tplIntro), 'intro'); state.outro = mapCues(fill(state.tplOutro), 'outro'); }
  else { state.intro = []; state.outro = []; }
  deriveLevel();
  $('#formView').hidden = true;
  openStudio();
});

function openStudio() {
  if (!state.video) return;
  document.body.classList.add('studio-open');
  $('#browseView').hidden = true;
  $('#selbar').hidden = true;
  $('#studio').hidden = false;
  $('#bbVideo').pause?.();
  video.src = state.video.url;
  blackOverlay.hidden = true;
  $('#chosenVideo').textContent = state.video.name;
  deriveLevel();
  applySubStyle();
  $('#substyleBox').style.display = state.subs.length ? '' : 'none';
  renderPane('intro'); renderPane('subs'); renderPane('outro');
  updateTabCounts();
  switchTab(state.subs.length ? 'subs' : 'intro');
  updateLevelUI();
  updateSubOverlay();
  window.scrollTo({ top: 0 });
}
function closeStudio() {
  stopPreview();
  video.pause();
  document.body.classList.remove('studio-open');
  $('#studio').hidden = true;
  $('#browseView').hidden = false;
  $('#selbar').hidden = false;
  $('#bbVideo').play?.().catch(() => {});
}

// ===================== SUBTITLE STYLE =====================
$('#fontSel').addEventListener('change', (e) => { state.subStyle.font = e.target.value; applySubStyle(); });
$('#sizeSel').addEventListener('change', (e) => { state.subStyle.size = e.target.value; applySubStyle(); });
$('#bgSel').addEventListener('change', (e) => { state.subStyle.bg = e.target.value; applySubStyle(); });
$('#bgColorSel').addEventListener('input', (e) => { state.subStyle.bgColor = e.target.value; applySubStyle(); });
$('#colorSel').addEventListener('input', (e) => { state.subStyle.color = e.target.value; applySubStyle(); });

// ===================== MODE BADGE (studio) =====================
function updateLevelUI() {
  deriveLevel();
  $('#levelBadge').textContent = modeName();
  const ct = $('#chosenTemplate');
  if (state.subs.length && state.templateName) { ct.style.display = ''; ct.textContent = `Subtitles: ${state.templateName} (${state.subs.length} lines)`; }
  else ct.style.display = 'none';
}

// ===================== PREVIEW OVERLAY =====================
video.addEventListener('timeupdate', updateSubOverlay);
function updateSubOverlay() {
  if (state.level < 1) { subOverlay.innerHTML = ''; return; }
  const t = video.currentTime;
  let active = null;
  for (const c of state.subs) { if (t >= c.start && t <= c.end) { active = c; break; } }
  subOverlay.innerHTML = active && active.text ? `<span>${escapeHtml(active.text)}</span>` : '';
  document.querySelectorAll('#pane-subs .cue').forEach((el) => el.classList.toggle('active', active && el.dataset.id === active.id));
  // auto-scroll the active cue into view (unless the user is typing)
  if (active && !$('#pane-subs').hidden && document.activeElement?.tagName !== 'TEXTAREA') {
    document.querySelector(`#pane-subs .cue[data-id="${active.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
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
          <span class="speaker" style="--sc:${color}">${escapeHtml(nameTxt)}</span>
          <span class="cue-time">${!isScreen ? `<button class="jump" style="--sc:${color}" data-jump="${c.start}">▶ ${timeLabel}</button>` : `⏱ ${timeLabel}`}</span>
        </div>
        <textarea rows="2" placeholder="${isScreen ? 'Screen text…' : 'Subtitle text…'}">${escapeHtml(c.text || '')}</textarea>
        <div class="cue-foot">
          <span class="charcount"></span>
          ${c.oldText ? `<span class="old" title="original text">was: ${escapeHtml(c.oldText)}</span>` : '<span></span>'}
          ${isScreen ? `<span class="screen-ctrl"><label>dur</label><input type="number" step="0.1" min="0.3" value="${c.duration ?? autoDur(c.text)}" /><button class="mini del" title="remove">✕</button></span>` : ''}
        </div>
      </div>`;
    const ta = div.querySelector('textarea');
    const cc = div.querySelector('.charcount');
    const updCC = () => { const n = ta.value.length; cc.textContent = `${n} chars`; cc.className = 'charcount' + (n > 84 ? ' bad' : n > 42 ? ' warn' : ''); };
    updCC();
    ta.addEventListener('input', () => { c.text = ta.value; updCC(); if (kind === 'subs') updateSubOverlay(); });
    const dur = div.querySelector('input[type=number]');
    if (dur) dur.addEventListener('input', () => { c.duration = Math.max(0.3, parseFloat(dur.value) || 0.3); });
    const jump = div.querySelector('[data-jump]');
    if (jump) jump.addEventListener('click', () => { video.currentTime = parseFloat(jump.dataset.jump); video.play(); });
    const del = div.querySelector('.del');
    if (del) del.addEventListener('click', () => { state[kind] = state[kind].filter((x) => x.id !== c.id); renderPane(kind); updateTabCounts(); });
    pane.appendChild(div);
  });

  if (isScreen) {
    const add = document.createElement('button');
    add.className = 'addline';
    add.innerHTML = `＋ Add ${kind} screen`;
    add.addEventListener('click', () => { state[kind].push({ id: `${kind}-${cueSeq++}`, text: '', duration: 2.5, person: 'black screen' }); renderPane(kind); updateTabCounts(); });
    pane.appendChild(add);
  }
}

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
function stopPreview() { previewing = false; suppressIntro = false; clearTimer(); blackOverlay.hidden = true; stopBtn.hidden = true; video.pause(); }
$('#playFull').addEventListener('click', () => { stopPreview(); video.currentTime = 0; suppressIntro = false; runIntroThenVideo(); });
stopBtn.addEventListener('click', stopPreview);
video.addEventListener('play', () => {
  if (previewing) return;
  if (suppressIntro) { suppressIntro = false; return; }
  if (video.currentTime <= 0.3 && state.intro.length) runIntroThenVideo();
});
video.addEventListener('ended', () => { if (!previewing && state.outro.length) runOutro(); });

// ===================== EXPORT =====================
function setProgress(pct, stage) { $('#progressBar').style.width = pct + '%'; $('#progressPct').textContent = pct + '%'; if (stage) $('#progressStage').textContent = stage; }
$('#exportBtn').addEventListener('click', async () => {
  if (!state.video) { setMsg('#exportMsg', 'No base video selected.', 'err'); return; }
  if (state.level >= 2) { comingSoon(state.level); return; }
  if (state.level === 1 && !state.subs.length) { setMsg('#exportMsg', 'Level 1 needs a subtitle set — pick one or switch to Level 0.', 'err'); return; }
  $('#exportBtn').disabled = true;
  setMsg('#exportMsg', '', '');
  $('#progressWrap').hidden = false;
  setProgress(0, 'Starting…');
  try {
    const qual = { fast: { preset: 'ultrafast', crf: 26 }, balanced: { preset: 'veryfast', crf: 23 }, high: { preset: 'medium', crf: 20 } }[$('#qualitySel').value];
    const maxHeight = parseInt($('#resSel').value, 10);
    const r = await fetch('/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: state.video.id, level: state.level, intro: state.intro, subs: state.subs, outro: state.outro, subStyle: state.subStyle, ...qual, maxHeight }),
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
