/* ===================================================================== *
 *  Playlist Studio — frontend logic
 * ===================================================================== */

const PLAYLIST_DESCRIPTIONS = {
  "Pizza Party": "Monday, 5pm - Chill and hang.",
  "Pizza Party 2": "Monday, 7pm - A bit more upbeat.",
  "The Church": "Tuesday, 1pm - Songs for the band.",
  "Cocktails + Din": "Tuesday, 5pm - Love songs for dinner.",
  "Wedding Reception": "Tuesday, 8pm - The party.",
  "Reception 2": "Tuesday, 10pm - More party.",
  "Reception 3": "Tuesday, Midnight - More niche / chill.",
  "Reception 4": "Tuesday, Midnight - More niche / chill.",
  "End The Night": "Tuesday, Late - Wind it down.",
  "Extra Songs": "Backups",
  "Instrumentals": "Just in case.",
  "Trash": "Things to delete."
};

const EMOJIS = ["💞", "✨", "🍂", "🕺", "🗑️"];

// Linked playlist chains — when the last song ends, the next playlist auto-starts
const LINKED_CHAINS = [
  ["Pizza Party", "Pizza Party 2"],
  ["Wedding Reception", "Reception 2", "Reception 3", "End The Night"],
];

let audio  = document.getElementById("audio");
let audiob = document.getElementById("audio-b");

const state = {
  playlists: [],
  current: null,          // current playlist name (column 2)
  items: [],              // items of current playlist
  selection: new Set(),   // checked item ids (current playlist)
  playing: null,          // { sig, item }  -- sig is rename-stable
  lastSelectedId: null,   // id of the last checked item for shift-click
};

let expanded = false;         // player expand mode
let expandRenderToken = 0;    // cancels stale async renders
let locked = false;           // lock screen mode
let fadeToPause = false;      // pause at start of next track instead of playing
const LOCK_PASSWORD = "1235";

// Waveform data cache: sig → { data: Float32Array, winSec, duration, dipTime }
const waveformCache = new Map();

// Cache of loaded items per playlist (for shortened-duration totals in col 1)
const playlistItemsCache = new Map();

// Go Here Next / Queue Next state
const queueState = {
  mode: null,           // null | "goHereNext" | "queueNext"
  item: null,           // the targeted song item
  returnTo: null,       // for queueNext: natural successor to resume after the queued item
  playingQueued: false, // true while the queued item is the currently-playing song
};

/* ---------------------------------------------------------------- utils */
const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
};
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
           : `${m}:${String(sec).padStart(2,"0")}`;
};
// Identity that survives renames AND playlist moves (filename/position/emoji
// all change, so we key the "now playing" track on its title + artist).
const sigOf = (it) => `${it.title}\u0000${it.artist}`;
let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
}

function clearQueueState() {
  queueState.mode = null;
  queueState.item = null;
  queueState.returnTo = null;
  queueState.playingQueued = false;
}

function setGoHereNext(it) {
  const isActive = queueState.mode === "goHereNext" && queueState.item && sigOf(queueState.item) === sigOf(it);
  if (isActive) {
    clearQueueState();
    toast("Go Here Next cleared.");
  } else {
    clearQueueState();
    queueState.mode = "goHereNext";
    queueState.item = it;
    toast("Go Here Next");
  }
  renderItems();
  updateNextPreview();
}

function setQueueNext(it) {
  const isActive = queueState.mode === "queueNext" && queueState.item && sigOf(queueState.item) === sigOf(it);
  if (isActive) {
    queueState.mode = null;
    queueState.item = null;
    toast("Queue Next cleared.");
  } else {
    const keepPlayingQueued = queueState.playingQueued;
    const keepReturnTo = queueState.returnTo;
    clearQueueState();
    queueState.mode = "queueNext";
    queueState.item = it;
    if (keepPlayingQueued) {
      queueState.playingQueued = true;
      queueState.returnTo = keepReturnTo;
    }
    toast("Queue Next");
  }
  renderItems();
  updateNextPreview();
}

/* -------------------------------------------------------- linked chains */
function nextLinkedPlaylist(name) {
  for (const chain of LINKED_CHAINS) {
    const idx = chain.indexOf(name);
    if (idx >= 0 && idx < chain.length - 1) return chain[idx + 1];
  }
  return null;
}

function getChain(name) {
  return LINKED_CHAINS.find(c => c.includes(name)) || null;
}

function isNextInChain(a, b) {
  for (const chain of LINKED_CHAINS) {
    const idx = chain.indexOf(a);
    if (idx >= 0 && idx + 1 < chain.length && chain[idx + 1] === b) return true;
  }
  return false;
}

/* ====================================================== DJ Transition ===== */
let audioCtx = null;
let srcA = null, srcB = null;
let gainA = null, gainB = null;
let hpfA  = null, lpfB  = null;

const transState = {
  active:     false,   // transition currently running
  armed:      false,   // prefetch triggered, waiting to start
  plannedDur: null,    // transition duration for current song (computed once)
  duration:   0,
  nextItem:   null,
  completeTimer: null,
  completeAt:  null,   // wall-clock ms when transition should finish
  remainingMs: null,   // ms remaining when paused mid-transition
  triggerAt:   null,   // song-time (seconds) at which to arm the transition
  dipTime:     null,   // cached quiet-dip time (seconds) for current song
  dipAnalyzing:false,  // true while async dip analysis is in-flight
  manualTriggerAt: null, // user-dragged trigger point (null = use auto)
  manualStartAt:   null, // user-dragged start point (null = play from beginning)
};

function initWebAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Deck A — main audio element
  srcA  = audioCtx.createMediaElementSource(audio);
  gainA = audioCtx.createGain();  gainA.gain.value = 1.0;
  hpfA  = audioCtx.createBiquadFilter();
  hpfA.type = "highpass"; hpfA.frequency.value = 20; hpfA.Q.value = 0.5;
  srcA.connect(hpfA); hpfA.connect(gainA); gainA.connect(audioCtx.destination);

  // Deck B — incoming / transition audio
  srcB  = audioCtx.createMediaElementSource(audiob);
  gainB = audioCtx.createGain();  gainB.gain.value = 0.0;
  lpfB  = audioCtx.createBiquadFilter();
  lpfB.type = "lowpass"; lpfB.frequency.value = 280; lpfB.Q.value = 2.2;
  srcB.connect(lpfB); lpfB.connect(gainB); gainB.connect(audioCtx.destination);
}

function computeTransitionDuration(item) {
  // Scales with song length: ~6 % of duration, clamped 6–16 s, ±1.5 s jitter
  const dur  = item.duration || 0;
  const base = Math.max(6, Math.min(16, dur * 0.06));
  return base + (Math.random() * 3 - 1.5);
}

// Fetch + decode the audio offline, strip bass (HPF ~250 Hz) to expose
// vocals/mids, then find a spot in the 60–88 % range where a sustained
// active passage drops sharply into quiet — i.e. just after a vocal pause.
// Falls back to the quietest window if no clear drop is found.
// Returns the time in seconds, or null on failure.
async function analyzeDipTime(item) {
  const duration = item.duration || 0;
  if (duration < 10) return null;
  try {
    const resp = await fetch(item.audio_url);
    if (!resp.ok) return null;
    const arrayBuf = await resp.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try { decoded = await tmpCtx.decodeAudioData(arrayBuf); }
    finally { tmpCtx.close(); }

    const sr  = decoded.sampleRate;
    const len = decoded.length;

    // Mix down to mono
    const mono = new Float32Array(len);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += ch[i];
    }
    if (decoded.numberOfChannels > 1) {
      const nch = decoded.numberOfChannels;
      for (let i = 0; i < len; i++) mono[i] /= nch;
    }

    // 1st-order IIR high-pass ~250 Hz — strips kick/bass, keeps vocals & mids
    // α = RC / (RC + dt),  RC = 1 / (2π·fc)
    const rc  = 1 / (2 * Math.PI * 250);
    const alp = rc / (rc + 1 / sr);
    const hpf = new Float32Array(len);
    hpf[0] = mono[0];
    for (let i = 1; i < len; i++) hpf[i] = alp * (hpf[i - 1] + mono[i] - mono[i - 1]);

    // RMS in 0.1 s windows
    const winSec = 0.1;
    const winS   = Math.floor(winSec * sr);
    const numW   = Math.floor(len / winS);
    const rms    = new Float32Array(numW);
    for (let w = 0; w < numW; w++) {
      let sq = 0, s0 = w * winS;
      for (let i = s0; i < s0 + winS; i++) sq += hpf[i] * hpf[i];
      rms[w] = Math.sqrt(sq / winS);
    }

    // Smooth with ±0.3 s moving average
    const smR = Math.ceil(0.3 / winSec);
    const smo = new Float32Array(numW);
    for (let w = 0; w < numW; w++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, w - smR); j <= Math.min(numW - 1, w + smR); j++) {
        sum += rms[j]; cnt++;
      }
      smo[w] = sum / cnt;
    }

    // 70th-percentile RMS in the 50–90 % zone → "normal active" reference level
    const refStart = Math.floor(duration * 0.50 / winSec);
    const refEnd   = Math.floor(duration * 0.90 / winSec);
    const refSlice = Array.from(smo.subarray(refStart, Math.min(refEnd, numW))).sort((a, b) => a - b);
    const p70      = refSlice[Math.floor(refSlice.length * 0.70)] || 0.01;
    const quietThr = p70 * 0.30;  // quieter than this = a genuine dip

    // Scan 60–88 %: score each window as "quiet now + active just before"
    // High score → the song just paused after singing/playing
    const scanStart = Math.floor(duration * 0.60 / winSec);
    const scanEnd   = Math.floor(duration * 0.88 / winSec);
    const lookback  = Math.ceil(1.5 / winSec);   // 1.5 s preceding activity
    const lookahead = Math.ceil(1.0 / winSec);   // 1.0 s of continued quiet

    let bestScore = -1, bestTime = duration * 0.65;
    for (let w = scanStart + lookback; w < Math.min(scanEnd, numW - lookahead); w++) {
      if (smo[w] > quietThr * 1.5) continue;  // not quiet enough

      let before = 0;
      for (let j = w - lookback; j < w; j++) before += smo[j];
      before /= lookback;

      let after = 0;
      for (let j = w; j < w + lookahead; j++) after += smo[j];
      after /= lookahead;

      // Require the preceding passage to have been meaningfully active
      if (before < p70 * 0.40) continue;

      // Score = magnitude of drop × how active the passage was
      const score = (before - after) * (before / (p70 + 1e-9));
      if (score > bestScore) { bestScore = score; bestTime = w * winSec; }
    }

    // Fallback: pure quietest window in the 60–88 % band
    if (bestScore <= 0) {
      let minV = Infinity;
      for (let w = scanStart; w < Math.min(scanEnd, numW); w++) {
        if (smo[w] < minV) { minV = smo[w]; bestTime = w * winSec; }
      }
    }

    const dipResult = Math.max(duration * 0.60, Math.min(duration * 0.88, bestTime));

    // Cache normalized waveform data for display
    const sortedForNorm = Array.from(smo.subarray(0, numW)).sort((a, b) => a - b);
    const p95ForNorm = sortedForNorm[Math.floor(sortedForNorm.length * 0.95)] || 0.001;
    const normWaveform = new Float32Array(numW);
    for (let w = 0; w < numW; w++) normWaveform[w] = Math.min(1, smo[w] / p95ForNorm);
    waveformCache.set(sigOf(item), { data: normWaveform, winSec, duration, dipTime: dipResult });

    return dipResult;
  } catch (_) { return null; }
}

// Apply a found dip time to transState.triggerAt if the playhead hasn't
// already passed it and no transition is in progress.
function applyDipToTransition(dipTime, d) {
  if (dipTime === null || transState.active || transState.armed) return;
  // Don't let auto-analysis override a user-set manual trigger
  if (transState.manualTriggerAt !== null && $("shorten-enabled").checked) return;
  if (dipTime > audio.currentTime) {
    transState.triggerAt = dipTime;
  }
  // If the playhead is already past the dip, leave triggerAt unchanged
  // (natural d - plannedDur point stays in effect).
}

/* ------------------------------------------------- waveform rendering */
function drawWaveform(sig) {
  const canvas = $("waveform-canvas");
  if (!canvas) return;
  const track = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = track.clientWidth;
  const H = track.clientHeight;
  if (W === 0 || H === 0) return;

  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx2d = canvas.getContext("2d");
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  const cached = waveformCache.get(sig);
  if (!cached) return;

  const { data, winSec, duration } = cached;
  const CW = canvas.width, CH = canvas.height;
  // ~2 css-px bars; at least 1 physical pixel
  const numBars = Math.max(1, Math.floor(CW / (2 * dpr)));
  const barPx   = CW / numBars;

  ctx2d.fillStyle = "rgba(240, 215, 145, 0.55)";
  for (let i = 0; i < numBars; i++) {
    const t   = (i / numBars) * duration;
    const idx = Math.min(data.length - 1, Math.floor(t / winSec));
    const val = data[idx];
    const barH = Math.max(dpr, val * CH * 0.92);
    ctx2d.fillRect(i * barPx, (CH - barH) / 2, Math.max(dpr, barPx - dpr), barH);
  }
}

function clearWaveform() {
  const canvas = $("waveform-canvas");
  if (!canvas) return;
  const ctx2d = canvas.getContext("2d");
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

function updateControlsRow() {
  const it        = state.playing ? state.playing.item : null;
  const shortenOn = $("shorten-enabled").checked;
  const row       = $("controls-row");
  if (!row) return;

  // Row visible whenever a song is playing
  row.style.display = it ? "" : "none";
  if (!it) return;

  const hasStart = transState.manualStartAt !== null;

  // In-point controls: only visible when "shorten songs" is on
  if (shortenOn) {
    $("start-point-chip").style.display = hasStart ? "" : "none";
    $("add-in-point-btn").style.display = hasStart ? "none" : "";
    if (hasStart) $("start-point-chip").textContent = fmt(transState.manualStartAt) + " \u00d7";
  } else {
    $("start-point-chip").style.display = "none";
    $("add-in-point-btn").style.display = "none";
  }

  // Quick-intro / long-outro buttons — reflect saved tags, always visible
  const qiBtn = $("quick-intro-btn");
  const loBtn = $("long-outro-btn");
  if (qiBtn) qiBtn.classList.toggle("active", !!it.quick_intro);
  if (loBtn) loBtn.classList.toggle("active", !!it.long_outro);
}
// Keep old name as alias so any missed call sites still work
const updateClearPointsBtn = updateControlsRow;

async function getNaturalNextSong() {
  const p = state.playing;
  if (!p) return null;
  let items;
  if (p.item.playlist === state.current) items = state.items;
  else items = (await api("GET", `/api/playlists/${encodeURIComponent(p.item.playlist)}`)).items;
  const idx = items.findIndex((x) => x.type === "song" && sigOf(x) === p.sig);
  if (idx < 0) return null;
  for (let i = idx + 1; i < items.length; i++) {
    if (items[i].type === "song") return items[i];
  }
  // Try the next linked playlist
  const nextPl = nextLinkedPlaylist(p.item.playlist);
  if (nextPl) {
    try {
      const nextData = await api("GET", `/api/playlists/${encodeURIComponent(nextPl)}`);
      const firstSong = nextData.items.find(x => x.type === "song");
      if (firstSong) return firstSong;
    } catch (_) {}
  }
  return null;
}

async function getNextSong() {
  if (queueState.mode === "goHereNext" && queueState.item) return queueState.item;
  if (queueState.mode === "queueNext"  && queueState.item) return queueState.item;
  if (queueState.playingQueued && queueState.returnTo)     return queueState.returnTo;
  return getNaturalNextSong();
}

// Updates queue state when nextItem is about to become the playing song.
// Must be called before state.playing is updated so getNaturalNextSong() still
// sees the outgoing song when computing returnTo.
async function consumeQueueForNextItem(nextItem) {
  const sig = sigOf(nextItem);
  if (queueState.mode === "goHereNext" && queueState.item && sigOf(queueState.item) === sig) {
    clearQueueState();
  } else if (queueState.mode === "queueNext" && queueState.item && sigOf(queueState.item) === sig) {
    queueState.mode = null;
    queueState.item = null;
    if (!queueState.playingQueued) {
      queueState.returnTo = await getNaturalNextSong();
      queueState.playingQueued = true;
    }
  } else if (queueState.playingQueued) {
    clearQueueState();
  }
}

function startTransition(nextItem) {
  if (transState.active) return;
  if (!audioCtx) initWebAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  const T   = transState.plannedDur;
  const now = audioCtx.currentTime;
  transState.active   = true;
  transState.duration = T;
  transState.nextItem = nextItem;

  // -- Deck B in: pre-load and start --
  audiob.src = nextItem.audio_url;
  audiob.volume = 1;
  audiob.playbackRate = 1.0;
  // Seek incoming deck to custom start point if shorten is on
  const _nextStartAt = $('shorten-enabled').checked && nextItem.start_point != null
    ? nextItem.start_point : null;
  if (_nextStartAt !== null) {
    audiob.addEventListener('loadedmetadata', () => { audiob.currentTime = _nextStartAt; }, { once: true });
  }
  audiob.play().catch(() => {});

  hpfA.frequency.cancelScheduledValues(now);
  gainA.gain.cancelScheduledValues(now);
  lpfB.frequency.cancelScheduledValues(now);
  gainB.gain.cancelScheduledValues(now);

  const currentItem   = state.playing ? state.playing.item : null;
  const hasLongOutro  = !!(currentItem && currentItem.long_outro);
  const hasQuickIntro = !!nextItem.quick_intro;
  const EXTRA = hasLongOutro ? 4.0 : 0;

  // ---- Deck A out (driven by outgoing track's long_outro + incoming quick_intro) ----
  if (hasQuickIntro) {
    const CUT    = Math.min(T, 4.0);
    const LINGER = CUT * 0.18;

    hpfA.frequency.setValueAtTime(20, now);
    hpfA.frequency.setValueAtTime(20, now + LINGER);
    if (hasLongOutro) {
      // Gentle bass cut during CUT, then vocal tail fades out over EXTRA
      hpfA.frequency.exponentialRampToValueAtTime(400,  now + CUT * 0.5);
      hpfA.frequency.exponentialRampToValueAtTime(700,  now + CUT);
      hpfA.frequency.exponentialRampToValueAtTime(3500, now + CUT + EXTRA);
    } else {
      hpfA.frequency.exponentialRampToValueAtTime(700,  now + CUT * 0.55);
      hpfA.frequency.exponentialRampToValueAtTime(4500, now + CUT);
    }

    gainA.gain.setValueAtTime(1.0, now);
    gainA.gain.setValueAtTime(1.0, now + LINGER);
    if (hasLongOutro) {
      gainA.gain.linearRampToValueAtTime(0.7,  now + CUT * 0.5);
      gainA.gain.linearRampToValueAtTime(0.55, now + CUT);           // still present when B hits full
      gainA.gain.linearRampToValueAtTime(0.0,  now + CUT + EXTRA);
    } else {
      gainA.gain.linearRampToValueAtTime(0.5, now + CUT * 0.5);
      gainA.gain.linearRampToValueAtTime(0.0, now + CUT);
    }

    const deckAEnd   = hasLongOutro ? CUT + EXTRA : CUT;
    const rampStartQI = Date.now() + LINGER * 1000;
    const rampMsQI    = (deckAEnd - LINGER) * 900;
    const rateIntervalQI = setInterval(() => {
      const t = Date.now() - rampStartQI;
      if (t < 0) return;
      if (t >= rampMsQI || !transState.active) { clearInterval(rateIntervalQI); return; }
      audio.playbackRate = 1 + (t / rampMsQI) * 0.08;
    }, 50);

  } else {
    // Normal crossfade A, with optional long_outro vocal tail
    hpfA.frequency.setValueAtTime(20, now);
    if (hasLongOutro) {
      hpfA.frequency.exponentialRampToValueAtTime(350,  now + T * 0.5);
      hpfA.frequency.exponentialRampToValueAtTime(600,  now + T);
      hpfA.frequency.exponentialRampToValueAtTime(3500, now + T + EXTRA);
    } else {
      hpfA.frequency.exponentialRampToValueAtTime(500,  now + T * 0.55);
      hpfA.frequency.exponentialRampToValueAtTime(3500, now + T);
    }

    gainA.gain.setValueAtTime(1.0, now);
    gainA.gain.setValueAtTime(1.0, now + T * 0.18);
    if (hasLongOutro) {
      gainA.gain.linearRampToValueAtTime(0.7,  now + T * 0.6);
      gainA.gain.linearRampToValueAtTime(0.55, now + T);
      gainA.gain.linearRampToValueAtTime(0.0,  now + T + EXTRA);
    } else {
      gainA.gain.linearRampToValueAtTime(0.5, now + T * 0.6);
      gainA.gain.linearRampToValueAtTime(0.0, now + T * 0.95);
    }

    const rampStart = Date.now();
    const rampMs    = (T + EXTRA * 0.5) * 750;
    const rateInterval = setInterval(() => {
      const t = Date.now() - rampStart;
      if (t >= rampMs || !transState.active) { clearInterval(rateInterval); return; }
      audio.playbackRate = 1 + (t / rampMs) * 0.09;
    }, 50);
  }

  // ---- Deck B in (driven purely by incoming track's quick_intro) ----
  if (hasQuickIntro) {
    const CUT  = Math.min(T, 4.0);
    const DROP = CUT * 0.06;
    lpfB.frequency.setValueAtTime(20000, now);
    gainB.gain.setValueAtTime(0.0, now);
    gainB.gain.setValueAtTime(0.0, now + DROP);
    gainB.gain.linearRampToValueAtTime(0.6,  now + CUT * 0.3);
    gainB.gain.linearRampToValueAtTime(1.0,  now + CUT * 0.5);  // full at halfway
  } else {
    // Normal resonant LPF sweep
    lpfB.frequency.setValueAtTime(280, now);
    lpfB.frequency.setValueAtTime(280, now + T * 0.08);
    lpfB.frequency.exponentialRampToValueAtTime(2200,  now + T * 0.5);
    lpfB.frequency.exponentialRampToValueAtTime(20000, now + T * 0.78);
    gainB.gain.setValueAtTime(0.0, now);
    gainB.gain.setValueAtTime(0.0, now + T * 0.1);
    gainB.gain.linearRampToValueAtTime(0.35, now + T * 0.38);
    gainB.gain.linearRampToValueAtTime(0.75, now + T * 0.68);
    gainB.gain.linearRampToValueAtTime(1.0,  now + T * 0.9);
  }

  // -- Visuals --
  $("player").classList.add("transitioning");
  $("scrub-fill").classList.add("transitioning");
  $("next-title").textContent  = nextItem.title;
  $("next-artist").textContent = nextItem.artist;
  const na = $("next-art");
  na.style.display = "";
  na.src = nextItem.art_url;
  na.onerror = () => { na.style.display = "none"; };
  $("next-preview").style.display = "";

  const _currentItem    = state.playing ? state.playing.item : null;
  const _longOutroExtra = (_currentItem && _currentItem.long_outro) ? 4.0 : 0;
  const tMs = nextItem.quick_intro
    ? (Math.min(T, 4.0) + _longOutroExtra) * 1000
    : (T + _longOutroExtra) * 1000;
  transState.completeAt    = Date.now() + tMs;
  transState.remainingMs   = null;
  transState.completeTimer = setTimeout(() => completeTransition(nextItem), tMs);
}

async function completeTransition(nextItem) {
  if (!transState.active) return;
  transState.active = false;
  clearTimeout(transState.completeTimer);
  audio.playbackRate = 1.0;

  // Snap ramps to final state
  const now = audioCtx.currentTime;
  gainA.gain.cancelScheduledValues(now); gainA.gain.setValueAtTime(0.0, now);
  gainB.gain.cancelScheduledValues(now); gainB.gain.setValueAtTime(1.0, now);
  hpfA.frequency.cancelScheduledValues(now); hpfA.frequency.setValueAtTime(20, now);
  lpfB.frequency.cancelScheduledValues(now); lpfB.frequency.setValueAtTime(20000, now);

  // Promote deck B to deck A by swapping all variable references.
  // audiob is already playing the next song at the right position —
  // no reload, no seek, no silence gap.
  const oldAudio = audio;
  [audio, audiob] = [audiob, audio];
  [srcA,  srcB  ] = [srcB,  srcA  ];
  [gainA, gainB ] = [gainB, gainA ];
  [hpfA,  lpfB  ] = [lpfB,  hpfA  ];

  // Move event listeners to the new primary element
  reattachAudioListeners(oldAudio);
  // audio is already playing; sync button since the play event won't re-fire
  $("play-btn").textContent = audio.paused ? "▶" : "⏸";

  // Re-initialise filter roles for the swapped nodes
  const n2 = audioCtx.currentTime;
  hpfA.type = "highpass"; hpfA.frequency.setValueAtTime(20,  n2); hpfA.Q.value = 0.5;
  lpfB.type = "lowpass";  lpfB.frequency.setValueAtTime(280, n2); lpfB.Q.value = 2.2;
  gainA.gain.setValueAtTime(1.0, n2);
  gainB.gain.setValueAtTime(0.0, n2);

  // Silence and clear the old outgoing element (now behind audiob)
  audiob.pause();
  audiob.src = "";

  // Update queue state before advancing state.playing (getNaturalNextSong still
  // sees the outgoing song here, so returnTo is computed correctly).
  await consumeQueueForNextItem(nextItem);
  state.playing = { sig: sigOf(nextItem), item: nextItem };
  transState.armed         = false;
  transState.plannedDur    = null;
  transState.triggerAt     = null;
  transState.dipTime       = null;
  transState.dipAnalyzing  = false;
  transState.manualTriggerAt = (nextItem.transition_point != null) ? nextItem.transition_point : null;
  transState.manualStartAt   = (nextItem.start_point != null) ? nextItem.start_point : null;

  // Load waveform for the new song (may already be cached from pre-fetch)
  const _newSig = sigOf(nextItem);
  if (waveformCache.has(_newSig)) {
    const cached = waveformCache.get(_newSig);
    transState.dipTime = cached.dipTime ?? null;
    // If no transition_point in metadata, use the cached dip and save it
    if (transState.manualTriggerAt === null && transState.dipTime !== null) {
      transState.manualTriggerAt = transState.dipTime;
      nextItem.transition_point = transState.dipTime;
      api("POST", "/api/transition-point", { playlist: nextItem.playlist, id: nextItem.id, time: transState.dipTime }).catch(() => {});
    }
    setTimeout(() => drawWaveform(_newSig), 20);
  } else {
    transState.dipAnalyzing = true;
    analyzeDipTime(nextItem).then((t) => {
      transState.dipAnalyzing = false;
      if (!state.playing || state.playing.sig !== _newSig) return;
      transState.dipTime = t;
      drawWaveform(_newSig);
      // If no transition_point in metadata, save the calculated dip now
      if (transState.manualTriggerAt === null && t !== null) {
        transState.manualTriggerAt = t;
        nextItem.transition_point = t;
        api("POST", "/api/transition-point", { playlist: nextItem.playlist, id: nextItem.id, time: t }).catch(() => {});
        if ($('shorten-enabled').checked && !transState.active && !transState.armed && t > audio.currentTime) {
          transState.triggerAt = t;
        }
      }
    }).catch(() => { transState.dipAnalyzing = false; });
  }

  $("player").classList.remove("transitioning");
  $("scrub-fill").classList.remove("transitioning");

  renderPlayer();
  updateNextPreview();
  renderItems();
  loadOccurrences(nextItem);
  loadPlaylists();
}

function abortTransition() {
  if (!transState.active && !transState.armed) return;
  transState.active = false;
  transState.armed  = false;
  clearTimeout(transState.completeTimer);
  audiob.pause(); audiob.src = "";
  if (audioCtx) {
    const now = audioCtx.currentTime;
    hpfA.frequency.cancelScheduledValues(now); hpfA.frequency.setValueAtTime(20, now);
    gainA.gain.cancelScheduledValues(now);     gainA.gain.setValueAtTime(1.0, now);
    gainB.gain.cancelScheduledValues(now);     gainB.gain.setValueAtTime(0.0, now);
    lpfB.frequency.cancelScheduledValues(now); lpfB.frequency.setValueAtTime(280, now);
  }
  audio.playbackRate = 1.0;
  $("player").classList.remove("transitioning");
  $("scrub-fill").classList.remove("transitioning");
  transState.nextItem    = null;
  transState.plannedDur  = null;
  transState.triggerAt   = null;
  transState.completeAt  = null;
  transState.remainingMs = null;
  // Note: manualTriggerAt is NOT cleared here — we stay on the same song
  updateNextPreview();
}

/* ------------------------------------------------- always-on Up Next card */
async function updateNextPreview() {
  const next = await getNextSong();
  const el = $("next-preview");
  if (!next || !state.playing) { el.style.display = "none"; return; }
  $("next-title").textContent  = next.title;
  $("next-artist").textContent = next.artist;
  const na = $("next-art");
  na.src = next.art_url;
  na.style.display = "";
  na.onerror = () => { na.style.display = "none"; };
  el.style.display = "";
  el.classList.toggle("disabled", fadeToPause);
  // Clicking the Up Next card when fade-to-pause is on just cancels that mode
  el.onclick = fadeToPause ? () => {
    fadeToPause = false;
    $("fade-pause-btn").classList.remove("active");
    el.classList.remove("disabled");
    el.onclick = null;
  } : null;
}

/* ------------------------------------ shortened-duration helpers */
function shortenedDurOf(it) {
  const out = (it.transition_point != null) ? it.transition_point : it.duration;
  const inn = (it.start_point != null)      ? it.start_point      : 0;
  return Math.max(0, out - inn);
}

function shortenedPlaylistTotal(items) {
  let total = 0;
  for (const it of items) { if (it.type === "song") total += shortenedDurOf(it); }
  return total;
}

function playlistTotal(items) {
  let total = 0;
  for (const it of items) { if (it.type === "song") total += (it.duration || 0); }
  return total;
}

function shortDurHtml(shortened, original) {
  const close = Math.abs(original - shortened) <= 10;
  const timeSpan = close ? fmt(shortened) : `<span class="dur-short">${fmt(shortened)}</span>`;
  return ` | ${timeSpan}`;
}

/* ----------------------------------------------------- load + render col1 */
async function loadPlaylists() {
  state.playlists = await api("GET", "/api/playlists");
  renderPlaylists();
  if (!state.current && state.playlists.length) {
    const defaultPl = state.playlists.find(p => p.name === "Wedding Reception") || state.playlists[0];
    selectPlaylist(defaultPl.name);
  }
}

function renderPlaylists() {
  const wrap = $("playlist-list");
  wrap.innerHTML = "";
  state.playlists.forEach((p, pIdx) => {
    const el = document.createElement("div");
    el.className = "playlist-tile"
      + (p.name === state.current ? " active" : "")
      + (state.playing && state.playing.item.playlist === p.name && !expanded ? " now-playing" : "");
    el.dataset.name = p.name;
    
    let fullDesc = PLAYLIST_DESCRIPTIONS[p.name] || "";
    let timeStr = "";
    let descStr = fullDesc;
    if (fullDesc.includes(" - ")) {
      const idx = fullDesc.indexOf(" - ");
      timeStr = fullDesc.slice(0, idx);
      descStr = fullDesc.slice(idx);
    } else if (fullDesc) {
      descStr = " - " + fullDesc;
    }

    const timeHtml = timeStr ? `<div class="pl-time eyebrow">${esc(timeStr)}</div>` : "";
    const descHtml = descStr ? `<span class="pl-inline-desc">${esc(descStr)}</span>` : "";

    const shortenOn = $("shorten-enabled").checked;
    const cachedItems = playlistItemsCache.get(p.name);
    const shortTotalHtml = (shortenOn && cachedItems)
      ? shortDurHtml(shortenedPlaylistTotal(cachedItems), playlistTotal(cachedItems)) : "";

    el.innerHTML = `
      ${timeHtml}
      <div class="pl-name">${esc(p.name)}${descHtml}</div>
      <div class="pl-meta"><b>${p.song_count}</b> song${p.song_count===1?"":"s"} · ${p.duration_human}${shortTotalHtml}</div>`;
    el.addEventListener("click", () => selectPlaylist(p.name));
    // drop target for moving songs/dividers into this playlist
    el.addEventListener("dragover", (e) => {
      if (!dragSet.length) return;
      e.preventDefault(); el.classList.add("drop");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); el.classList.remove("drop");
      moveToPlaylist(p.name);
    });
    wrap.appendChild(el);
    // Chain link indicator between linked playlists
    const nextP = state.playlists[pIdx + 1];
    if (nextP && isNextInChain(p.name, nextP.name)) {
      const conn = document.createElement("div");
      conn.className = "chain-connector";
      conn.innerHTML = `<span>⬇</span>`;
      wrap.appendChild(conn);
    }
  });
}

/* --------------------------------------------------- load + render col2 */
async function selectPlaylist(name) {
  state.current = name;
  renderPlaylists();
  await loadItems();
}

async function loadItems() {
  const data = await api("GET", `/api/playlists/${encodeURIComponent(state.current)}`);
  state.items = data.items;
  playlistItemsCache.set(state.current, state.items);
  state.selection.clear();           // selection is transient across renames
  if (expanded) {
    await renderExpandedItems();
  } else {
    renderItems();
  }
  resyncPlaying();
}

function selectedItems() {
  return state.items.filter((it) => state.selection.has(it.id));
}

/* ------------------------------------------------- scrollbar pip */
function updateScrollPip() {
  const pip = $("scroll-pip");
  const list = $("song-list");
  if (!pip || !list) return;
  if (!state.playing || (!expanded && state.playing.item.playlist !== state.current)) {
    pip.style.display = "none";
    return;
  }
  const playingRow = list.querySelector(".row.playing");
  if (!playingRow) {
    pip.style.display = "none";
    return;
  }
  const listRect = list.getBoundingClientRect();
  const rowRect  = playingRow.getBoundingClientRect();
  // Row centre position within the full scrollable content
  const rowCentreInContent = list.scrollTop + (rowRect.top - listRect.top) + rowRect.height / 2;
  const fraction = Math.max(0, Math.min(1, rowCentreInContent / list.scrollHeight));
  // list.offsetTop is the distance from the top of #col-songs (which is position:relative)
  // to the top of #song-list, mapping the fraction onto the visible scroll track height.
  const pipTop = list.offsetTop + fraction * list.clientHeight - 10; // centre the 20px pip
  pip.style.top = pipTop + "px";
  pip.style.display = "block";
}

function renderItems() {
  if (expanded) { renderExpandedItems(); return; }
  let fullDesc = PLAYLIST_DESCRIPTIONS[state.current] || "";
  let timeStr = "";
  let descStr = fullDesc;
  if (fullDesc.includes(" - ")) {
    const idx = fullDesc.indexOf(" - ");
    timeStr = fullDesc.slice(0, idx);
    descStr = fullDesc.slice(idx);
  } else if (fullDesc) {
    descStr = " - " + fullDesc;
  }

  const descHtml = descStr ? `<span class="songs-inline-desc pl-inline-desc">${esc(descStr)}</span>` : "";
  
  $("songs-title").innerHTML = `${esc(state.current || "—")}${descHtml}`;
  if ($("songs-eyebrow")) {
    $("songs-eyebrow").textContent = timeStr || "Now editing";
  }
  if ($("songs-desc")) {
    $("songs-desc").style.display = "none";
  }

  const songCount = state.items.filter((i) => i.type === "song").length;
  const pl = state.playlists.find((p) => p.name === state.current);
  const _shortenOn = $("shorten-enabled").checked;
  if (pl) {
    let sub = `${songCount} songs · ${pl.duration_human}`;
    if (_shortenOn) sub += shortDurHtml(shortenedPlaylistTotal(state.items), playlistTotal(state.items));
    $("songs-sub").innerHTML = sub;
  } else {
    $("songs-sub").textContent = "";
  }

  const sel = selectedItems();
  const loneDivider = sel.length === 1 && sel[0].type === "divider" ? sel[0].id : null;

  const list = $("song-list");

  // DOM reuse optimization to prevent image reloading on moves or metadata updates
  const oldSongs = new Map();
  for (const child of Array.from(list.children)) {
    if (child.classList.contains("row") && child.__item && !child.classList.contains("ghost-row")) {
      oldSongs.set(sigOf(child.__item), child);
    }
  }

  // Precompute GHN fading range and QN ghost item
  const _playingSig  = state.playing ? state.playing.sig : null;
  const _ghnSig      = (queueState.mode === "goHereNext" && queueState.item) ? sigOf(queueState.item) : null;
  const _qnGhostItem = (queueState.mode === "queueNext"  && queueState.item) ? queueState.item : null;
  let _playIdx = -1, _ghnIdx = -1;
  if (_playingSig) _playIdx = state.items.findIndex(x => x.type === "song" && sigOf(x) === _playingSig);
  if (_ghnSig)     _ghnIdx  = state.items.findIndex(x => x.type === "song" && sigOf(x) === _ghnSig);
  const _doFade = _playIdx >= 0 && _ghnIdx > _playIdx;

  list.innerHTML = "";
  for (let _i = 0; _i < state.items.length; _i++) {
    const it = state.items[_i];
    if (it.type === "divider") {
      list.appendChild(dividerEl(it, it.id === loneDivider));
    } else {
      const sig = sigOf(it);
      const isBetween = _doFade && _i > _playIdx && _i < _ghnIdx;
      const isPlaying  = state.playing && sig === state.playing.sig;
      let el = oldSongs.get(sig);
      if (el) {
        // Reuse
        el.__item = it;
        el.dataset.id = it.id;
        el.querySelector(".pos").textContent = it.position;
        el.querySelector(".emoji").textContent = it.emoji || "";

        const durEl = el.querySelector(".dur");
        if (durEl) {
          const _sd = _shortenOn ? shortDurHtml(shortenedDurOf(it), it.duration) : "";
          durEl.innerHTML = it.duration_human + _sd;
        }

        const isSelected = state.selection.has(it.id);
        el.querySelector(".chk").checked = isSelected;

        const isGHN = queueState.mode === "goHereNext" && queueState.item && sigOf(queueState.item) === sig;
        const isQN  = queueState.mode === "queueNext"  && queueState.item && sigOf(queueState.item) === sig;
        el.draggable = !expanded;
        if (!expanded && !el.__dragAttached) attachDrag(el);
        el.className = "row"
          + (isSelected ? " selected"    : "")
          + (isPlaying  ? " playing"     : "")
          + (isBetween  ? " ghn-skipped" : "");
        const ghnBtn = el.querySelector(".ghn-btn");
        const qnBtn  = el.querySelector(".qn-btn");
        if (ghnBtn) ghnBtn.classList.toggle("active", isGHN);
        if (qnBtn)  qnBtn.classList.toggle("active",  isQN);
        list.appendChild(el);
      } else {
        const el2 = songEl(it);
        if (isBetween) el2.classList.add("ghn-skipped");
        list.appendChild(el2);
      }
      // Insert Queue Next ghost immediately after the currently-playing row
      if (_qnGhostItem && isPlaying) {
        list.appendChild(ghostQueueNextEl(_qnGhostItem));
      }
    }
  }
  updateScrollPip();
}

function songEl(it) {
  const row = document.createElement("div");
  row.__item = it;
  const isPlaying = state.playing && sigOf(it) === state.playing.sig;
  row.className = "row" + (state.selection.has(it.id) ? " selected" : "")
                + (isPlaying ? " playing" : "");
  row.draggable = !expanded;
  row.dataset.id = it.id;

  const checked = state.selection.has(it.id) ? "checked" : "";
  const isGHN = queueState.mode === "goHereNext" && queueState.item && sigOf(queueState.item) === sigOf(it);
  const isQN  = queueState.mode === "queueNext"  && queueState.item && sigOf(queueState.item) === sigOf(it);
  row.innerHTML = `
    <input type="checkbox" class="chk" ${checked}>
    <span class="pos">${it.position}</span>
    <span class="emoji">${it.emoji || ""}</span>
    <img class="art" alt="">
    <div class="meta">
      <div class="title">${esc(it.title)}</div>
      <div class="artist">${esc(it.artist)}</div>
    </div>
    <button class="row-act ghn-btn${isGHN ? " active" : ""}" title="Go Here Next">↩</button>
    <button class="row-act qn-btn${isQN  ? " active" : ""}" title="Queue Next">+</button>
    <span class="dur">${it.duration_human}${$("shorten-enabled").checked ? shortDurHtml(shortenedDurOf(it), it.duration) : ""}</span>`;

  // cover art with graceful placeholder
  const img = row.querySelector(".art");
  img.src = it.art_url;
  img.onerror = () => { img.replaceWith(placeholderArt()); };

  row.querySelector(".chk").addEventListener("click", (e) => {
    e.stopPropagation(); toggleSelect(row.__item.id, e);
  });
  // play when clicking the body of the row
  row.querySelector(".meta").addEventListener("click", () => playSong(row.__item));
  img.addEventListener("click", () => playSong(row.__item));
  row.querySelector(".ghn-btn").addEventListener("click", (e) => {
    e.stopPropagation(); setGoHereNext(row.__item);
  });
  row.querySelector(".qn-btn").addEventListener("click", (e) => {
    e.stopPropagation(); setQueueNext(row.__item);
  });

  if (!expanded) attachDrag(row);
  return row;
}

function placeholderArt() {
  const d = document.createElement("div");
  d.className = "art placeholder"; d.textContent = "♪";
  return d;
}

function ghostQueueNextEl(it) {
  const row = document.createElement("div");
  row.className = "row ghost-row";
  // Note: no __item so DOM-reuse map ignores it
  row.innerHTML = `
    <div class="ghost-indent"></div>
    <img class="art" alt="">
    <div class="meta">
      <div class="title">${esc(it.title)}</div>
      <div class="artist">${esc(it.artist)}</div>
    </div>
    <button class="row-act qn-btn active" title="Queue Next">+</button>
    <span class="dur">${it.duration_human}</span>`;
  const img = row.querySelector(".art");
  img.src = it.art_url;
  img.onerror = () => { img.replaceWith(placeholderArt()); };
  row.querySelector(".qn-btn").addEventListener("click", (e) => {
    e.stopPropagation(); setQueueNext(it);
  });
  return row;
}

function dividerEl(it, editing) {
  const el = document.createElement("div");
  el.className = "divider" + (state.selection.has(it.id) ? " selected" : "");
  el.draggable = !editing && !expanded;
  el.dataset.id = it.id;

  const checked = state.selection.has(it.id) ? "checked" : "";
  const labelHtml = editing
    ? `<input class="label-input" value="${esc(it.name)}">`
    : `<span class="label">${esc(it.name)}</span>`;
  el.innerHTML = `
    <input type="checkbox" class="chk" ${checked}>
    <div class="line"></div>
    ${labelHtml}
    <div class="line"></div>`;

  el.querySelector(".chk").addEventListener("click", (e) => {
    e.stopPropagation(); toggleSelect(it.id, e);
  });

  if (editing) {
    const inp = el.querySelector(".label-input");
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    const commit = async () => {
      const name = inp.value.trim() || it.name;
      if (name !== it.name) {
        await api("PUT", "/api/divider", { playlist: state.current, id: it.id, name });
        state.selection.clear();
        await loadItems();
        loadPlaylists();
      }
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { state.selection.clear(); renderItems(); }
    });
    inp.addEventListener("blur", commit);
  } else {
    el.querySelector(".label").addEventListener("dblclick", () => {
      state.selection.clear(); state.selection.add(it.id); renderItems();
    });
    if (!expanded) attachDrag(el);
  }
  return el;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ----------------------------------------------------------- selection */
function toggleSelect(id, e) {
  if (e && e.shiftKey && state.lastSelectedId) {
    const idx1 = state.items.findIndex((x) => x.id === state.lastSelectedId);
    const idx2 = state.items.findIndex((x) => x.id === id);
    if (idx1 !== -1 && idx2 !== -1) {
      const min = Math.min(idx1, idx2);
      const max = Math.max(idx1, idx2);
      const targetState = !state.selection.has(id);
      for (let i = min; i <= max; i++) {
        if (targetState) state.selection.add(state.items[i].id);
        else state.selection.delete(state.items[i].id);
      }
      state.lastSelectedId = id;
      renderItems();
      return;
    }
  }

  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.lastSelectedId = id;
  renderItems();
}

/* ------------------------------------------------------- drag and drop */
let dragSet = [];          // ids being dragged
let dropRefId = null;      // insert before this id
let dropAtEnd = false;

function attachDrag(el) {
  el.__dragAttached = true;
  el.addEventListener("dragstart", (e) => {
    const id = el.dataset.id;
    // if the grabbed item is part of a multi-selection, drag the whole set
    if (state.selection.has(id) && state.selection.size > 0) {
      dragSet = state.items.filter((x) => state.selection.has(x.id)).map((x) => x.id);
    } else {
      dragSet = [id];
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    requestAnimationFrame(() => el.classList.add("dragging"));
  });
  el.addEventListener("dragend", () => {
    dragSet = []; clearMarkers();
    document.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
  });
}

const songList = $("song-list");
songList.addEventListener("dragover", (e) => {
  if (!dragSet.length) return;
  e.preventDefault();
  clearMarkers();
  const rows = [...songList.children].filter((n) => !dragSet.includes(n.dataset.id));
  dropRefId = null; dropAtEnd = false;
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      r.classList.add("drop-before"); dropRefId = r.dataset.id; return;
    }
  }
  if (rows.length) { rows[rows.length - 1].classList.add("drop-after"); dropAtEnd = true; }
});
songList.addEventListener("drop", (e) => {
  if (!dragSet.length) return;
  e.preventDefault();
  reorderWithin();
});
function clearMarkers() {
  songList.querySelectorAll(".drop-before,.drop-after")
    .forEach((n) => n.classList.remove("drop-before", "drop-after"));
}

async function reorderWithin() {
  const moving = state.items.filter((x) => dragSet.includes(x.id));
  const remaining = state.items.filter((x) => !dragSet.includes(x.id));
  let pos = remaining.length;
  if (!dropAtEnd && dropRefId) {
    const idx = remaining.findIndex((x) => x.id === dropRefId);
    if (idx >= 0) pos = idx;
  }
  const newItems = [...remaining.slice(0, pos), ...moving, ...remaining.slice(pos)];
  const order = newItems.map((x) => x.id);
  clearMarkers();
  await api("POST", "/api/reorder", { playlist: state.current, order });
  await loadItems();
  loadPlaylists();
}

async function moveToPlaylist(target) {
  if (!dragSet.length || target === state.current) { dragSet = []; return; }
  const items = state.items
    .filter((x) => dragSet.includes(x.id))
    .map((x) => ({ playlist: state.current, id: x.id }));
  // if the playing song is among them, follow it to the new playlist
  const movedSigs = state.items.filter((x) => dragSet.includes(x.id)).map(sigOf);
  if (state.playing && movedSigs.includes(state.playing.sig)) {
    state.playing.item.playlist = target;
  }
  dragSet = [];
  await api("POST", "/api/move", { to_playlist: target, items });
  await loadItems();
  await loadPlaylists();
  toast(`Moved ${items.length} item${items.length === 1 ? "" : "s"} to “${target}”.`);
}

/* --------------------------------------------------------------- player */
function playSong(it) {
  abortTransition();
  transState.armed         = false;
  transState.plannedDur    = null;
  transState.triggerAt     = null;
  transState.dipTime       = null;
  transState.dipAnalyzing  = false;
  transState.manualTriggerAt = (it.transition_point != null) ? it.transition_point : null;
  transState.manualStartAt   = (it.start_point != null) ? it.start_point : null;

  initWebAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  state.playing = { sig: sigOf(it), item: it };
  audio.src = it.audio_url;
  audio.play().catch(() => {});

  // Seek to custom start point when shorten is on
  if ($('shorten-enabled').checked && transState.manualStartAt !== null) {
    const _startAt = transState.manualStartAt;
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = _startAt;
    } else {
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = _startAt; }, { once: true });
    }
  }

  // Start waveform + dip analysis immediately (always, for waveform display).
  // If cached, reuse without re-fetching.
  const _sig = sigOf(it);
  if (waveformCache.has(_sig)) {
    const cached = waveformCache.get(_sig);
    transState.dipTime = cached.dipTime ?? null;
    // Draw after renderPlayer makes the canvas visible
    setTimeout(() => drawWaveform(_sig), 20);
  } else {
    transState.dipAnalyzing = true;
    analyzeDipTime(it).then((t) => {
      transState.dipAnalyzing = false;
      if (!state.playing || state.playing.sig !== _sig) return;
      transState.dipTime = t;
      drawWaveform(_sig);
      // If no transition_point was in metadata, save the calculated dip now
      if (transState.manualTriggerAt === null && t !== null) {
        transState.manualTriggerAt = t;
        it.transition_point = t;
        api("POST", "/api/transition-point", { playlist: it.playlist, id: it.id, time: t }).catch(() => {});
        // Apply to trigger when shorten is on and playhead hasn't passed it
        if ($("shorten-enabled").checked && !transState.active && !transState.armed && t > audio.currentTime) {
          transState.triggerAt = t;
        }
      }
    }).catch(() => { transState.dipAnalyzing = false; });
  }

  // Set a tiny timeout so the browser prioritizes network resources
  // for downloading the MP3 GET request before any potential DOM rebuilds
  // queue up heavy artwork GET requests.
  setTimeout(() => {
    renderPlayer();
    drawWaveform(_sig);
    updateNextPreview();
    renderItems();
    loadOccurrences(it);
  }, 10);
}

function renderPlayer() {
  const p = state.playing;
  if (!p) { $("player-empty").style.display = ""; $("player-body").style.display = "none"; return; }
  const it = p.item;
  $("player-empty").style.display = "none";
  $("player-body").style.display = "flex";
  $("np-pl").textContent = it.playlist;
  $("np-title").textContent = it.title;
  $("np-artist").textContent = it.artist;

  const cover = $("np-cover");
  cover.classList.remove("placeholder"); cover.textContent = "";
  cover.src = it.art_url;
  cover.onerror = () => { cover.removeAttribute("src"); cover.classList.add("placeholder"); cover.textContent = "♪"; };

  // emoji chooser
  const opts = $("emoji-opts");
  opts.innerHTML = "";
  for (const em of EMOJIS) {
    const b = document.createElement("div");
    b.className = "opt" + (it.emoji === em ? " active" : "");
    b.textContent = em;
    b.addEventListener("click", () => setEmoji(em));
    opts.appendChild(b);
  }
  if (!expanded) renderPlaylists();
  updateScrollPip();
  updateControlsRow();
}

async function loadOccurrences(it) {
  $("np-occ").textContent = "";
  try {
    const r = await api("GET",
      `/api/artist-occurrences?artist=${encodeURIComponent(it.artist)}`
      + `&playlist=${encodeURIComponent(it.playlist)}&id=${encodeURIComponent(it.id)}`);
    if (r.total > 0 && state.playing && state.playing.sig === sigOf(it)) {
      $("np-occ").textContent = r.text + ".";
    }
  } catch (_) {}
}

async function setEmoji(em) {
  const p = state.playing;
  if (!p) return;
  const it = p.item;
  if (it.emoji === em) return;
  const wasPlaying = !audio.paused;
  const t = audio.currentTime;
  
  const res = await api("POST", "/api/emoji", { playlist: it.playlist, id: it.id, emoji: em });
  it.emoji = em; it.id = res.id;
  it.audio_url = `/api/audio/${encodeURIComponent(it.playlist)}/${encodeURIComponent(res.id)}`;
  it.art_url = `/api/art/${encodeURIComponent(it.playlist)}/${encodeURIComponent(res.id)}`;
  
  const selectedSongs = selectedItems().filter(x => x.type === "song" && x.id !== p.item.id);
  if (selectedSongs.length > 0 && state.selection.size > 1) {
    await Promise.all(selectedSongs.map(s => 
      api("POST", "/api/emoji", { playlist: s.playlist, id: s.id, emoji: em })
    ));
  }

  swapAudio(it.audio_url, t, wasPlaying);
  renderPlayer();
  if (it.playlist === state.current) await loadItems();
}

function swapAudio(url, time, resume) {
  audio.src = url;
  audio.addEventListener("loadedmetadata", function once() {
    audio.removeEventListener("loadedmetadata", once);
    try { audio.currentTime = time; } catch (_) {}
    if (resume) audio.play().catch(() => {});
  });
}

/* keep the "playing" highlight + emoji in sync after a reload renamed files */
function resyncPlaying() {
  const p = state.playing;
  if (!p || p.item.playlist !== state.current) return;
  const match = state.items.find((x) => x.type === "song" && sigOf(x) === p.sig);
  if (match) {
    const wasPlaying = !audio.paused;
    const t = audio.currentTime;
    const newUrl = location.origin + match.audio_url;
    if (audio.src !== newUrl) swapAudio(match.audio_url, t, wasPlaying);
    p.item = match;
    renderPlayer();
  }
}

async function advance(dir) {
  const p = state.playing;
  if (!p) return;

  if (dir > 0) {
    // Go Here Next intercept
    if (queueState.mode === "goHereNext" && queueState.item) {
      const target = queueState.item;
      clearQueueState();
      playSong(target);
      return;
    }
    // Queue Next intercept
    if (queueState.mode === "queueNext" && queueState.item) {
      const target = queueState.item;
      const wasQueued = queueState.playingQueued;
      queueState.mode = null;
      queueState.item = null;
      if (!wasQueued) {
        queueState.returnTo = await getNaturalNextSong();
        queueState.playingQueued = true;
      }
      playSong(target);
      return;
    }
    // Return to natural position after queued song finishes
    if (queueState.playingQueued) {
      const target = queueState.returnTo;
      clearQueueState();
      if (target) { playSong(target); return; }
      // fall through to natural advance if no returnTo
    }
  }

  // fetch the freshest copy of the playing playlist (filenames may have changed)
  let items;
  if (p.item.playlist === state.current) items = state.items;
  else items = (await api("GET", `/api/playlists/${encodeURIComponent(p.item.playlist)}`)).items;

  const idx = items.findIndex((x) => x.type === "song" && sigOf(x) === p.sig);
  if (idx < 0) return;
  let i = idx + dir;
  while (i >= 0 && i < items.length) {
    if (items[i].type === "song") { playSong(items[i]); return; }
    i += dir;
  }
  // If advancing forward past the end, try the next linked playlist
  if (dir > 0) {
    const nextPl = nextLinkedPlaylist(p.item.playlist);
    if (nextPl) {
      try {
        const nextData = await api("GET", `/api/playlists/${encodeURIComponent(nextPl)}`);
        const firstSong = nextData.items.find(x => x.type === "song");
        if (firstSong) { playSong(firstSong); return; }
      } catch (_) {}
    }
  }
}

/* transport + scrubber */
function onAudioPlay()  { $("play-btn").textContent = "⏸"; }
function onAudioPause() { $("play-btn").textContent = "▶"; }

async function advanceAndPause() {
  let next;
  if (queueState.mode === "goHereNext" && queueState.item) {
    next = queueState.item;
    clearQueueState();
  } else if (queueState.mode === "queueNext" && queueState.item) {
    next = queueState.item;
    const wasQueued = queueState.playingQueued;
    queueState.mode = null;
    queueState.item = null;
    if (!wasQueued) {
      queueState.returnTo = await getNaturalNextSong();
      queueState.playingQueued = true;
    }
  } else if (queueState.playingQueued) {
    next = queueState.returnTo;
    clearQueueState();
    if (!next) next = await getNaturalNextSong();
  } else {
    next = await getNaturalNextSong();
  }
  if (!next) return;
  abortTransition();
  initWebAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  state.playing = { sig: sigOf(next), item: next };
  audio.src = next.audio_url;
  // Disable fade-to-pause now that we've consumed it
  fadeToPause = false;
  $("fade-pause-btn").classList.remove("active");
  // Don't call audio.play() — stay paused at position 0
  setTimeout(() => {
    renderPlayer();
    updateNextPreview();
    renderItems();
    loadOccurrences(next);
  }, 10);
}

function toggleFadeToPause() {
  fadeToPause = !fadeToPause;
  $("fade-pause-btn").classList.toggle("active", fadeToPause);
  if (fadeToPause && (transState.active || transState.armed)) abortTransition();
  updateNextPreview();
}

function onAudioEnded() {
  if (transState.active) return;
  if (fadeToPause) { advanceAndPause(); return; }
  advance(+1);
}
function onAudioTimeUpdate() {
  const d = audio.duration || 0;
  $("scrub-fill").style.width = d ? `${(audio.currentTime / d) * 100}%` : "0%";
  $("t-cur").textContent = fmt(audio.currentTime);
  $("t-dur").textContent = fmt(d);

  // Compute plannedDur as soon as we have a valid duration (stable random value per song)
  if (d > 0 && isFinite(d) && state.playing && transState.plannedDur === null
      && !transState.active && !transState.armed) {
    transState.plannedDur = computeTransitionDuration(state.playing.item);

    if ($("shorten-enabled").checked && transState.manualTriggerAt !== null) {
      // Use stored transition point (always in metadata)
      transState.triggerAt = (transState.manualTriggerAt > audio.currentTime)
        ? transState.manualTriggerAt
        : d - transState.plannedDur;
    } else {
      // Natural end trigger (also used as fallback when manualTriggerAt not yet set)
      transState.triggerAt = d - transState.plannedDur;
      if ($("shorten-enabled").checked && !transState.dipAnalyzing && transState.manualTriggerAt === null) {
        // Fallback: analysis wasn't started in playSong (e.g. song changed via transition)
        transState.dipAnalyzing = true;
        const _item = state.playing.item;
        const _sig  = state.playing.sig;
        analyzeDipTime(_item).then((t) => {
          transState.dipAnalyzing = false;
          if (!state.playing || state.playing.sig !== _sig) return;
          transState.dipTime = t;
          drawWaveform(_sig);
          if (t !== null && transState.manualTriggerAt === null) {
            transState.manualTriggerAt = t;
            _item.transition_point = t;
            api("POST", "/api/transition-point", { playlist: _item.playlist, id: _item.id, time: t }).catch(() => {});
            if ($("shorten-enabled").checked && !transState.active && !transState.armed && t > audio.currentTime) {
              transState.triggerAt = t;
            }
          }
        }).catch(() => { transState.dipAnalyzing = false; });
      }
    }
  }

  // Update transition marker — always purple, position depends on shorten state
  const marker = $("scrub-marker");
  const tpChip = $("transition-point-chip");
  if (!fadeToPause && $("transition-enabled").checked && d > 0 && isFinite(d) && !transState.active) {
    const markerTime = ($("shorten-enabled").checked && transState.manualTriggerAt !== null)
      ? transState.manualTriggerAt
      : (transState.triggerAt !== null ? transState.triggerAt : d - (transState.plannedDur || 30));
    marker.style.left = `${(markerTime / d) * 100}%`;
    marker.style.display = "";
    marker.classList.remove("manual"); // always purple
    if (tpChip && state.playing && $("shorten-enabled").checked) {
      tpChip.textContent = fmt(markerTime);
      tpChip.style.display = "";
    } else if (tpChip) {
      tpChip.style.display = "none";
    }
  } else {
    marker.style.display = "none";
    if (tpChip) tpChip.style.display = "none";
  }

  // Update start point marker — only when shorten is on
  const startMarker = $("start-marker");
  if ($("shorten-enabled").checked && transState.manualStartAt !== null && d > 0 && isFinite(d)) {
    startMarker.style.left = `${(transState.manualStartAt / d) * 100}%`;
    startMarker.style.display = "";
  } else {
    startMarker.style.display = "none";
  }

  // DJ transition arm: trigger when playhead reaches triggerAt
  if (!transState.armed && !transState.active && d > 0 && isFinite(d) && state.playing) {
    if (!fadeToPause && $("transition-enabled").checked && transState.triggerAt !== null) {
      if (audio.currentTime >= transState.triggerAt) {
        transState.armed = true;
        getNextSong().then((next) => {
          if (next && transState.armed && !transState.active) startTransition(next);
          else transState.armed = false;
        });
      }
    }
  }
}

function reattachAudioListeners(oldEl) {
  oldEl.removeEventListener("play",       onAudioPlay);
  oldEl.removeEventListener("pause",      onAudioPause);
  oldEl.removeEventListener("ended",      onAudioEnded);
  oldEl.removeEventListener("timeupdate", onAudioTimeUpdate);
  audio.addEventListener("play",       onAudioPlay);
  audio.addEventListener("pause",      onAudioPause);
  audio.addEventListener("ended",      onAudioEnded);
  audio.addEventListener("timeupdate", onAudioTimeUpdate);
}

$('play-btn').addEventListener("click", () => {
  if (!state.playing) return;
  if (audio.paused) {
    audio.play();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    if (transState.active && transState.remainingMs !== null) {
      // Resume paused transition: restart audiob, unsuspend AudioContext, reschedule timer
      audiob.play().catch(() => {});
      if (audioCtx) audioCtx.resume();
      transState.completeAt    = Date.now() + transState.remainingMs;
      transState.completeTimer = setTimeout(() => completeTransition(transState.nextItem), transState.remainingMs);
      transState.remainingMs   = null;
    }
  } else {
    audio.pause();
    if (transState.active) {
      // Freeze the transition: pause deck B, suspend AudioContext, store remaining time
      audiob.pause();
      if (audioCtx) audioCtx.suspend();
      clearTimeout(transState.completeTimer);
      transState.remainingMs = Math.max(0, transState.completeAt - Date.now());
    }
  }
});
$('next-btn').addEventListener("click", () => advance(+1));
$('transition-now-btn').addEventListener("click", async () => {
  if (!state.playing || transState.active || fadeToPause) return;
  if (!$('transition-enabled').checked) return;
  initWebAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  const next = await getNextSong();
  if (!next) { toast('No next song to transition to.'); return; }
  if (transState.armed) {
    // already armed — let startTransition handle it naturally
    if (!transState.active) startTransition(next);
    return;
  }
  // Compute plannedDur now if not yet set
  if (transState.plannedDur === null) {
    transState.plannedDur = computeTransitionDuration(state.playing.item);
  }
  transState.armed = true;
  startTransition(next);
});
$('prev-btn').addEventListener("click", () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  advance(-1);
});
audio.addEventListener("play",  onAudioPlay);
audio.addEventListener("pause", onAudioPause);
audio.addEventListener("ended", onAudioEnded);
audio.addEventListener("timeupdate", onAudioTimeUpdate);
$("scrub-track").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (!audio.duration) return;
  const newTime = ((e.clientX - r.left) / r.width) * audio.duration;
  // Shift+click sets the start point (when shorten is on)
  if (e.shiftKey && $("shorten-enabled").checked) {
    transState.manualStartAt = newTime;
    if (state.playing) state.playing.item.start_point = newTime;
    updateClearPointsBtn();
    api("POST", "/api/start-point", {
      playlist: state.playing.item.playlist,
      id: state.playing.item.id,
      time: newTime
    }).then(() => toast(`Start point set to ${fmt(newTime)}`)).catch(() => toast("Failed to save start point."));
    return;
  }
  // Any manual scrub cancels an in-progress or armed transition
  if (transState.active || transState.armed) abortTransition();
  audio.currentTime = newTime;
});

/* ---------------------------------------------------- add divider / song */
$("add-divider-btn").addEventListener("click", async () => {
  await api("POST", "/api/divider", { playlist: state.current, name: "New Divider" });
  await loadItems();
  loadPlaylists();
  // auto-edit the new divider (it's last)
  const last = state.items[state.items.length - 1];
  if (last && last.type === "divider") {
    state.selection.clear(); state.selection.add(last.id); renderItems();
  }
});

const modal = $("song-modal");
$("add-song-btn").addEventListener("click", () => {
  $("modal-pl").textContent = state.current;
  $("song-url").value = ""; $("song-status").textContent = "";
  $("song-status").classList.remove("err");
  modal.classList.add("show");
  setTimeout(() => $("song-url").focus(), 50);
});
$("song-cancel").addEventListener("click", () => modal.classList.remove("show"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });

async function downloadSong() {
  const url = $("song-url").value.trim();
  const status = $("song-status");
  status.classList.remove("err");
  if (!url) { status.textContent = "Paste a link first."; status.classList.add("err"); return; }
  status.innerHTML = `<span class="spinner"></span> Downloading… this can take a moment.`;
  $("song-download").disabled = true;
  try {
    await api("POST", "/api/song", { playlist: state.current, url });
    status.textContent = "Added!";
    await loadItems(); await loadPlaylists();
    setTimeout(() => modal.classList.remove("show"), 500);
    toast("Song added to “" + state.current + "”.");
  } catch (err) {
    status.textContent = err.message || "Download failed.";
    status.classList.add("err");
  } finally {
    $("song-download").disabled = false;
  }
}
$("song-download").addEventListener("click", downloadSong);
$("song-url").addEventListener("keydown", (e) => { if (e.key === "Enter") downloadSong(); });

/* --------------------------------------------------------- expand mode */
async function renderExpandedItems() {
  const myToken = ++expandRenderToken;
  const chain = getChain(state.current);
  const chainList = chain || [state.current];

  $("songs-title").innerHTML = esc(state.current || "—");
  if ($("songs-eyebrow")) $("songs-eyebrow").textContent = "Full Setlist";
  if ($("songs-desc")) $("songs-desc").style.display = "none";
  $("songs-sub").textContent = "";

  const list = $("song-list");
  const savedScroll = list.scrollTop;
  const frag = document.createDocumentFragment();

  // Pre-fetch all segment items so we can compute cross-playlist GHN fading
  const segments = [];
  for (const plName of chainList) {
    let items;
    if (plName === state.current) {
      items = state.items;
    } else {
      try {
        const data = await api("GET", `/api/playlists/${encodeURIComponent(plName)}`);
        if (myToken !== expandRenderToken) return;
        items = data.items;
      } catch (_) { items = []; }
    }
    segments.push({ plName, items });
  }
  if (myToken !== expandRenderToken) return;

  // Locate playing song and GHN target across all segments
  const _playingSig = state.playing ? state.playing.sig : null;
  const _ghnSig     = (queueState.mode === "goHereNext" && queueState.item) ? sigOf(queueState.item) : null;
  const _qnItem     = (queueState.mode === "queueNext"  && queueState.item) ? queueState.item : null;
  let playingSegIdx = -1, playingItemIdx = -1;
  let ghnSegIdx     = -1, ghnItemIdx     = -1;
  for (let si = 0; si < segments.length; si++) {
    const { items } = segments[si];
    if (_playingSig && playingSegIdx < 0) {
      const idx = items.findIndex(x => x.type === "song" && sigOf(x) === _playingSig);
      if (idx >= 0) { playingSegIdx = si; playingItemIdx = idx; }
    }
    if (_ghnSig && ghnSegIdx < 0) {
      const idx = items.findIndex(x => x.type === "song" && sigOf(x) === _ghnSig);
      if (idx >= 0) { ghnSegIdx = si; ghnItemIdx = idx; }
    }
  }
  // Cross-playlist fade: GHN must come after playing (same segment later index, or later segment)
  const crossFade = playingSegIdx >= 0 && ghnSegIdx >= 0 &&
    (ghnSegIdx > playingSegIdx || (ghnSegIdx === playingSegIdx && ghnItemIdx > playingItemIdx));

  for (let si = 0; si < segments.length; si++) {
    const { plName, items } = segments[si];

    const hdr = document.createElement("div");
    hdr.className = "divider chain-divider";
    hdr.innerHTML = `<div class="line"></div><span class="label">${esc(plName)}</span><div class="line"></div>`;
    frag.appendChild(hdr);

    for (let _ei = 0; _ei < items.length; _ei++) {
      const it = items[_ei];
      if (it.type === "divider") {
        frag.appendChild(dividerEl(it, false));
      } else {
        const sig = sigOf(it);
        const isPlaying = state.playing && sig === state.playing.sig;
        let isBetween = false;
        if (crossFade) {
          if (si === playingSegIdx && si === ghnSegIdx) {
            isBetween = _ei > playingItemIdx && _ei < ghnItemIdx;
          } else if (si === playingSegIdx) {
            isBetween = _ei > playingItemIdx;
          } else if (si === ghnSegIdx) {
            isBetween = _ei < ghnItemIdx;
          } else if (si > playingSegIdx && si < ghnSegIdx) {
            isBetween = true;
          }
        }
        const el = songEl(it);
        if (isBetween) el.classList.add("ghn-skipped");
        frag.appendChild(el);
        if (_qnItem && isPlaying) {
          frag.appendChild(ghostQueueNextEl(_qnItem));
        }
      }
    }
  }
  // Single atomic swap — old content stays visible until the new content is ready
  list.innerHTML = "";
  list.appendChild(frag);
  list.scrollTop = savedScroll;
  updateScrollPip();
}

/* -------------------------------------------------------- column layout */
function setAppColumns() {
  const app = document.querySelector('.app');
  const totalW = app.offsetWidth;
  if (!totalW) return;
  if (expanded) {
    const col2 = 520;
    const col3 = Math.max(400, totalW - col2 - 1);
    app.style.gridTemplateColumns = `0px ${col2}px ${col3}px`;
  } else {
    const col1 = 360, col3 = 480;
    const col2 = Math.max(200, totalW - col1 - col3 - 2);
    app.style.gridTemplateColumns = `${col1}px ${col2}px ${col3}px`;
  }
}

async function toggleExpand() {
  expanded = !expanded;
  const pb = $("player-body");
  const btn = $("expand-btn");
  if (expanded) {
    document.body.classList.add("expanded");
    pb.style.maxWidth = ""; // let CSS control
    btn.textContent = "⤡";
    btn.title = "Collapse view";
    btn.classList.add("active");
    setAppColumns();
    await renderExpandedItems();
    // Redraw waveform for the new (larger) track height
    setTimeout(() => { if (state.playing) drawWaveform(state.playing.sig); }, 50);
  } else {
    // Pin max-width and centering so player contents stay centered during the column animation
    pb.style.maxWidth = "540px";
    pb.style.margin = "0 auto";
    document.body.classList.remove("expanded");
    btn.textContent = "⤢";
    btn.title = "Expand view";
    btn.classList.remove("active");
    setAppColumns();
    // Release the pins once the grid column transition finishes
    const app = document.querySelector(".app");
    const onEnd = (e) => {
      if (e.propertyName !== "grid-template-columns") return;
      app.removeEventListener("transitionend", onEnd);
      pb.style.maxWidth = "";
      pb.style.margin = "";
      // Redraw waveform at normal track height
      if (state.playing) drawWaveform(state.playing.sig);
    };
    app.addEventListener("transitionend", onEnd);
    renderPlaylists();
    renderItems();
  }
}
$("expand-btn").addEventListener("click", toggleExpand);

/* --------------------------------------------------------- lock screen */
function dismissLock() {
  $("lock-modal").classList.remove("show");
}

function showLockPrompt() {
  $("lock-password").value = "";
  $("lock-status").textContent = "";
  $("lock-status").classList.remove("err");
  $("lock-modal").classList.add("show");
  setTimeout(() => $("lock-password").focus(), 50);
}

function tryUnlock() {
  if ($("lock-password").value === LOCK_PASSWORD) {
    locked = false;
    $("lock-modal").classList.remove("show");
    $("lock-btn").classList.remove("active");
    $("lock-btn").title = "Lock screen";
  } else {
    $("lock-status").textContent = "Incorrect password.";
    $("lock-status").classList.add("err");
    $("lock-password").value = "";
    setTimeout(() => $("lock-password").focus(), 0);
  }
}

// Capture-phase listener — intercepts all clicks when locked
document.addEventListener("click", (e) => {
  if (!locked) return;
  if ($("lock-modal").contains(e.target)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  showLockPrompt();
}, true);

$("fade-pause-btn").addEventListener("click", toggleFadeToPause);

$("lock-btn").addEventListener("click", () => {
  if (locked) return;
  locked = true;
  $("lock-btn").classList.add("active");
  $("lock-btn").title = "Locked — click to unlock";
});
$("lock-submit").addEventListener("click", tryUnlock);
$("lock-password").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
$("lock-password").addEventListener("input", () => {
  if ($("lock-password").value === LOCK_PASSWORD) tryUnlock();
});
$("lock-close").addEventListener("click", dismissLock);
$("lock-modal").addEventListener("click", (e) => { if (e.target === $("lock-modal")) dismissLock(); });

/* ------------------------------------------------- transition / shorten toggles */
$("transition-enabled").addEventListener("change", () => {
  const on = $("transition-enabled").checked;
  $("shorten-row").style.display = on ? "" : "none";
  $("transition-now-btn").style.display = on ? "" : "none";
  updateControlsRow();
  if (!on && $("shorten-enabled").checked) {
    $("shorten-enabled").checked = false;
    // Restore natural trigger point since transitions are now off
    const d = audio.duration || 0;
    if (transState.plannedDur !== null && d > 0 && !transState.active && !transState.armed) {
      transState.triggerAt = d - transState.plannedDur;
    }
  }
});

function onShortenToggled() {
  const on = $("shorten-enabled").checked;
  const d  = audio.duration || 0;
  updateControlsRow();
  // Redraw waveform so it renders immediately and marker/chip reposition on next tick
  if (state.playing) drawWaveform(state.playing.sig);
  // Refresh lists so shortened durations appear/disappear
  renderItems();
  renderPlaylists();
  if (!on) {
    // Restore the natural d - plannedDur trigger point
    if (transState.plannedDur !== null && d > 0 && !transState.active && !transState.armed) {
      transState.triggerAt = d - transState.plannedDur;
    }
    return;
  }
  // Turning on — only touches the current song if a transition isn't already in flight
  if (!state.playing || transState.active || transState.armed) return;
  // manualTriggerAt is always stored dip; if present, apply directly
  if (transState.manualTriggerAt !== null) {
    if (transState.manualTriggerAt > audio.currentTime) {
      transState.triggerAt = transState.manualTriggerAt;
    }
    return;
  }
  // No stored point yet — analysis may still be running; kick one off if not
  if (!transState.dipAnalyzing && transState.plannedDur !== null) {
    transState.dipAnalyzing = true;
    const _item = state.playing.item;
    const _sig  = state.playing.sig;
    analyzeDipTime(_item).then((t) => {
      transState.dipAnalyzing = false;
      if (!state.playing || state.playing.sig !== _sig) return;
      transState.dipTime = t;
      drawWaveform(_sig);
      if (t !== null && transState.manualTriggerAt === null) {
        transState.manualTriggerAt = t;
        _item.transition_point = t;
        api("POST", "/api/transition-point", { playlist: _item.playlist, id: _item.id, time: t }).catch(() => {});
        if ($("shorten-enabled").checked && !transState.active && !transState.armed && t > audio.currentTime) {
          transState.triggerAt = t;
        }
      }
    }).catch(() => { transState.dipAnalyzing = false; });
  }
  // If dipAnalyzing is already running, the .then() callback will apply
  // the dip once it completes. If plannedDur is null (song just started),
  // the onAudioTimeUpdate path will handle it when plannedDur is computed.
}
$("shorten-enabled").addEventListener("change", onShortenToggled);

/* --------------------------------------------------- add in-point */
$("add-in-point-btn").addEventListener("click", async () => {
  if (!state.playing || !audio.duration) return;
  const it = state.playing.item;
  const newTime = audio.currentTime;
  transState.manualStartAt = newTime;
  it.start_point = newTime;
  updateControlsRow();
  api("POST", "/api/start-point", { playlist: it.playlist, id: it.id, time: newTime })
    .then(() => toast(`Start point set to ${fmt(newTime)}`))
    .catch(() => toast("Failed to save start point."));
});

/* --------------------------------------------------- clear in-point by clicking chip */
$("start-point-chip").addEventListener("click", async () => {
  if (!state.playing) return;
  transState.manualStartAt = null;
  $("start-marker").style.display = "none";
  const it = state.playing.item;
  it.start_point = null;
  updateControlsRow();
  try {
    await api("POST", "/api/start-point", { playlist: it.playlist, id: it.id, time: null });
    toast("Start point cleared.");
  } catch (_) { toast("Failed to clear start point."); }
});

/* ------------------------------------------------- quick intro toggle */
$("quick-intro-btn").addEventListener("click", async () => {
  if (!state.playing) return;
  const it = state.playing.item;
  const newVal = !it.quick_intro;
  it.quick_intro = newVal;
  $("quick-intro-btn").classList.toggle("active", newVal);
  try {
    await api("POST", "/api/quick-intro", { playlist: it.playlist, id: it.id, value: newVal });
    toast(newVal ? "⚡ Quick intro on" : "Quick intro off");
  } catch (_) {
    it.quick_intro = !newVal;
    $("quick-intro-btn").classList.toggle("active", !newVal);
    toast("Failed to save.");
  }
});

/* -------------------------------------------------- long outro toggle */
$("long-outro-btn").addEventListener("click", async () => {
  if (!state.playing) return;
  const it = state.playing.item;
  const newVal = !it.long_outro;
  it.long_outro = newVal;
  $("long-outro-btn").classList.toggle("active", newVal);
  try {
    await api("POST", "/api/long-outro", { playlist: it.playlist, id: it.id, value: newVal });
    toast(newVal ? "🎶 Long outro on" : "Long outro off");
  } catch (_) {
    it.long_outro = !newVal;
    $("long-outro-btn").classList.toggle("active", !newVal);
    toast("Failed to save.");
  }
});

/* --------------------------------------------------------- global search */
$("global-search").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const query = e.target.value.trim().toLowerCase();
  e.target.value = "";
  if (!query) return;

  const playlists = await api("GET", "/api/playlists");
  const hits = [];
  for (const pl of playlists) {
    const data = await api("GET", `/api/playlists/${encodeURIComponent(pl.name)}`);
    const found = data.items.some(
      (it) => it.type === "song" &&
        (it.title.toLowerCase().includes(query) || it.artist.toLowerCase().includes(query))
    );
    if (found) hits.push(pl.name);
  }

  if (hits.length === 0) {
    toast(`No matches for "${query}"`);
  } else {
    toast(`"${query}" in: ${hits.join(", ")}`);
  }
});

/* ---------------------------------------------------- draggable transition marker */
function initScrubMarkerDrag() {
  const marker = $("scrub-marker");
  const track  = $("scrub-track");
  let dragging  = false;
  let didDrag   = false;   // true if pointermove fired during a drag

  marker.addEventListener("pointerdown", (e) => {
    if (!state.playing || !audio.duration || !$("transition-enabled").checked) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    didDrag  = false;
    marker.setPointerCapture(e.pointerId);
  });

  marker.addEventListener("pointermove", (e) => {
    if (!dragging || !audio.duration) return;
    didDrag = true;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = ratio * audio.duration;
    transState.triggerAt = newTime;
    transState.manualTriggerAt = newTime;
    marker.style.left = `${ratio * 100}%`;
    marker.classList.add("manual");
  });

  // Suppress the click that the browser fires on the track after a drag ends
  marker.addEventListener("click", (e) => {
    if (didDrag) { e.stopPropagation(); didDrag = false; }
  });

  marker.addEventListener("pointerup", async (e) => {
    if (!dragging) return;
    dragging = false;
    marker.releasePointerCapture(e.pointerId);
    if (transState.manualTriggerAt === null || !state.playing) return;
    const it = state.playing.item;
    try {
      await api("POST", "/api/transition-point", {
        playlist: it.playlist, id: it.id, time: transState.manualTriggerAt
      });
      it.transition_point = transState.manualTriggerAt;
      updateClearPointsBtn();
      toast(`Transition point set to ${fmt(transState.manualTriggerAt)}`);
    } catch (_) { toast("Failed to save transition point."); }
  });

  // Double-click the marker to reset to fresh dip analysis
  marker.addEventListener("dblclick", async (e) => {
    e.stopPropagation();
    if (!state.playing) return;
    const it  = state.playing.item;
    const _sig = state.playing.sig;
    transState.dipAnalyzing = true;
    const t = await analyzeDipTime(it).catch(() => null);
    transState.dipAnalyzing = false;
    if (!state.playing || state.playing.sig !== _sig) return;
    transState.dipTime = t;
    drawWaveform(_sig);
    if (t !== null) {
      transState.manualTriggerAt = t;
      it.transition_point = t;
      const d = audio.duration || 0;
      if ($("shorten-enabled").checked && !transState.active && !transState.armed && t > audio.currentTime) {
        transState.triggerAt = t;
      }
      updateClearPointsBtn();
      try {
        await api("POST", "/api/transition-point", { playlist: it.playlist, id: it.id, time: t });
        toast(`Transition point reset to ${fmt(t)}`);
      } catch (_) {}
    }
  });

  /* ---- start-point marker drag ---- */
  const startMarker = $("start-marker");
  let draggingStart = false;
  let didDragStart  = false;

  startMarker.addEventListener("pointerdown", (e) => {
    if (!state.playing || !audio.duration || !$("shorten-enabled").checked) return;
    e.preventDefault();
    e.stopPropagation();
    draggingStart = true;
    didDragStart  = false;
    startMarker.setPointerCapture(e.pointerId);
  });

  startMarker.addEventListener("pointermove", (e) => {
    if (!draggingStart || !audio.duration) return;
    didDragStart = true;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = ratio * audio.duration;
    transState.manualStartAt = newTime;
    startMarker.style.left = `${ratio * 100}%`;
  });

  startMarker.addEventListener("click", (e) => {
    if (didDragStart) { e.stopPropagation(); didDragStart = false; }
  });

  startMarker.addEventListener("pointerup", async (e) => {
    if (!draggingStart) return;
    draggingStart = false;
    startMarker.releasePointerCapture(e.pointerId);
    if (transState.manualStartAt === null || !state.playing) return;
    const it = state.playing.item;
    it.start_point = transState.manualStartAt;
    updateClearPointsBtn();
    try {
      await api("POST", "/api/start-point", {
        playlist: it.playlist, id: it.id, time: transState.manualStartAt
      });
      toast(`Start point set to ${fmt(transState.manualStartAt)}`);
    } catch (_) { toast("Failed to save start point."); }
  });

  // Double-click start marker to clear it
  startMarker.addEventListener("dblclick", async (e) => {
    e.stopPropagation();
    if (!state.playing) return;
    transState.manualStartAt = null;
    startMarker.style.display = "none";
    const it = state.playing.item;
    it.start_point = null;
    updateClearPointsBtn();
    try {
      await api("POST", "/api/start-point", { playlist: it.playlist, id: it.id, time: null });
      toast("Start point cleared.");
    } catch (_) {}
  });
}

/* ------------------------------------------------------------- startup */
setAppColumns();
window.addEventListener('resize', () => {
  setAppColumns();
  if (state.playing) drawWaveform(state.playing.sig);
});
initScrubMarkerDrag();
loadPlaylists();
