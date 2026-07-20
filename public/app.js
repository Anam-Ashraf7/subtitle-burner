const $ = (s) => document.querySelector(s);
const state = { id: null, intro: [], subs: [], outro: [], meta: null };

const videoInput = $('#videoInput');
const xlsxInput = $('#xlsxInput');
const loadBtn = $('#loadBtn');

function refreshLoad() {
  $('#videoName').textContent = videoInput.files[0]?.name || 'no file';
  $('#xlsxName').textContent = xlsxInput.files[0]?.name || 'no file';
  loadBtn.disabled = !(videoInput.files[0] && xlsxInput.files[0]);
}
videoInput.addEventListener('change', refreshLoad);
xlsxInput.addEventListener('change', refreshLoad);

loadBtn.addEventListener('click', async () => {
  const fd = new FormData();
  fd.append('video', videoInput.files[0]);
  fd.append('xlsx', xlsxInput.files[0]);
  loadBtn.disabled = true;
  setMsg('#uploadMsg', 'Uploading & parsing…', '');
  try {
    const r = await fetch('/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'upload failed');
    Object.assign(state, data);
    setMsg('#uploadMsg', `Loaded ${state.subs.length} subtitles, ${state.intro.length} intro & ${state.outro.length} outro screens.`, 'ok');
    initEditor();
  } catch (e) {
    setMsg('#uploadMsg', e.message, 'err');
    loadBtn.disabled = false;
  }
});

function setMsg(sel, text, cls) {
  const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || '');
}

const video = $('#video');
const subOverlay = $('#subOverlay');
const blackOverlay = $('#blackOverlay');
const blackText = $('#blackText');

function fmt(t) {
  const m = Math.floor(t / 60), s = (t % 60);
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function initEditor() {
  $('#uploadCard').hidden = true;
  $('#editor').hidden = false;
  video.src = `/video/${state.id}`;
  blackOverlay.hidden = true;
  renderPane('subs');
  renderPane('intro');
  renderPane('outro');
  video.addEventListener('timeupdate', updateSubOverlay);
}

function updateSubOverlay() {
  const t = video.currentTime;
  let active = null;
  for (const c of state.subs) {
    if (t >= c.start && t <= c.end) { active = c; break; }
  }
  subOverlay.innerHTML = active && active.text ? `<span>${escapeHtml(active.text)}</span>` : '';
  document.querySelectorAll('#pane-subs .cue').forEach((el) => {
    el.classList.toggle('active', active && el.dataset.id === active.id);
  });
}
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- tabs ----
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  ['intro', 'subs', 'outro'].forEach((k) => { $('#pane-' + k).hidden = k !== t.dataset.tab; });
}));

function renderPane(kind) {
  const pane = $('#pane-' + kind);
  pane.innerHTML = '';
  const list = state[kind];
  list.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'cue';
    div.dataset.id = c.id;
    const isScreen = kind !== 'subs';
    const timeLabel = isScreen ? `screen · ${c.duration}s` : `${fmt(c.start)} → ${fmt(c.end)}`;
    div.innerHTML = `
      <div class="meta">
        <span class="person">${escapeHtml(c.person || (isScreen ? kind : ''))}</span>
        <span class="time">${timeLabel}
          ${!isScreen ? `<button class="jump" data-jump="${c.start}">jump</button>` : ''}
        </span>
      </div>
      <textarea rows="2">${escapeHtml(c.text || '')}</textarea>
      ${c.oldText ? `<div class="old">old: ${escapeHtml(c.oldText)}</div>` : ''}
      ${isScreen ? `<div class="row"><label>Duration (s)</label><input type="number" step="0.1" min="0.3" value="${c.duration}" /></div>` : ''}
    `;
    const ta = div.querySelector('textarea');
    ta.addEventListener('input', () => { c.text = ta.value; if (kind === 'subs') updateSubOverlay(); });
    const dur = div.querySelector('input[type=number]');
    if (dur) dur.addEventListener('input', () => { c.duration = Math.max(0.3, parseFloat(dur.value) || 0.3); });
    const jump = div.querySelector('[data-jump]');
    if (jump) jump.addEventListener('click', () => { video.currentTime = parseFloat(jump.dataset.jump); video.play(); });
    pane.appendChild(div);
  });
}

// ---- full preview: intro screens -> video -> outro screens ----
// The black overlay is ONLY visible during the intro/outro phases.
// Playing from the START (native play button or "Preview full") runs intro first;
// reaching the END always runs the outro — matching what the exported MP4 contains.
// Scrubbing to the middle and playing skips the intro (just previews from there).
let previewTimer = null;
let previewing = false;     // true while black intro/outro screens are showing
let suppressIntro = false;  // guards the programmatic play() that follows the intro
const stopBtn = $('#stopPreview');

function clearTimer() { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } }

function playScreens(list, i, done) {
  if (!previewing) return;
  if (i >= list.length) return done();
  const sc = list[i];
  blackOverlay.hidden = false;
  blackText.textContent = sc.text || '';
  previewTimer = setTimeout(() => playScreens(list, i + 1, done), (Number(sc.duration) || 2) * 1000);
}

function runIntroThenVideo() {
  clearTimer();
  previewing = true;
  video.pause();
  stopBtn.hidden = false;
  playScreens(state.intro, 0, () => {
    previewing = false;
    blackOverlay.hidden = true;
    suppressIntro = true;      // the play() below must NOT re-trigger the intro
    video.currentTime = 0;
    video.play();
  });
}

function runOutro() {
  clearTimer();
  previewing = true;
  stopBtn.hidden = false;
  playScreens(state.outro, 0, () => {
    previewing = false;
    blackOverlay.hidden = true;
    stopBtn.hidden = true;
  });
}

function stopPreview() {
  previewing = false;
  suppressIntro = false;
  clearTimer();
  blackOverlay.hidden = true;
  stopBtn.hidden = true;
  video.pause();
}

$('#playFull').addEventListener('click', () => {
  stopPreview();
  video.currentTime = 0;
  suppressIntro = false;
  runIntroThenVideo();
});

stopBtn.addEventListener('click', stopPreview);

// Native play button: if starting from the top, run the intro first.
video.addEventListener('play', () => {
  if (previewing) return;
  if (suppressIntro) { suppressIntro = false; return; }
  if (video.currentTime <= 0.3 && state.intro.length) runIntroThenVideo();
});

// Reaching the end of the video rolls into the outro screens.
video.addEventListener('ended', () => {
  if (previewing) return;
  if (state.outro.length) runOutro();
});

// ---- export with live progress ----
function setProgress(pct, stage) {
  $('#progressBar').style.width = pct + '%';
  $('#progressPct').textContent = pct + '%';
  if (stage) $('#progressStage').textContent = stage;
}

$('#exportBtn').addEventListener('click', async () => {
  $('#exportBtn').disabled = true;
  setMsg('#exportMsg', '', '');
  $('#progressWrap').hidden = false;
  setProgress(0, 'Starting…');
  try {
    const r = await fetch('/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.id, intro: state.intro, subs: state.subs, outro: state.outro }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'export failed'); }
    const { jobId } = await r.json();

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
    a.href = url; a.download = 'subtitled.mp4'; a.click();
    URL.revokeObjectURL(url);
    setMsg('#exportMsg', 'Done! Downloaded subtitled.mp4', 'ok');
    setTimeout(() => { $('#progressWrap').hidden = true; }, 1500);
  } catch (e) {
    setMsg('#exportMsg', e.message, 'err');
    $('#progressWrap').hidden = true;
  } finally {
    $('#exportBtn').disabled = false;
  }
});
