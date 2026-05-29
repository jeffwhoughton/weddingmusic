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
  "Trash": "Things to delete."
};

const EMOJIS = ["💞", "✨", "🍂", "🕺"];
const audio = document.getElementById("audio");

const state = {
  playlists: [],
  current: null,          // current playlist name (column 2)
  items: [],              // items of current playlist
  selection: new Set(),   // checked item ids (current playlist)
  playing: null,          // { sig, item }  -- sig is rename-stable
  lastSelectedId: null,   // id of the last checked item for shift-click
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
  for (const p of state.playlists) {
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
  }
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
  renderItems();
  resyncPlaying();
}

function selectedItems() {
  return state.items.filter((it) => state.selection.has(it.id));
}

function renderItems() {
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
  row.draggable = true;
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

  attachDrag(row);
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
  el.draggable = !editing;
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
    attachDrag(el);
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
}

/* transport + scrubber */
$("play-btn").addEventListener("click", () => {
  if (!state.playing) return;
  if (audio.paused) audio.play(); else audio.pause();
});
$("next-btn").addEventListener("click", () => advance(+1));
$("prev-btn").addEventListener("click", () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  advance(-1);
});
audio.addEventListener("play",  () => { $("play-btn").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("play-btn").textContent = "▶"; });
audio.addEventListener("ended", () => advance(+1));
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || 0;
  $("scrub-fill").style.width = d ? `${(audio.currentTime / d) * 100}%` : "0%";
  $("t-cur").textContent = fmt(audio.currentTime);
  $("t-dur").textContent = fmt(d);
});
$("scrub-track").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
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

/* ------------------------------------------------------------- startup */
loadPlaylists();
