const $ = (s) => document.querySelector(s);
const state = { video: null, templateName: null, intro: [], subs: [], outro: [], level: 1 };
let cueSeq = 0;

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
  } catch { $('#railVideos').innerHTML = '<div class="loading">Failed to load videos.</div>'; }
  try {
    const tpls = await (await fetch('/api/subtitle-templates')).json();
    renderTemplateRail(tpls);
  } catch { $('#railLevel1').innerHTML = '<div class="loading">Failed to load templates.</div>'; }
}

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
  const el = card({
    cls: 'action', thumbHtml: placeholderThumb('✎'),
    cap: 'Intro & Outro', sub: 'add your own black-screen text',
    onClick: () => { state.level = Math.max(state.level, 0); openDrawer('intro'); },
  });
  rail.appendChild(el);
}

function renderTemplateRail(tpls) {
  const rail = $('#railLevel1');
  rail.innerHTML = '';
  tpls.forEach((t) => {
    const el = card({
      thumbHtml: placeholderThumb('📝'), cap: t.name, sub: 'subtitle set',
      onClick: () => selectTemplate(t, el),
    });
    el.dataset.id = t.id;
    rail.appendChild(el);
  });
  // upload-your-own
  const up = card({ cls: 'action', thumbHtml: placeholderThumb('＋'), cap: 'Upload your own', sub: '.xlsx subtitle file', onClick: () => $('#xlsxInput').click() });
  rail.appendChild(up);
}

function renderLevel2and3() {
  $('#railLevel2').appendChild(card({ cls: 'soon action', thumbHtml: placeholderThumb('＋'), cap: 'Render new audio', sub: 'coming soon', onClick: () => comingSoon(2) }));
  $('#railLevel3').appendChild(card({ cls: 'soon action', thumbHtml: placeholderThumb('＋'), cap: 'Lip-sync & Face Swap', sub: 'coming soon', onClick: () => comingSoon(3) }));
}
function comingSoon(lvl) {
  setMsg('#exportMsg', `Level ${lvl} is coming soon.`, '');
  if (!$('#hero').hidden) $('#hero').scrollIntoView({ behavior: 'smooth' });
  alert(`Level ${lvl} (${lvl === 2 ? 'audio rendering' : 'lip-sync & face swap'}) is coming soon.`);
}

// ===================== SELECTION =====================
function selectVideo(v, el) {
  state.video = v;
  document.querySelectorAll('#railVideos .card').forEach((c) => c.classList.toggle('selected', c === el));
  $('#hero').hidden = false;
  video.src = v.url;
  blackOverlay.hidden = true;
  $('#chosenVideo').textContent = v.name;
  updateLevelUI();
  updateSubOverlay();
  $('#hero').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function selectTemplate(t, el) {
  try {
    const cues = await (await fetch(`/api/subtitle-templates/${encodeURIComponent(t.id)}`)).json();
    applyCues(cues, t.name, el);
  } catch { setMsg('#exportMsg', 'Failed to load template.', 'err'); }
}

function applyCues(cues, name, el) {
  state.templateName = name;
  state.subs = (cues.subs || []).map((s) => ({ id: `sub-${cueSeq++}`, ...s }));
  // seed intro/outro from the file only if the user hasn't added any yet (Level 0 is independent)
  if (!state.intro.length) state.intro = (cues.intro || []).map((s) => ({ id: `intro-${cueSeq++}`, ...s }));
  if (!state.outro.length) state.outro = (cues.outro || []).map((s) => ({ id: `outro-${cueSeq++}`, ...s }));
  state.level = 1;
  $('#levelSel').value = '1';
  if (el) document.querySelectorAll('#railLevel1 .card').forEach((c) => c.classList.toggle('selected', c === el));
  $('#chosenTemplate').textContent = `Subtitles: ${name} (${state.subs.length} lines)`;
  renderPane('intro'); renderPane('subs'); renderPane('outro');
  updateLevelUI();
  updateSubOverlay();
  setMsg('#exportMsg', '', '');
}

// upload your own xlsx
$('#xlsxInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('xlsx', file);
  setMsg('#exportMsg', 'Parsing subtitle file…', '');
  try {
    const r = await fetch('/api/subtitles', { method: 'POST', body: fd });
    const cues = await r.json();
    if (!r.ok) throw new Error(cues.error || 'parse failed');
    document.querySelectorAll('#railLevel1 .card').forEach((c) => c.classList.remove('selected'));
    applyCues(cues, file.name.replace(/\.xlsx$/i, ''), null);
  } catch (err) { setMsg('#exportMsg', err.message, 'err'); }
  e.target.value = '';
});

// ===================== LEVEL UI =====================
$('#levelSel').addEventListener('change', () => { state.level = parseInt($('#levelSel').value, 10); updateLevelUI(); updateSubOverlay(); });
function updateLevelUI() {
  const names = ['Intro/Outro only', 'Subtitles', 'Audio + Subtitles', 'Lip-sync & Face Swap'];
  $('#levelBadge').textContent = `Level ${state.level} · ${names[state.level]}`;
  $('#chosenTemplate').style.display = state.level >= 1 && state.templateName ? '' : 'none';
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
}

// ===================== EDITOR DRAWER =====================
$('#editToggle').addEventListener('click', () => openDrawer('subs'));
$('#drawerClose').addEventListener('click', () => { $('#drawer').hidden = true; });
function openDrawer(tab) {
  $('#drawer').hidden = false;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['intro', 'subs', 'outro'].forEach((k) => { $('#pane-' + k).hidden = k !== tab; });
  renderPane('intro'); renderPane('subs'); renderPane('outro');
  $('#drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openDrawer(t.dataset.tab)));

function renderPane(kind) {
  const pane = $('#pane-' + kind);
  pane.innerHTML = '';
  const list = state[kind];
  const isScreen = kind !== 'subs';
  list.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'cue';
    div.dataset.id = c.id;
    const timeLabel = isScreen ? `screen · ${c.duration ?? autoDur(c.text)}s` : `${fmt(c.start)} → ${fmt(c.end)}`;
    div.innerHTML = `
      <div class="meta">
        <span class="person">${escapeHtml(c.person || kind)}</span>
        <span class="time">${timeLabel} ${!isScreen ? `<button class="jump" data-jump="${c.start}">jump</button>` : ''}</span>
      </div>
      <textarea rows="2">${escapeHtml(c.text || '')}</textarea>
      ${c.oldText ? `<div class="old">old: ${escapeHtml(c.oldText)}</div>` : ''}
      ${isScreen ? `<div class="row2"><label>Duration (s)</label><input type="number" step="0.1" min="0.3" value="${c.duration ?? autoDur(c.text)}" /><button class="jump del">✕ remove</button></div>` : ''}`;
    const ta = div.querySelector('textarea');
    ta.addEventListener('input', () => { c.text = ta.value; if (kind === 'subs') updateSubOverlay(); });
    const dur = div.querySelector('input[type=number]');
    if (dur) dur.addEventListener('input', () => { c.duration = Math.max(0.3, parseFloat(dur.value) || 0.3); });
    const jump = div.querySelector('[data-jump]');
    if (jump) jump.addEventListener('click', () => { video.currentTime = parseFloat(jump.dataset.jump); video.play(); });
    const del = div.querySelector('.del');
    if (del) del.addEventListener('click', () => { state[kind] = state[kind].filter((x) => x.id !== c.id); renderPane(kind); });
    pane.appendChild(div);
  });
  if (isScreen) {
    const add = document.createElement('button');
    add.className = 'addline';
    add.textContent = `+ Add ${kind} line`;
    add.addEventListener('click', () => {
      state[kind].push({ id: `${kind}-${cueSeq++}`, text: '', duration: 2.5, person: 'black screen' });
      renderPane(kind);
    });
    pane.appendChild(add);
  }
}

// ===================== FULL PREVIEW (intro→video→outro) =====================
let previewTimer = null, previewing = false, suppressIntro = false;
const stopBtn = $('#stopPreview');
const clearTimer = () => { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } };

function playScreens(list, i, done) {
  if (!previewing) return;
  if (i >= list.length) return done();
  const sc = list[i];
  blackOverlay.hidden = false;
  blackText.textContent = sc.text || '';
  previewTimer = setTimeout(() => playScreens(list, i + 1, done), (Number(sc.duration) || autoDur(sc.text)) * 1000);
}
function runIntroThenVideo() {
  clearTimer(); previewing = true; video.pause(); stopBtn.hidden = false;
  playScreens(state.intro, 0, () => {
    previewing = false; blackOverlay.hidden = true; suppressIntro = true;
    video.currentTime = 0; video.play();
  });
}
function runOutro() {
  clearTimer(); previewing = true; stopBtn.hidden = false;
  playScreens(state.outro, 0, () => { previewing = false; blackOverlay.hidden = true; stopBtn.hidden = true; });
}
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
function setProgress(pct, stage) {
  $('#progressBar').style.width = pct + '%';
  $('#progressPct').textContent = pct + '%';
  if (stage) $('#progressStage').textContent = stage;
}
$('#exportBtn').addEventListener('click', async () => {
  if (!state.video) { setMsg('#exportMsg', 'Pick a base video first.', 'err'); return; }
  if (state.level >= 2) { comingSoon(state.level); return; }
  if (state.level === 1 && !state.subs.length) { setMsg('#exportMsg', 'Level 1 needs a subtitle set — pick one or drop to Level 0.', 'err'); return; }
  $('#exportBtn').disabled = true;
  setMsg('#exportMsg', '', '');
  $('#progressWrap').hidden = false;
  setProgress(0, 'Starting…');
  try {
    const qual = { fast: { preset: 'ultrafast', crf: 26 }, balanced: { preset: 'veryfast', crf: 23 }, high: { preset: 'medium', crf: 20 } }[$('#qualitySel').value];
    const maxHeight = parseInt($('#resSel').value, 10);
    const r = await fetch('/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: state.video.id, level: state.level, intro: state.intro, subs: state.subs, outro: state.outro, ...qual, maxHeight }),
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
