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
  "End The Night": "Tuesday, Late - Wind it down.",
  "Extra Songs": "Backups",
  "Instrumentals": "Just in case.",
  "Trash": "Things to delete."
};

const EMOJIS = ["💞", "✨", "🍂", "🕺"];

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
const LOCK_PASSWORD = "1235";

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

async function getNextSong() {
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

function startTransition(nextItem) {
  if (transState.active) return;
  if (!audioCtx) initWebAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  const T   = transState.plannedDur;
  const now = audioCtx.currentTime;
  transState.active   = true;
  transState.duration = T;
  transState.nextItem = nextItem;

  // -- Deck A out: HPF sweeps bass away, gain S-curves to 0 --
  hpfA.frequency.cancelScheduledValues(now);
  hpfA.frequency.setValueAtTime(20, now);
  hpfA.frequency.exponentialRampToValueAtTime(500,  now + T * 0.55);
  hpfA.frequency.exponentialRampToValueAtTime(3500, now + T);

  gainA.gain.cancelScheduledValues(now);
  gainA.gain.setValueAtTime(1.0, now);
  gainA.gain.setValueAtTime(1.0, now + T * 0.18);   // hold full briefly
  gainA.gain.linearRampToValueAtTime(0.5, now + T * 0.6);
  gainA.gain.linearRampToValueAtTime(0.0, now + T * 0.95);

  // Outgoing track drifts slightly faster (classic DJ spin-out)
  const rampStart = Date.now(), rampMs = T * 750;
  const rateInterval = setInterval(() => {
    const t = Date.now() - rampStart;
    if (t >= rampMs || !transState.active) { clearInterval(rateInterval); return; }
    audio.playbackRate = 1 + (t / rampMs) * 0.09;
  }, 50);

  // -- Deck B in: pre-load, LPF resonant sweep opens up, gain fades in --
  audiob.src = nextItem.audio_url;
  audiob.volume = 1;
  audiob.playbackRate = 1.0;
  audiob.play().catch(() => {});

  lpfB.frequency.cancelScheduledValues(now);
  lpfB.frequency.setValueAtTime(280, now);
  lpfB.frequency.setValueAtTime(280, now + T * 0.08);
  lpfB.frequency.exponentialRampToValueAtTime(2200,  now + T * 0.5);
  lpfB.frequency.exponentialRampToValueAtTime(20000, now + T * 0.78);

  gainB.gain.cancelScheduledValues(now);
  gainB.gain.setValueAtTime(0.0, now);
  gainB.gain.setValueAtTime(0.0, now + T * 0.1);
  gainB.gain.linearRampToValueAtTime(0.35, now + T * 0.38);
  gainB.gain.linearRampToValueAtTime(0.75, now + T * 0.68);
  gainB.gain.linearRampToValueAtTime(1.0,  now + T * 0.9);

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

  transState.completeTimer = setTimeout(() => completeTransition(nextItem), T * 1000);
}

function completeTransition(nextItem) {
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

  state.playing = { sig: sigOf(nextItem), item: nextItem };
  transState.armed      = false;
  transState.plannedDur = null;

  $("player").classList.remove("transitioning");
  $("scrub-fill").classList.remove("transitioning");
  $("next-preview").style.display = "none";

  renderPlayer();
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
  $("next-preview").style.display = "none";
  transState.nextItem   = null;
  transState.plannedDur = null;
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
    el.className = "playlist-tile" + (p.name === state.current ? " active" : "");
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

    el.innerHTML = `
      ${timeHtml}
      <div class="pl-name">${esc(p.name)}${descHtml}</div>
      <div class="pl-meta"><b>${p.song_count}</b> song${p.song_count===1?"":"s"} · ${p.duration_human}</div>`;
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
  $("songs-sub").textContent = pl ? `${songCount} songs · ${pl.duration_human}` : "";

  const sel = selectedItems();
  const loneDivider = sel.length === 1 && sel[0].type === "divider" ? sel[0].id : null;

  const list = $("song-list");

  // DOM reuse optimization to prevent image reloading on moves or metadata updates
  const oldSongs = new Map();
  for (const child of Array.from(list.children)) {
    if (child.classList.contains("row") && child.__item) {
      oldSongs.set(sigOf(child.__item), child);
    }
  }

  list.innerHTML = "";
  for (const it of state.items) {
    if (it.type === "divider") {
      list.appendChild(dividerEl(it, it.id === loneDivider));
    } else {
      const sig = sigOf(it);
      let el = oldSongs.get(sig);
      if (el) {
        // Reuse
        el.__item = it;
        el.dataset.id = it.id;
        el.querySelector(".pos").textContent = it.position;
        el.querySelector(".emoji").textContent = it.emoji || "";
        
        const isSelected = state.selection.has(it.id);
        el.querySelector(".chk").checked = isSelected;
        
        const isPlaying = state.playing && sig === state.playing.sig;
        el.className = "row" + (isSelected ? " selected" : "") + (isPlaying ? " playing" : "");
        list.appendChild(el);
      } else {
        list.appendChild(songEl(it));
      }
    }
  }
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
  row.innerHTML = `
    <input type="checkbox" class="chk" ${checked}>
    <span class="pos">${it.position}</span>
    <span class="emoji">${it.emoji || ""}</span>
    <img class="art" alt="">
    <div class="meta">
      <div class="title">${esc(it.title)}</div>
      <div class="artist">${esc(it.artist)}</div>
    </div>
    <span class="dur">${it.duration_human}</span>`;

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

  if (!expanded) attachDrag(row);
  return row;
}

function placeholderArt() {
  const d = document.createElement("div");
  d.className = "art placeholder"; d.textContent = "♪";
  return d;
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
  transState.armed      = false;
  transState.plannedDur = null;
  initWebAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  state.playing = { sig: sigOf(it), item: it };
  audio.src = it.audio_url;
  audio.play().catch(() => {});
  
  // Set a tiny timeout so the browser prioritizes network resources 
  // for downloading the MP3 GET request before any potential DOM rebuilds 
  // queue up heavy artwork GET requests.
  setTimeout(() => {
    renderPlayer();
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
function onAudioEnded() { if (transState.active) return; advance(+1); }
function onAudioTimeUpdate() {
  const d = audio.duration || 0;
  $("scrub-fill").style.width = d ? `${(audio.currentTime / d) * 100}%` : "0%";
  $("t-cur").textContent = fmt(audio.currentTime);
  $("t-dur").textContent = fmt(d);

  // Compute plannedDur as soon as we have a valid duration (stable random value per song)
  if (d > 0 && isFinite(d) && state.playing && transState.plannedDur === null
      && !transState.active && !transState.armed) {
    transState.plannedDur = computeTransitionDuration(state.playing.item);
  }

  // Update transition start marker
  const marker = $("scrub-marker");
  if ($("transition-enabled").checked && d > 0 && isFinite(d)
      && transState.plannedDur !== null && !transState.active) {
    const markerFrac = Math.max(0, (d - transState.plannedDur) / d);
    marker.style.left = `${markerFrac * 100}%`;
    marker.style.display = "";
  } else {
    marker.style.display = "none";
  }

  // DJ transition arm: trigger when within plannedDur seconds of end
  if (!transState.armed && !transState.active && d > 0 && isFinite(d) && state.playing) {
    if ($("transition-enabled").checked && transState.plannedDur !== null) {
      const remaining = d - audio.currentTime;
      if (remaining > 0 && remaining <= transState.plannedDur) {
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
  if (audio.paused) audio.play(); else audio.pause();
});
$('next-btn').addEventListener("click", () => advance(+1));
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
  list.innerHTML = "";

  for (const plName of chainList) {
    const hdr = document.createElement("div");
    hdr.className = "divider chain-divider";
    hdr.innerHTML = `<div class="line"></div><span class="label">${esc(plName)}</span><div class="line"></div>`;
    list.appendChild(hdr);

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
    for (const it of items) {
      if (it.type === "divider") {
        list.appendChild(dividerEl(it, false));
      } else {
        list.appendChild(songEl(it));
      }
    }
  }
}

async function toggleExpand() {
  expanded = !expanded;
  document.body.classList.toggle("expanded", expanded);
  const pb = $("player-body");
  const btn = $("expand-btn");
  if (expanded) {
    pb.style.justifyContent = "flex-start";
    btn.textContent = "⤡";
    btn.title = "Collapse view";
    btn.classList.add("active");
    await renderExpandedItems();
  } else {
    pb.style.justifyContent = "center";
    btn.textContent = "⤢";
    btn.title = "Expand view";
    btn.classList.remove("active");
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

$("lock-btn").addEventListener("click", () => {
  if (locked) return;
  locked = true;
  $("lock-btn").classList.add("active");
  $("lock-btn").title = "Locked — click to unlock";
});
$("lock-submit").addEventListener("click", tryUnlock);
$("lock-password").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
$("lock-close").addEventListener("click", dismissLock);
$("lock-modal").addEventListener("click", (e) => { if (e.target === $("lock-modal")) dismissLock(); });

/* ------------------------------------------------------------- startup */
loadPlaylists();
