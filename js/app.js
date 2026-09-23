'use strict';

/* ==========================================================================
   SFX Manager — library, filters, and the docked player
   ========================================================================== */

/* ------------------------------ data ------------------------------ */

const CATS = {
  ui:         { label: 'UI',         color: '#7fa7e0' },
  whoosh:     { label: 'Whoosh',     color: '#9a8fd8' },
  impact:     { label: 'Impact',     color: '#d8907f' },
  riser:      { label: 'Riser',      color: '#d8b078' },
  transition: { label: 'Transition', color: '#86c0b2' },
  nature:     { label: 'Nature',     color: '#94b878' },
  imported:   { label: 'Imported',   color: '#8b93a1' },
};

const DATA = [
  { id: 'ui-1',  name: 'Granular Button Select Tick 04',      cat: 'ui',         dur: 0.14, seed: 11 },
  { id: 'ui-2',  name: 'Soft Keyboard Tap, Low Desk',         cat: 'ui',         dur: 0.12, seed: 23 },
  { id: 'ui-3',  name: 'Glassy Toggle Switch — Bright',       cat: 'ui',         dur: 0.18, seed: 37 },
  { id: 'ui-4',  name: 'Magnetic Snap Attach, Short',         cat: 'ui',         dur: 0.16, seed: 52 },
  { id: 'ui-5',  name: 'Retro Cursor Blip, Uplifted',         cat: 'ui',         dur: 0.22, seed: 64 },
  { id: 'wh-1',  name: 'Granular Wind Swish — Wide Stereo',   cat: 'whoosh',     dur: 1.6,  seed: 71 },
  { id: 'wh-2',  name: 'Fabric Rip Tear, Dry',                cat: 'whoosh',     dur: 1.2,  seed: 83 },
  { id: 'wh-3',  name: 'Airbrush Sweep, Long Tail',           cat: 'whoosh',     dur: 2.2,  seed: 97 },
  { id: 'wh-4',  name: 'Cinematic Zoom Punch, Tight',         cat: 'whoosh',     dur: 1.9,  seed: 104 },
  { id: 'im-1',  name: 'Deep Sub Hit — A Note',               cat: 'impact',     dur: 0.7,  seed: 113 },
  { id: 'im-2',  name: 'Metal Clank, Rusty Pipe',             cat: 'impact',     dur: 0.55, seed: 127 },
  { id: 'im-3',  name: 'Wood Knock, Mid Range',               cat: 'impact',     dur: 0.5,  seed: 131 },
  { id: 'im-4',  name: 'Concrete Drop, Heavy Set',            cat: 'impact',     dur: 0.9,  seed: 139 },
  { id: 'ri-1',  name: 'Granular Build-Up, Slow Burn',        cat: 'riser',      dur: 2.6,  seed: 149 },
  { id: 'ri-2',  name: 'Tension String Rise, Four Bars',      cat: 'riser',      dur: 2.2,  seed: 151 },
  { id: 'ri-3',  name: 'Air Pressure Charge, Full',           cat: 'riser',      dur: 2.8,  seed: 157 },
  { id: 'tr-1',  name: 'Whoosh-Down Cut, Snappy',             cat: 'transition', dur: 1.1,  seed: 163 },
  { id: 'tr-2',  name: 'Time-Reverse Swoosh, Soft',           cat: 'transition', dur: 1.4,  seed: 167 },
  { id: 'tr-3',  name: 'Glitch Stutter Loop, 808',            cat: 'transition', dur: 0.9,  seed: 173 },
  { id: 'tr-4',  name: 'Analog Tape Stop, Warm',              cat: 'transition', dur: 1.2,  seed: 179 },
  { id: 'na-1',  name: 'Rain on Glass, Soft Patter',          cat: 'nature',     dur: 2.3,  seed: 181 },
  { id: 'na-2',  name: 'Campfire Crackles, Close Mic',        cat: 'nature',     dur: 2.0,  seed: 191 },
  { id: 'na-3',  name: 'Distant Crowd Murmur',                cat: 'nature',     dur: 1.8,  seed: 193 },
  { id: 'na-4',  name: 'Ocean Waves, Gentle Loop',            cat: 'nature',     dur: 2.5,  seed: 197 },
].map((d, i) => ({ ...d, added: i + 1 }));

let impSeq = 0;

/* ------------------------------ dom ------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const library = $('#library');
const chipsEl = $('#chips');
const searchEl = $('#search');
const sortEl = $('#sort');
const countEl = $('#count');
const importBtn = $('#importBtn');
const fileInput = $('#fileInput');
const playerEl = $('#player');
const pDot = $('#pDot');
const pName = $('#pName');
const pSub = $('#pSub');
const waveWrap = $('#waveWrap');
const waveCanvas = $('#wave');
const waveTip = $('#waveTip');
const waveBubble = $('#waveBubble');
const playBtn = $('#playBtn');
const back5 = $('#back5');
const fwd5 = $('#fwd5');
const timeEl = $('#time');
const volEl = $('#vol');
const speedEl = $('#speed');

const ICON_PLAY =
  '<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.89l10.54-6.86c.66-.43.66-1.35 0-1.78L9.56 4.25A1.04 1.04 0 0 0 8 5.14z"/></svg>';
const ICON_PAUSE =
  '<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';

/* ------------------------------ state ------------------------------ */

const state = {
  cat: 'all',
  q: '',
  sort: 'name',
  currentId: null,
  playing: false,
  pos: 0,
  dur: 0,
  rate: 1,
  vol: 0.9,
  source: null,
  t0: 0,
  posAtStart: 0,
  buffer: null,
  peaks: null,
  tipGone: false,
};

try {
  state.tipGone = localStorage.getItem('sfx.scrub-tip') === '1';
} catch (e) { /* private mode */ }

/* ------------------------------ helpers ------------------------------ */

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};

const fmtShort = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const current = () => DATA.find((d) => d.id === state.currentId) || null;

let master = null;
function getMaster() {
  const c = SFX.ensure();
  if (!master) {
    master = c.createGain();
    master.gain.value = state.vol;
    master.connect(c.destination);
  }
  return master;
}

function cardPeaks(it) {
  return it._cardPeaks || (it._cardPeaks = SFX.peaks(SFX.render(it), 90));
}

function playPeaks(it) {
  return it._playPeaks || (it._playPeaks = SFX.peaks(SFX.render(it), 240));
}

/* ------------------------------ library ------------------------------ */

function visibleItems() {
  const q = state.q.trim().toLowerCase();
  const items = DATA.filter(
    (it) => (state.cat === 'all' || it.cat === state.cat) && (!q || it.name.toLowerCase().includes(q))
  );
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    short: (a, b) => a.dur - b.dur,
    long: (a, b) => b.dur - a.dur,
    recent: (a, b) => b.added - a.added,
  };
  return items.slice().sort(sorters[state.sort]);
}

function renderChips() {
  const present = Object.keys(CATS).filter(
    (c) => c !== 'imported' || DATA.some((d) => d.cat === 'imported')
  );
  chipsEl.innerHTML =
    `<button class="chip${state.cat === 'all' ? ' active' : ''}" type="button" data-cat="all">All sounds</button>` +
    present
      .map(
        (c) =>
          `<button class="chip${state.cat === c ? ' active' : ''}" type="button" data-cat="${c}">` +
          `<span class="dot" style="--c:${CATS[c].color}"></span>${CATS[c].label}</button>`
      )
      .join('');
}

function renderCards() {
  const items = visibleItems();
  if (!items.length) {
    library.innerHTML =
      '<div class="empty"><p>No sounds found</p><span>Try a different search or category.</span></div>';
    return;
  }
  library.innerHTML = items
    .map(
      (it) => `
    <article class="card${it.id === state.currentId ? ' playing' : ''}" data-id="${it.id}" title="${esc(it.name)}" tabindex="0">
      <div class="name-row">
        <span class="dot" style="--c:${CATS[it.cat].color}"></span>
        <h3 class="track-name">${esc(it.name)}</h3>
      </div>
      <div class="wave-strip">
        <canvas></canvas>
        <span class="hover-play"><i>${ICON_PLAY}</i></span>
      </div>
      <div class="card-foot">
        <span class="cat-label">${CATS[it.cat].label}</span>
        <span class="dur">${fmtShort(it.dur)}</span>
      </div>
    </article>`
    )
    .join('');
  requestAnimationFrame(() => {
    for (const it of items) {
      const el = library.querySelector(`.card[data-id="${it.id}"] canvas`);
      if (el) drawMini(el, cardPeaks(it), it.id === state.currentId && state.dur ? state.pos / state.dur : 0);
    }
  });
}

function updateCount() {
  countEl.textContent = `${DATA.length} sound${DATA.length === 1 ? '' : 's'} · local library`;
}

/* ------------------------------ waveform drawing ------------------------------ */

function drawMini(cv, peaks, progress) {
  if (!peaks) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W) return;
  const pw = Math.round(W * dpr);
  if (cv.width !== pw) {
    cv.width = pw;
    cv.height = Math.round(H * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const n = Math.max(20, Math.floor(W / 3.4));
  const mid = H / 2;
  const bw = Math.max(1.5, W / n - 1.7);
  for (let i = 0; i < n; i++) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor((i / n) * peaks.length))] || 0;
    const h = Math.max(2, p * (H - 8));
    const played = progress > 0 && i / n <= progress;
    c.fillStyle = played ? 'rgba(108,162,255,0.9)' : 'rgba(255,255,255,0.13)';
    c.fillRect(i * (W / n), mid - h / 2, bw, h);
  }
}

function drawMainWave() {
  const cv = waveCanvas;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W) return;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);

  if (!state.peaks) {
    c.fillStyle = 'rgba(255,255,255,0.07)';
    c.fillRect(0, H / 2 - 0.5, W, 1);
    return;
  }

  const step = 4;
  const barW = 2;
  const n = Math.max(10, Math.floor(W / step));
  const mid = H / 2;
  const progress = state.dur ? state.pos / state.dur : 0;

  for (let i = 0; i < n; i++) {
    const p = state.peaks[Math.min(state.peaks.length - 1, Math.floor((i / n) * state.peaks.length))] || 0;
    const h = Math.max(2.5, p * (H - 10));
    c.fillStyle = i / n <= progress ? 'rgba(108,162,255,0.95)' : 'rgba(255,255,255,0.14)';
    c.fillRect(i * step, mid - h / 2, barW, h);
  }

  const x = progress * W;
  c.fillStyle = 'rgba(255,255,255,0.5)';
  c.fillRect(x - 0.5, 5, 1, H - 10);
}

function drawCurrentCardMini() {
  if (!state.currentId || !state.dur) return;
  const it = current();
  const el = library.querySelector(`.card[data-id="${state.currentId}"] canvas`);
  if (it && el) drawMini(el, cardPeaks(it), state.pos / state.dur);
}

/* ------------------------------ player ------------------------------ */

function updateClock() {
  timeEl.textContent = `${fmt(state.pos)} / ${fmt(state.dur)}`;
}

function syncPlayUI() {
  playBtn.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
  playBtn.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
  playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  playerEl.classList.toggle('idle', !state.currentId);
  playerEl.classList.toggle('has-track', !!state.currentId);
  document.querySelectorAll('.card').forEach((el) => el.classList.toggle('playing', el.dataset.id === state.currentId));
}

function updatePlayerMeta() {
  const it = current();
  if (!it) {
    pName.textContent = 'No sound selected';
    pSub.textContent = 'Pick a card to preview it here';
    pDot.style.setProperty('--c', '#3a4048');
  } else {
    pName.textContent = it.name;
    pSub.textContent = `${CATS[it.cat].label} · ${fmtShort(it.dur)}`;
    pDot.style.setProperty('--c', CATS[it.cat].color);
  }
}

function stopSource() {
  if (!state.source) return;
  state.source.onended = null;
  try { state.source.stop(); } catch (e) { /* already stopped */ }
  state.source = null;
}

function loadTrack(id, autoplay) {
  const item = DATA.find((d) => d.id === id);
  if (!item) return;
  stopSource();
  state.buffer = SFX.render(item);
  state.peaks = playPeaks(item);
  state.currentId = id;
  state.dur = item.dur;
  state.pos = 0;
  state.playing = false;
  updatePlayerMeta();
  syncPlayUI();
  updateClock();
  drawMainWave();
  if (autoplay) play();
}

function play() {
  if (!state.currentId) return;
  const c = SFX.ensure();
  if (c.state === 'suspended') c.resume();
  const masterGain = getMaster();
  const pos = state.pos >= state.dur ? 0 : state.pos;
  state.posAtStart = pos;
  state.pos = pos;

  const src = c.createBufferSource();
  src.buffer = state.buffer;
  src.playbackRate.value = state.rate;
  src.connect(masterGain);
  state.source = src;
  state.t0 = c.currentTime;
  state.playing = true;
  src.onended = () => {
    if (state.source === src) {
      state.source = null;
      state.playing = false;
      state.pos = state.dur;
      updateClock();
      drawMainWave();
      drawCurrentCardMini();
      syncPlayUI();
    }
  };
  src.start(0, pos);
  syncPlayUI();
}

function pause() {
  if (!state.source) return;
  const c = SFX.ensure();
  state.pos = state.posAtStart + (c.currentTime - state.t0) * state.rate;
  state.source.onended = null;
  try { state.source.stop(); } catch (e) { /* noop */ }
  state.source = null;
  state.playing = false;
  updateClock();
  drawMainWave();
  drawCurrentCardMini();
  syncPlayUI();
}

function toggle() {
  if (!state.currentId) {
    const first = visibleItems()[0];
    if (first) loadTrack(first.id, true);
    return;
  }
  if (state.playing) pause();
  else play();
}

function seekBy(dt) {
  if (!state.currentId) return;
  const p = Math.min(state.dur, Math.max(0, state.pos + dt));
  if (state.playing) {
    pause();
    state.pos = p;
    play();
  } else {
    state.pos = p;
    updateClock();
    drawMainWave();
    drawCurrentCardMini();
  }
}

/* scrubbing */
let dragging = false;
let dragWasPlaying = false;

function dismissTip(save) {
  if (state.tipGone) return;
  state.tipGone = true;
  waveTip.classList.add('gone');
  if (save) {
    try { localStorage.setItem('sfx.scrub-tip', '1'); } catch (e) { /* noop */ }
  }
}

function seekFromX(clientX) {
  const r = waveWrap.getBoundingClientRect();
  let f = (clientX - r.left) / r.width;
  f = Math.min(1, Math.max(0, f));
  state.pos = f * state.dur;
  updateClock();
  drawMainWave();
  drawCurrentCardMini();
  waveWrap.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  waveBubble.style.left = `${f * r.width}px`;
  waveBubble.textContent = fmt(state.pos);
}

waveWrap.addEventListener('pointerdown', (e) => {
  if (!state.currentId) return;
  dragging = true;
  dragWasPlaying = state.playing;
  if (state.playing) pause();
  waveWrap.setPointerCapture(e.pointerId);
  dismissTip(true);
  waveBubble.classList.add('show');
  seekFromX(e.clientX);
});

waveWrap.addEventListener('pointermove', (e) => {
  if (dragging) seekFromX(e.clientX);
});

function endScrub() {
  if (!dragging) return;
  dragging = false;
  waveBubble.classList.remove('show');
  if (dragWasPlaying && state.pos < state.dur - 0.01) play();
}

waveWrap.addEventListener('pointerup', endScrub);
waveWrap.addEventListener('pointercancel', endScrub);

waveWrap.addEventListener('keydown', (e) => {
  if (!state.currentId) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-0.5); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(0.5); }
});

/* ------------------------------ events ------------------------------ */

library.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (card.dataset.id === state.currentId) toggle();
  else loadTrack(card.dataset.id, true);
});

library.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (card.dataset.id === state.currentId) toggle();
  else loadTrack(card.dataset.id, true);
});

chipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.cat = chip.dataset.cat;
  renderChips();
  renderCards();
});

searchEl.addEventListener('input', () => {
  state.q = searchEl.value;
  renderCards();
});

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = '';
    state.q = '';
    renderCards();
    searchEl.blur();
  }
});

sortEl.addEventListener('change', () => {
  state.sort = sortEl.value;
  renderCards();
});

playBtn.addEventListener('click', toggle);
back5.addEventListener('click', () => seekBy(-5));
fwd5.addEventListener('click', () => seekBy(5));

volEl.addEventListener('input', () => {
  state.vol = parseFloat(volEl.value);
  getMaster().gain.value = state.vol;
  volEl.style.setProperty('--fill', `${state.vol * 100}%`);
});

speedEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const r = parseFloat(b.dataset.rate);
  if (r === state.rate) return;
  state.rate = r;
  speedEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (state.playing) {
    pause();
    play();
  }
});

importBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  if (!files.length) return;
  const c = SFX.ensure();
  if (c.state === 'suspended') c.resume();
  let added = 0;
  for (const f of files) {
    try {
      const ab = await f.arrayBuffer();
      const buf = await c.decodeAudioData(ab);
      const name = f.name.replace(/\.[^.]+$/, '');
      DATA.push({
        id: `imp-${++impSeq}`,
        name,
        cat: 'imported',
        dur: buf.duration,
        seed: (impSeq * 7919) % 99991,
        _buffer: buf,
        added: Date.now() + added,
      });
      added++;
    } catch (err) {
      console.warn('Could not decode', f.name, err);
    }
  }
  if (added) {
    renderChips();
    renderCards();
    updateCount();
  }
});

window.addEventListener('keydown', (e) => {
  const inField = e.target.matches && e.target.matches('input, textarea, select');
  if (e.key === '/' && !inField) {
    e.preventDefault();
    searchEl.focus();
    return;
  }
  if (inField) return;
  if (e.key === ' ') {
    e.preventDefault();
    toggle();
  } else if (e.key === 'ArrowLeft' && e.target !== waveWrap) {
    seekBy(-5);
  } else if (e.key === 'ArrowRight' && e.target !== waveWrap) {
    seekBy(5);
  }
});

let rzTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    drawMainWave();
    requestAnimationFrame(() => {
      for (const it of visibleItems()) {
        const el = library.querySelector(`.card[data-id="${it.id}"] canvas`);
        if (el) drawMini(el, cardPeaks(it), it.id === state.currentId && state.dur ? state.pos / state.dur : 0);
      }
    });
  }, 120);
});

/* ------------------------------ frame loop ------------------------------ */

function tick() {
  if (state.playing && state.source) {
    const c = SFX.ensure();
    state.pos = state.posAtStart + (c.currentTime - state.t0) * state.rate;
    if (state.pos >= state.dur) state.pos = state.dur;
    updateClock();
    drawMainWave();
    drawCurrentCardMini();
    waveWrap.setAttribute('aria-valuenow', state.dur ? String(Math.round((state.pos / state.dur) * 100)) : '0');
  }
  requestAnimationFrame(tick);
}

/* ------------------------------ init ------------------------------ */

if (state.tipGone) waveTip.classList.add('gone');
volEl.style.setProperty('--fill', `${state.vol * 100}%`);
renderChips();
renderCards();
updateCount();
updatePlayerMeta();
updateClock();
drawMainWave();
syncPlayUI();
requestAnimationFrame(tick);
