const GOOGLE_CLIENT_ID = "465530902895-smsu60b8qvdv83ahrbr7pi7grl5cjh8b.apps.googleusercontent.com";
const DRIVE_URL = "https://www.googleapis.com/drive/v3/files/19H_bV5SUmExeeLFATTvdJV2lBPrAoaJn?alt=media&acknowledgeAbuse=true";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CACHE_DB = "playlist-studio-player-cache";
const CACHE_STORE = "archives";
const LOCK_PASSWORD = "1235";
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac", ".webm"]);
const ALLOWED_EMOJIS = ["💞", "✨", "🍂", "🕺", "🗑️"];
const GROUPS = [
  { id: "pizza", name: "Pizza Party", folders: ["Pizza Party", "Pizza Party 2"], note: "Pizza Party + Pizza Party 2" },
  { id: "dinner", name: "Cocktails / Dinner", folders: ["Cocktails + Din"], note: "Cocktails + Dinner" },
  { id: "wedding", name: "Wedding Reception", folders: ["Wedding Reception", "Reception 2", "Reception 3", "End The Night"], note: "Wedding Reception through End The Night" },
];

const state = {
  groups: [],
  selectedGroup: null,
  songs: [],
  current: null,
  currentIndex: -1,
  started: false,
  urls: new Set(),
  locked: false,
  fading: false,
};

let audioA = document.getElementById("audio-a");
let audioB = document.getElementById("audio-b");
let audioContext = null;
const audioGraphs = new Map();
const transition = { active: false, timer: null, rateTimer: null, duration: 5 };
let toastTimer;
let driveAccessToken = null;
let driveTokenExpiresAt = 0;
let tokenRequest = null;

const $ = (id) => document.getElementById(id);
const fmt = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, "0")}`;
};
const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
}[char]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedZip() {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get("playlist-zip");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeCachedZip(blob) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE)
      .put({ blob, savedAt: Date.now() }, "playlist-zip");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeCachedZip() {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).delete("playlist-zip");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function setDownloadStatus(message, progress = null) {
  $("download-status").textContent = message;
  if (progress !== null) $("download-progress").style.width = `${Math.round(progress * 100)}%`;
}

function requestDriveToken() {
  if (tokenRequest) return tokenRequest;
  tokenRequest = new Promise((resolve, reject) => {
    if (GOOGLE_CLIENT_ID.startsWith("REPLACE_WITH")) {
      reject(new Error("Add your Google OAuth client ID to player.js first."));
      return;
    }
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google Sign-In did not load. Check your connection and try again."));
      return;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error("Google authorization was cancelled or denied."));
          return;
        }
        driveAccessToken = response.access_token;
        driveTokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600) - 60) * 1000;
        resolve(driveAccessToken);
      },
    });
    client.requestAccessToken({ prompt: driveAccessToken ? "" : "consent" });
  }).finally(() => { tokenRequest = null; });
  return tokenRequest;
}

async function getDriveToken() {
  if (driveAccessToken && Date.now() < driveTokenExpiresAt) return driveAccessToken;
  return requestDriveToken();
}

async function downloadZip() {
  setDownloadStatus("Waiting for Google authorization…", 0);
  $("google-signin-button").hidden = true;
  $("download-retry").hidden = true;
  const accessToken = await getDriveToken();
  setDownloadStatus("Downloading your playlist archive…", 0);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(DRIVE_URL, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Google Drive did not respond within 45 seconds.");
    throw new Error("Could not connect to the Google Drive API.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 401) {
      driveAccessToken = null;
      driveTokenExpiresAt = 0;
      throw new Error("Google authorization expired. Sign in again.");
    }
    let message = `Google Drive returned HTTP ${response.status}.`;
    try {
      const details = await response.json();
      message = details.error?.message || message;
    } catch (_) {}
    throw new Error(message);
  }

  if (!response.body) {
    const blob = await response.blob();
    setDownloadStatus("Checking the archive…", .92);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
    received += part.value.byteLength;
    setDownloadStatus(total ? `Downloading the playlist archive… ${Math.round(received / total * 100)}%` : "Downloading the playlist archive…", total ? received / total : null);
  }
  setDownloadStatus("Checking the archive…", .92);
  return new Blob(chunks, { type: response.headers.get("content-type") || "application/zip" });
}

async function getZipBlob(allowDownload = false) {
  const cached = await readCachedZip();
  if (cached?.blob) {
    try {
      await JSZip.loadAsync(cached.blob);
      $("cache-note").textContent = `Cached ${new Date(cached.savedAt).toLocaleDateString()}`;
      setDownloadStatus("Opening the cached archive…", 1);
      return cached.blob;
    } catch (_) {
      await removeCachedZip();
    }
  }
  if (!allowDownload) {
    const error = new Error("Sign in with Google to download the playlist archive.");
    error.code = "AUTH_REQUIRED";
    throw error;
  }
  const downloaded = await downloadZip();
  await JSZip.loadAsync(downloaded);
  await writeCachedZip(downloaded);
  $("cache-note").textContent = "Cached on this device";
  return downloaded;
}

function fileSort(a, b) {
  const parse = (name) => {
    const match = name.match(/^\s*(\d+)([a-z]*)\s*-/i);
    return match ? [Number(match[1]), match[2].toLowerCase()] : [9999, ""];
  };
  const [aNumber, aLetters] = parse(a.name);
  const [bNumber, bLetters] = parse(b.name);
  return aNumber - bNumber || aLetters.localeCompare(bLetters) || a.name.localeCompare(b.name);
}

function isAudio(filename) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && AUDIO_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

function parsePosition(filename) {
  const match = filename.match(/^\s*(\d+[a-z]*)\s*-/i);
  return match ? match[1] : "";
}

function parseItem(folder, entry) {
  const filename = entry.name.split("/").pop();
  const middle = filename.replace(/^\s*\d+[a-z]*\s*-\s*/i, "");
  if (/\.txt$/i.test(filename)) {
    return { type: "divider", name: middle.replace(/\.txt$/i, ""), position: parsePosition(filename), folder };
  }
  if (!isAudio(filename)) return null;

  let rest = middle;
  let emoji = "";
  const emojiSplit = middle.split(" - ");
  if (emojiSplit.length > 1 && ALLOWED_EMOJIS.includes(emojiSplit[0].trim())) {
    emoji = emojiSplit.shift().trim();
    rest = emojiSplit.join(" - ");
  }
  rest = rest.replace(/\.[A-Za-z0-9]+$/, "");
  const separator = rest.lastIndexOf(" - ");
  const title = separator >= 0 ? rest.slice(0, separator).trim() : rest.trim();
  const artist = separator >= 0 ? rest.slice(separator + 3).trim() : "Unknown Artist";
  return {
    type: "song", name: title || "Unknown Title", artist: artist || "Unknown Artist", emoji,
    position: parsePosition(filename), filename, folder, entry, blob: null, url: null,
    artUrl: null, artBlob: null, duration: 0, transitionPoint: null, startPoint: null, waveform: null, metadataLoaded: false,
    quickIntro: false, longOutro: false, longOutroSeconds: 6, bpmOutro: false, manualBpm: null, detectedBpm: null,
  };
}

async function extractPlaylists(blob) {
  const zip = await JSZip.loadAsync(blob);
  const physicalFolders = new Set(GROUPS.flatMap((group) => group.folders));
  const entries = new Map();
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir) continue;
    const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
    const playlistIndex = parts.findIndex((part) => part.toLowerCase() === "playlists");
    const folder = playlistIndex >= 0 ? parts[playlistIndex + 1] : parts.find((part) => physicalFolders.has(part));
    if (!folder || !physicalFolders.has(folder)) continue;
    const filename = parts[parts.length - 1];
    if (!filename || !/^\s*\d+[a-z]*\s*-\s*/i.test(filename)) continue;
    if (!entries.has(folder)) entries.set(folder, []);
    entries.get(folder).push({ name: filename, zipEntry: entry });
  }

  const groups = GROUPS.map((definition) => {
    const sections = definition.folders.map((folder) => {
      const files = (entries.get(folder) || []).sort(fileSort);
      const items = files.map((file) => parseItem(folder, {
        name: file.name,
        async: file.zipEntry.async.bind(file.zipEntry),
      })).filter(Boolean);
      return { name: folder, items };
    });
    const songs = sections.flatMap((section) => section.items.filter((item) => item.type === "song"));
    songs.forEach((song, index) => { song.globalIndex = index; });
    return { ...definition, sections, songs };
  });

  return groups;
}

async function ensureBlob(item) {
  if (!item.blob) item.blob = await item.entry.async("blob");
  return item.blob;
}

function ensureUrl(item) {
  if (!item.url) {
    item.url = URL.createObjectURL(item.blob);
    state.urls.add(item.url);
  }
  return item.url;
}

function numberFromTag(tags, key) {
  const wanted = key.toUpperCase();
  const candidates = [];
  if (Array.isArray(tags?.userDefinedText)) candidates.push(...tags.userDefinedText);
  if (tags?.TXXX) candidates.push(tags.TXXX);
  const found = candidates.find((tag) => String(tag.description || "").toUpperCase() === wanted);
  const value = found?.value ?? found?.text?.[0];
  const result = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(result) ? result : null;
}

function booleanFromTag(tags, key) {
  const value = numberFromTag(tags, key);
  return value !== null && value > 0.5;
}

function loadTags(item) {
  if (item.tagsPromise) return item.tagsPromise;
  item.tagsPromise = new Promise((resolve) => {
    if (!window.jsmediatags) { resolve(null); return; }
    window.jsmediatags.read(item.blob, {
      onSuccess: (result) => resolve(result.tags || {}),
      onError: () => resolve(null),
    });
  });
  return item.tagsPromise;
}

async function loadItemMetadata(item) {
  if (item.metadataLoaded) return item;
  await ensureBlob(item);
  ensureUrl(item);
  const tags = await loadTags(item);
  if (tags) {
    item.transitionPoint = numberFromTag(tags, "PS_TRANSITION");
    item.startPoint = numberFromTag(tags, "PS_START");
    item.quickIntro = booleanFromTag(tags, "PS_QUICK_INTRO");
    item.longOutro = booleanFromTag(tags, "PS_LONG_OUTRO");
    item.longOutroSeconds = Math.max(1, Math.min(120, numberFromTag(tags, "PS_LONG_OUTRO_SECONDS") || 6));
    item.bpmOutro = booleanFromTag(tags, "PS_BPM_OUTRO");
    item.manualBpm = numberFromTag(tags, "PS_BPM");
    const pictureTag = tags.picture || tags.APIC || tags.covr;
    if (pictureTag?.data?.length) {
      const picture = new Blob([new Uint8Array(pictureTag.data)], { type: pictureTag.format || pictureTag.mime || "image/jpeg" });
      item.artBlob = picture;
    }
  }
  if (!item.duration) {
    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = item.url;
    item.duration = await new Promise((resolve) => {
      const finish = (value) => { probe.src = ""; resolve(Number.isFinite(value) ? value : 0); };
      probe.addEventListener("loadedmetadata", () => finish(probe.duration), { once: true });
      probe.addEventListener("error", () => finish(0), { once: true });
      setTimeout(() => finish(probe.duration || 0), 5000);
    });
  }
  item.metadataLoaded = true;
  return item;
}

function detectBpm(decoded) {
  const sampleRate = decoded.sampleRate;
  const windowSeconds = .023;
  const windowSize = Math.max(1, Math.floor(windowSeconds * sampleRate));
  const count = Math.min(Math.floor(decoded.length / windowSize), Math.floor(60 / windowSeconds));
  if (count < 2) return null;
  const energy = new Float32Array(count);
  for (let windowIndex = 0; windowIndex < count; windowIndex++) {
    let sum = 0;
    const start = windowIndex * windowSize;
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let sample = start; sample < start + windowSize; sample++) sum += data[sample] * data[sample];
    }
    energy[windowIndex] = Math.sqrt(sum / (windowSize * decoded.numberOfChannels));
  }
  const onset = new Float32Array(count);
  for (let index = 1; index < count; index++) onset[index] = Math.max(0, energy[index] - energy[index - 1]);
  const minLag = Math.max(1, Math.floor((60 / 180) / windowSeconds));
  const maxLag = Math.min(Math.ceil((60 / 60) / windowSeconds), count - 1);
  let bestLag = minLag;
  let bestCorrelation = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let index = 0; index + lag < count; index++) correlation += onset[index] * onset[index + lag];
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
  }
  let bpm = 60 / (bestLag * windowSeconds);
  while (bpm > 150) bpm /= 2;
  while (bpm < 75) bpm *= 2;
  return Math.round(bpm * 10) / 10;
}

function ensureArtUrl(item) {
  if (!item.artUrl && item.artBlob) {
    item.artUrl = URL.createObjectURL(item.artBlob);
    state.urls.add(item.artUrl);
  }
  return item.artUrl || "";
}

function releaseItemResources(item) {
  if (!item) return;
  if (item.url) { URL.revokeObjectURL(item.url); state.urls.delete(item.url); item.url = null; }
  item.blob = null;
  item.tagsPromise = null;
  item.metadataLoaded = false;
}

async function analyzeWaveform(item) {
  if (item.waveform || !item.duration) return;
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await context.decodeAudioData(await item.blob.arrayBuffer());
    const sampleRate = decoded.sampleRate;
    const windowSize = Math.max(1, Math.floor(sampleRate * .1));
    const count = Math.floor(decoded.length / windowSize);
    const mono = new Float32Array(count);
    for (let windowIndex = 0; windowIndex < count; windowIndex++) {
      let sum = 0;
      const start = windowIndex * windowSize;
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let sample = start; sample < start + windowSize; sample++) sum += data[sample] * data[sample];
      }
      mono[windowIndex] = Math.sqrt(sum / (windowSize * decoded.numberOfChannels));
    }
    const sorted = Array.from(mono).sort((a, b) => a - b);
    const normal = sorted[Math.floor(sorted.length * .7)] || .01;
    const normalized = new Float32Array(count);
    const p95 = sorted[Math.floor(sorted.length * .95)] || .001;
    for (let index = 0; index < count; index++) normalized[index] = Math.min(1, mono[index] / p95);
    item.waveform = { data: normalized, winSec: .1 };
    item.detectedBpm = detectBpm(decoded);

    if (item.transitionPoint === null) {
      const start = Math.floor(count * .6);
      const end = Math.min(count, Math.floor(count * .88));
      let bestScore = 0;
      let bestIndex = Math.max(start, Math.floor(count - 8 / .1));
      for (let index = start + 15; index < end - 10; index++) {
        if (mono[index] > normal * .3) continue;
        let before = 0;
        for (let scan = index - 15; scan < index; scan++) before += mono[scan];
        before /= 15;
        if (before < normal * .4) continue;
        const score = (before - mono[index]) * before;
        if (score > bestScore) { bestScore = score; bestIndex = index; }
      }
      item.transitionPoint = Math.max(item.duration * .6, Math.min(item.duration * .88, bestIndex * .1));
    }
    await context.close();
    if (state.current === item) { drawWaveform(item); updateMarkers(); }
  } catch (_) {
    item.waveform = { data: new Float32Array(0), winSec: .1 };
    if (item.transitionPoint === null) item.transitionPoint = Math.max(0, item.duration - 8);
  }
}

function setImage(image, url) {
  if (url) image.src = url;
  else image.removeAttribute("src");
  image.classList.toggle("placeholder", !url);
}

function drawWaveform(item) {
  const canvas = $("waveform-canvas");
  const track = $("scrub-track");
  const width = track.clientWidth;
  const height = track.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!item?.waveform?.data?.length) return;
  const data = item.waveform.data;
  const bars = Math.max(1, Math.floor(canvas.width / (3 * ratio)));
  const barWidth = canvas.width / bars;
  const duration = item.duration || 0;
  const inPoint = item.startPoint === null ? 0 : Math.max(0, item.startPoint);
  const outPoint = item.transitionPoint === null ? duration : Math.max(inPoint, Math.min(duration, item.transitionPoint));
  for (let index = 0; index < bars; index++) {
    const value = data[Math.min(data.length - 1, Math.floor(index / bars * data.length))] || 0;
    const barHeight = Math.max(ratio, value * canvas.height * .86);
    const time = (index + .5) / bars * duration;
    context.fillStyle = time < inPoint || time > outPoint
      ? "rgba(240, 215, 145, .22)"
      : "rgba(240, 215, 145, .58)";
    context.fillRect(index * barWidth, (canvas.height - barHeight) / 2, Math.max(ratio, barWidth - ratio), barHeight);
  }
}

function renderPicker() {
  const renderButton = (group) => `<button class="picker-button" data-group="${group.id}"><span><strong>${esc(group.name)}</strong><span>${esc(group.note)}</span></span><b>›</b></button>`;
  $("picker-list").innerHTML = state.groups.map(renderButton).join("");
  $("picker-list").querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => selectGroup(button.dataset.group)));
}

function renderDrawer() {
  $("drawer-playlists").innerHTML = state.groups.map((group) => `<button class="drawer-playlist${state.selectedGroup?.id === group.id ? " active" : ""}" data-group="${group.id}"><strong>${esc(group.name)}</strong><span>${esc(group.note)}</span></button>`).join("");
  $("drawer-playlists").querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => {
    selectGroup(button.dataset.group);
    closeDrawer();
  }));
}

function renderSetlist() {
  const group = state.selectedGroup;
  if (!group) return;
  const html = [];
  for (const section of group.sections) {
    html.push(`<div class="set-section">${esc(section.name)}</div>`);
    for (const item of section.items) {
      if (item.type === "divider") {
        html.push(`<div class="set-divider">${esc(item.name)}</div>`);
        continue;
      }
      const current = state.current === item ? " current" : "";
      const art = item.artUrl || "";
      html.push(`<button class="song-row${current}" data-song="${item.globalIndex}"><span class="song-number">${esc(item.position)}</span><img class="song-art"${art ? ` src="${art}"` : ""} alt=""><span class="song-meta"><span class="song-name">${esc(item.name)}</span><span class="song-artist">${esc(item.artist)}</span></span><span class="song-duration">${item.duration ? fmt(item.duration) : ""}</span></button>`);
    }
  }
  $("setlist").innerHTML = html.join("");
  $("setlist").querySelectorAll("[data-song]").forEach((row) => row.addEventListener("click", () => playSong(group.songs[Number(row.dataset.song)], true)));
  if (state.current) {
    const currentRow = $("setlist").querySelector(`.song-row[data-song="${state.current.globalIndex}"]`);
    if (currentRow) {
      currentRow.scrollIntoView({ block: "center", behavior: "smooth" });
      requestAnimationFrame(updateScrollPip);
    }
  }
  updateScrollPip();
}

function updateScrollPip() {
  const list = $("setlist");
  const pip = $("scroll-pip");
  const currentPip = $("current-song-pip");
  if (!list || !pip || !currentPip) return;
  const range = list.scrollHeight - list.clientHeight;
  const trackRange = Math.max(0, list.clientHeight - 16 - pip.offsetHeight);
  pip.style.transform = `translateY(${range > 0 ? list.scrollTop / range * trackRange : 0}px)`;
  pip.style.opacity = range > 0 ? "1" : "0";
  const currentRow = state.current && list.querySelector(`.song-row[data-song="${state.current.globalIndex}"]`);
  const contentRange = Math.max(1, list.scrollHeight - list.clientHeight);
  const currentPosition = currentRow ? currentRow.offsetTop / contentRange : 0;
  const currentTrackRange = Math.max(0, list.clientHeight - 16 - currentPip.offsetHeight);
  currentPip.style.transform = `translateY(${Math.max(0, Math.min(1, currentPosition)) * currentTrackRange}px)`;
  currentPip.style.opacity = currentRow ? "1" : "0";
}

async function preloadArtwork(group) {
  for (const item of group.songs) {
    try {
      await ensureBlob(item);
      const tags = await loadTags(item);
      const pictureTag = tags?.picture || tags?.APIC || tags?.covr;
      if (pictureTag?.data?.length) item.artBlob = new Blob([new Uint8Array(pictureTag.data)], { type: pictureTag.format || pictureTag.mime || "image/jpeg" });
      ensureArtUrl(item);
      if (state.selectedGroup === group) {
        renderSetlist();
        if (state.current === item) setImage($("player-art"), ensureArtUrl(item));
      }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function selectInitialSong(item) {
  if (!item) return;
  try {
    await loadItemMetadata(item);
    await analyzeWaveform(item);
    if (state.current === item) updatePlayer();
    preloadTransitionMetadata(item);
  } catch (_) {}
}

async function preloadTransitionMetadata(item) {
  const next = state.songs[state.songs.indexOf(item) + 1];
  if (!next) return;
  try {
    await loadItemMetadata(next);
    await analyzeWaveform(next);
  } catch (_) {}
}

function updatePlayer() {
  const item = state.current;
  $("header-playlist").textContent = state.selectedGroup?.name || "Choose a set";
  $("player-title").textContent = item?.name || "Ready when you are";
  $("player-artist").textContent = item?.artist || "Select a song below to begin";
  setImage($("player-art"), item ? ensureArtUrl(item) : "");
  updateMediaSession();
  updatePlayButton();
  updateNextTrackLabel();
  updateMarkers();
  if (item) {
    drawWaveform(item);
    setTimeout(() => $("setlist").querySelector(`.song-row[data-song="${item.globalIndex}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
  }
}

function updateMediaSession() {
  if (!navigator.mediaSession) return;
  const item = state.current;
  navigator.mediaSession.metadata = item ? new MediaMetadata({
    title: item.name,
    artist: item.artist,
    album: state.selectedGroup?.name || "Playlist Studio",
    artwork: ensureArtUrl(item) ? [{ src: ensureArtUrl(item) }] : [],
  }) : null;
  navigator.mediaSession.playbackState = audioA.paused ? "paused" : "playing";
}

function updateMediaPosition() {
  if (!navigator.mediaSession?.setPositionState) return;
  const duration = audioA.duration || state.current?.duration || 0;
  if (duration > 0 && Number.isFinite(duration)) {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audioA.playbackRate || 1,
      position: Math.min(audioA.currentTime || 0, duration),
    });
  }
}

function updatePlayButton() {
  const button = $("play-button");
  const wrapper = $("play-button-wrap");
  const playing = state.current && !audioA.paused;
  button.textContent = playing ? "⏸" : "▶";
  wrapper.classList.toggle("is-fading", state.fading);
  if (!state.fading) wrapper.style.removeProperty("--fade-progress");
  button.setAttribute("aria-label", playing ? "Fade to pause" : "Play next track");
}

function updateNextTrackLabel() {
  const next = state.started ? getNextSong() : state.current;
  const playing = state.fading || (state.current && !audioA.paused);
  const label = $("next-track-label");
  const resume = $("resume-button");
  label.textContent = `Will Play ${next?.name || "the first track"}`;
  label.hidden = Boolean(playing);
  resume.hidden = Boolean(playing || !state.started);
}

function updateMarkers() {
  const item = state.current;
  const duration = audioA.duration || item?.duration || 0;
  const transitionMarker = $("transition-marker");
  const startMarker = $("start-marker");
  if (!item || !duration) {
    transitionMarker.style.display = "none";
    startMarker.style.display = "none";
    return;
  }
  if (item.transitionPoint !== null) {
    transitionMarker.style.display = "block";
    transitionMarker.style.left = `${Math.max(0, Math.min(100, item.transitionPoint / duration * 100))}%`;
  } else transitionMarker.style.display = "none";
  if (item.startPoint !== null) {
    startMarker.style.display = "block";
    startMarker.style.left = `${Math.max(0, Math.min(100, item.startPoint / duration * 100))}%`;
  } else startMarker.style.display = "none";
}

function setDrawer(open) {
  $("menu-drawer").classList.toggle("open", open);
  $("drawer-backdrop").classList.toggle("open", open);
  $("menu-drawer").setAttribute("aria-hidden", String(!open));
}
function closeDrawer() { setDrawer(false); }

async function selectGroup(id) {
  const group = state.groups.find((candidate) => candidate.id === id);
  if (!group) return;
  const previous = state.current;
  abortTransition();
  audioA.pause(); audioB.pause();
  releaseItemResources(previous);
  state.selectedGroup = group;
  state.songs = group.songs;
  state.current = group.songs[0] || null;
  state.currentIndex = state.current ? 0 : -1;
  state.started = false;
  $("playlist-picker").hidden = true;
  $("player-view").hidden = false;
  renderDrawer();
  renderSetlist();
  updatePlayer();
  selectInitialSong(state.current);
  preloadArtwork(group);
}

async function playSong(item, shouldPlay) {
  if (!item) return;
  const previous = state.current;
  abortTransition();
  state.fading = false;
  state.started = true;
  state.current = item;
  state.currentIndex = state.songs.indexOf(item);
  await loadItemMetadata(item);
  await analyzeWaveform(item);
  audioA.pause(); audioB.pause();
  audioA.src = ensureUrl(item);
  audioA.load();
  await new Promise((resolve) => {
    const seekToStart = () => {
      if (state.current === item && item.startPoint !== null) audioA.currentTime = item.startPoint;
      if (state.current === item) updateMarkers();
      resolve();
    };
    if (audioA.readyState >= 1) seekToStart();
    else {
      audioA.addEventListener("loadedmetadata", seekToStart, { once: true });
      audioA.addEventListener("error", resolve, { once: true });
    }
  });
  if (shouldPlay) audioA.play().catch(() => toast("Tap play to start audio."));
  if (previous && previous !== item) releaseItemResources(previous);
  renderSetlist();
  updatePlayer();
  preloadTransitionMetadata(item);
}

function getNextSong() {
  return state.currentIndex >= 0 ? state.songs[state.currentIndex + 1] || null : state.songs[0] || null;
}

function initAudioGraph() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  for (const element of [audioA, audioB]) {
    if (audioGraphs.has(element)) continue;
    const source = audioContext.createMediaElementSource(element);
    const filter = audioContext.createBiquadFilter();
    filter.type = element === audioA ? "highpass" : "lowpass";
    filter.frequency.value = element === audioA ? 20 : 280;
    filter.Q.value = element === audioA ? .5 : 2.2;
    const gain = audioContext.createGain();
    gain.gain.value = element === audioA ? 1 : 0;
    source.connect(filter).connect(gain).connect(audioContext.destination);
    audioGraphs.set(element, { filter, gain });
  }
  if (audioContext.state === "suspended") audioContext.resume();
}

function computeTransitionDuration(item) {
  const duration = item?.duration || 0;
  const base = Math.max(6, Math.min(16, duration * .06));
  return base + (Math.random() * 3 - 1.5);
}

function abortTransition() {
  if (transition.timer) clearTimeout(transition.timer);
  if (transition.rateTimer) clearInterval(transition.rateTimer);
  transition.timer = null;
  transition.rateTimer = null;
  transition.active = false;
  if (audioContext) {
    const now = audioContext.currentTime;
    const currentGraph = audioGraphs.get(audioA);
    const nextGraph = audioGraphs.get(audioB);
    currentGraph?.gain.gain.cancelScheduledValues(now);
    currentGraph?.gain.gain.setValueAtTime(1, now);
    currentGraph?.filter.frequency.cancelScheduledValues(now);
    currentGraph?.filter.frequency.setValueAtTime(20, now);
    nextGraph?.gain.gain.cancelScheduledValues(now);
    nextGraph?.gain.gain.setValueAtTime(0, now);
    nextGraph?.filter.frequency.cancelScheduledValues(now);
    nextGraph?.filter.frequency.setValueAtTime(280, now);
  }
  audioB.pause();
  audioB.removeAttribute("src");
  audioA.playbackRate = 1;
}

async function startTransition() {
  if (transition.active || !state.current) return;
  const next = getNextSong();
  if (!next) return;
  transition.active = true;
  transition.duration = computeTransitionDuration(state.current);
  initAudioGraph();
  await loadItemMetadata(next);
  if (!transition.active) return;
  audioB.src = ensureUrl(next);
  audioB.load();
  await new Promise((resolve) => {
    if (audioB.readyState >= 1) { resolve(); return; }
    audioB.addEventListener("loadedmetadata", resolve, { once: true });
    audioB.addEventListener("error", resolve, { once: true });
  });
  if (next.startPoint !== null) audioB.currentTime = next.startPoint;
  audioB.playbackRate = 1;
  await audioB.play().catch(() => {});
  const now = audioContext.currentTime;
  const currentGraph = audioGraphs.get(audioA);
  const nextGraph = audioGraphs.get(audioB);
  const currentGain = currentGraph.gain.gain;
  const nextGain = nextGraph.gain.gain;
  const currentFilter = currentGraph.filter.frequency;
  const nextFilter = nextGraph.filter.frequency;
  const currentItem = state.current;
  const hasLongOutro = currentItem.longOutro;
  const hasQuickIntro = next.quickIntro;
  const extra = hasLongOutro ? currentItem.longOutroSeconds : 0;
  const bpmA = currentItem.manualBpm || currentItem.detectedBpm;
  const bpmB = next.manualBpm || next.detectedBpm;
  const bpmRateExtra = currentItem.bpmOutro && bpmA && bpmB
    ? Math.max(.75, Math.min(1.25, bpmB / bpmA)) - 1
    : .09;

  currentGraph.filter.type = "highpass";
  nextGraph.filter.type = "lowpass";
  currentGain.cancelScheduledValues(now);
  nextGain.cancelScheduledValues(now);
  currentFilter.cancelScheduledValues(now);
  nextFilter.cancelScheduledValues(now);
  currentGain.setValueAtTime(1, now);
  nextGain.setValueAtTime(0, now);
  currentFilter.setValueAtTime(20, now);
  nextFilter.setValueAtTime(hasQuickIntro ? 20000 : 280, now);

  const cut = Math.min(transition.duration, 4);
  const outgoingEnd = hasQuickIntro
    ? (hasLongOutro ? cut + extra : cut * .8)
    : transition.duration + extra;
  if (hasQuickIntro) {
    currentFilter.exponentialRampToValueAtTime(hasLongOutro ? 400 : 300, now + cut);
    currentFilter.exponentialRampToValueAtTime(hasLongOutro ? 3500 : 5000, now + outgoingEnd);
    currentGain.linearRampToValueAtTime(hasLongOutro ? .38 : .18, now + cut);
    currentGain.linearRampToValueAtTime(0, now + outgoingEnd);
    nextGain.linearRampToValueAtTime(.45, now + .3);
    nextGain.linearRampToValueAtTime(.85, now + 1.2);
    nextGain.linearRampToValueAtTime(1, now + 2);
  } else {
    currentFilter.exponentialRampToValueAtTime(hasLongOutro ? 350 : 500, now + transition.duration * .55);
    currentFilter.exponentialRampToValueAtTime(3500, now + outgoingEnd);
    currentGain.linearRampToValueAtTime(hasLongOutro ? .55 : .5, now + transition.duration * .6);
    currentGain.linearRampToValueAtTime(hasLongOutro ? .28 : 0, now + transition.duration);
    currentGain.linearRampToValueAtTime(0, now + outgoingEnd);
    nextFilter.exponentialRampToValueAtTime(2200, now + transition.duration * .5);
    nextFilter.exponentialRampToValueAtTime(20000, now + transition.duration * .78);
    nextGain.linearRampToValueAtTime(.35, now + transition.duration * .38);
    nextGain.linearRampToValueAtTime(.75, now + transition.duration * .68);
    nextGain.linearRampToValueAtTime(1, now + transition.duration * .9);
  }

  const rateStart = Date.now();
  const rateDuration = (hasQuickIntro ? outgoingEnd : transition.duration + extra * .5) * 1000;
  transition.rateTimer = setInterval(() => {
    const elapsed = Date.now() - rateStart;
    if (elapsed >= rateDuration || !transition.active) {
      clearInterval(transition.rateTimer);
      transition.rateTimer = null;
      return;
    }
    audioA.playbackRate = 1 + (elapsed / rateDuration) * bpmRateExtra;
  }, 50);

  const completionMs = (hasQuickIntro ? cut : transition.duration) * 1000 + extra * 1000;
  transition.timer = setTimeout(() => completeTransition(next), completionMs);
}

function completeTransition(next) {
  if (!transition.active) return;
  const previous = state.current;
  transition.active = false;
  transition.timer = null;
  if (transition.rateTimer) clearInterval(transition.rateTimer);
  transition.rateTimer = null;
  const oldAudio = audioA;
  audioA = audioB;
  audioB = oldAudio;
  audioB.pause();
  audioB.removeAttribute("src");
  audioB.playbackRate = 1;
  const currentGraph = audioGraphs.get(audioA);
  const oldGraph = audioGraphs.get(audioB);
  const now = audioContext.currentTime;
  currentGraph.gain.gain.cancelScheduledValues(now);
  currentGraph.gain.gain.setValueAtTime(1, now);
  currentGraph.filter.type = "highpass";
  currentGraph.filter.frequency.cancelScheduledValues(now);
  currentGraph.filter.frequency.setValueAtTime(20, now);
  oldGraph.gain.gain.cancelScheduledValues(now);
  oldGraph.gain.gain.setValueAtTime(0, now);
  oldGraph.filter.type = "lowpass";
  oldGraph.filter.frequency.cancelScheduledValues(now);
  oldGraph.filter.frequency.setValueAtTime(280, now);
  attachAudioListeners();
  state.current = next;
  state.currentIndex = state.songs.indexOf(next);
  releaseItemResources(previous);
  loadItemMetadata(next).then(() => analyzeWaveform(next)).catch(() => {});
  renderSetlist();
  updatePlayer();
}

function fadeToPause() {
  if (state.fading || audioA.paused) return;
  abortTransition();
  state.fading = true;
  initAudioGraph();
  const graph = audioGraphs.get(audioA).gain.gain;
  const now = audioContext.currentTime;
  graph.cancelScheduledValues(now);
  graph.setValueAtTime(1, now);
  graph.linearRampToValueAtTime(0, now + 5);
  setTimeout(() => {
    audioA.pause();
    const currentTime = audioContext.currentTime;
    graph.cancelScheduledValues(currentTime);
    graph.setValueAtTime(1, currentTime);
    state.fading = false;
    updatePlayButton();
    updateNextTrackLabel();
  }, 5000);
  updatePlayButton();
}

function playNextTrack() {
  if (!state.current) {
    playSong(state.songs[0], true);
    return;
  }
  const next = getNextSong();
  if (next) playSong(next, true);
  else toast("You are at the end of this set.");
}

function onAudioPlay() { updatePlayButton(); updateNextTrackLabel(); updateMediaSession(); }
function onAudioPause() { updatePlayButton(); updateNextTrackLabel(); updateMediaSession(); }
function onAudioEnded() {
  if (transition.active) return;
  const next = getNextSong();
  if (next) playSong(next, true);
}
function onAudioTimeUpdate() {
  const duration = audioA.duration || state.current?.duration || 0;
  $("scrub-fill").style.width = duration ? `${audioA.currentTime / duration * 100}%` : "0";
  $("time-current").textContent = fmt(audioA.currentTime);
  $("time-duration").textContent = fmt(duration);
  updateMediaPosition();
  updateMarkers();
  if (!transition.active && audioA.paused === false && state.current && duration && state.current.transitionPoint !== null && audioA.currentTime >= state.current.transitionPoint) startTransition();
}

function attachAudioListeners() {
  for (const element of [audioA, audioB]) {
    element.removeEventListener("play", onAudioPlay);
    element.removeEventListener("pause", onAudioPause);
    element.removeEventListener("ended", onAudioEnded);
    element.removeEventListener("timeupdate", onAudioTimeUpdate);
  }
  audioA.addEventListener("play", onAudioPlay);
  audioA.addEventListener("pause", onAudioPause);
  audioA.addEventListener("ended", onAudioEnded);
  audioA.addEventListener("timeupdate", onAudioTimeUpdate);
}

function handleTransport() {
  if (state.fading) return;
  if (state.current && !audioA.paused) fadeToPause();
  else if (state.current && !state.started) playSong(state.current, true);
  else playNextTrack();
}

function resumePlayback() {
  if (!state.current || state.fading) return;
  audioA.play().catch(() => toast("Tap play to start audio."));
}

function onScrubClick(event) {
  if (!audioA.duration || transition.active) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  audioA.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * audioA.duration;
}

function showLockPrompt() {
  $("lock-password").value = "";
  $("lock-status").textContent = "";
  $("lock-modal").hidden = false;
  setTimeout(() => $("lock-password").focus(), 40);
}

function enterFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function shakeLockButton() {
  const button = $("lock-button");
  button.classList.remove("shake");
  void button.offsetWidth;
  button.classList.add("shake");
  setTimeout(() => button.classList.remove("shake"), 350);
}

function unlock() {
  if ($("lock-password").value === LOCK_PASSWORD) {
    state.locked = false;
    $("lock-modal").hidden = true;
    $("lock-button").textContent = "🔒";
    exitFullscreen();
  } else {
    $("lock-status").textContent = "Incorrect password.";
    $("lock-password").value = "";
  }
}

async function clearCache() {
  $("confirm-modal").hidden = true;
  closeDrawer();
  abortTransition();
  audioA.pause(); audioB.pause();
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls.clear();
  await removeCachedZip();
  $("app-shell").hidden = true;
  $("download-screen").style.display = "grid";
  await bootstrap(true);
}

async function bootstrap(allowDownload = false) {
  try {
    const blob = await getZipBlob(allowDownload);
    setDownloadStatus("Preparing the sets…", .98);
    state.groups = await extractPlaylists(blob);
    const missing = state.groups.filter((group) => !group.songs.length);
    if (missing.length) throw new Error(`The archive is missing ${missing[0].name}.`);
    renderPicker();
    renderDrawer();
    $("google-signin-button").hidden = true;
    $("download-retry").hidden = true;
    $("download-screen").style.display = "none";
    $("app-shell").hidden = false;
  } catch (error) {
    setDownloadStatus(error.message || "Could not load the playlist archive.");
    $("download-progress").style.width = "0";
    const needsAuth = error.code === "AUTH_REQUIRED";
    $("google-signin-button").hidden = !needsAuth;
    $("download-retry").hidden = needsAuth;
  }
}

$("menu-button").addEventListener("click", () => setDrawer(true));
$("menu-close").addEventListener("click", closeDrawer);
$("drawer-backdrop").addEventListener("click", closeDrawer);
$('play-button').addEventListener("click", handleTransport);
$("resume-button").addEventListener("click", resumePlayback);
$("scrub-track").addEventListener("click", onScrubClick);
$("setlist").addEventListener("scroll", updateScrollPip, { passive: true });
$("lock-button").addEventListener("click", () => {
  if (state.locked) showLockPrompt();
  else {
    state.locked = true;
    $("lock-button").textContent = "🔓";
    enterFullscreen();
  }
});
$("lock-submit").addEventListener("click", unlock);
$("lock-password").addEventListener("keydown", (event) => { if (event.key === "Enter") unlock(); });
$("lock-password").addEventListener("input", () => {
  if ($("lock-password").value === LOCK_PASSWORD) unlock();
});
$("lock-close").addEventListener("click", () => { $("lock-modal").hidden = true; });
$("clear-cache-button").addEventListener("click", () => { $("confirm-modal").hidden = false; });
$("confirm-cancel").addEventListener("click", () => { $("confirm-modal").hidden = true; });
$("confirm-clear").addEventListener("click", clearCache);
$("google-signin-button").addEventListener("click", () => bootstrap(true));
$("download-retry").addEventListener("click", () => bootstrap(true));

document.addEventListener("click", (event) => {
  if (!state.locked || event.target.closest("[data-lock-allowed]") || event.target.closest("#lock-modal")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  shakeLockButton();
}, true);

window.addEventListener("resize", () => {
  if (state.current) { drawWaveform(state.current); updateMarkers(); }
  updateScrollPip();
});

attachAudioListeners();
if (navigator.mediaSession) {
  const setMediaAction = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  };
  setMediaAction("play", resumePlayback);
  setMediaAction("pause", () => {
    if (!audioA.paused) fadeToPause();
  });
  setMediaAction("seekbackward", () => { audioA.currentTime = Math.max(0, audioA.currentTime - 10); });
  setMediaAction("seekforward", () => { audioA.currentTime = Math.min(audioA.duration || Infinity, audioA.currentTime + 10); });
  setMediaAction("nexttrack", playNextTrack);
}
navigator.serviceWorker?.register("service-worker.js", { scope: "./" }).catch(() => {});
bootstrap();