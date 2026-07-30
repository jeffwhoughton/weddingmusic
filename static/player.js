const GOOGLE_CLIENT_ID = "465530902895-smsu60b8qvdv83ahrbr7pi7grl5cjh8b.apps.googleusercontent.com";
const DRIVE_URL = "https://www.googleapis.com/drive/v3/files/1lEbueEUIIzJtZuP233Bgc8LbpeeE6A2p?alt=media&acknowledgeAbuse=true";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CACHE_DB = "playlist-studio-player-cache";
const CACHE_STORE = "archives";
const LOCK_PASSWORD = "1235";
const LOCK_TIMEOUT_MS = 30_000;
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac", ".webm"]);
const ALLOWED_EMOJIS = ["💞", "✨", "🍂", "🕺", "🗑️"];
const GROUPS = [
  { id: "pizza", name: "Pizza Party", folders: ["Pizza Party", "Pizza Party 2"], note: "Pizza Party + Pizza Party 2" },
  { id: "dinner", name: "Cocktails / Dinner", folders: ["Cocktails + Din"], note: "Cocktails + Dinner" },
  { id: "wedding", name: "Wedding Reception", folders: ["Wedding Reception", "Reception 2", "Reception 3", "End The Night"], note: "Wedding Reception through End The Night" },
];
const GROUP_START_MINUTES = { pizza: 17 * 60, dinner: 16 * 60 + 30, wedding: 19 * 60 + 30 };

const state = {
  groups: [],
  selectedGroup: null,
  songs: [],
  current: null,
  currentIndex: -1,
  queuedNext: null,
  started: false,
  urls: new Set(),
  locked: false,
  lockEngaged: false,
  fading: false,
  fadePaused: null,
  resumeFadeIn: false,
};

const drawerState = {
  mode: "half",
  pointerId: null,
  startY: 0,
  startHeight: 0,
  closeTimer: null,
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
let lockTimeout = null;
let menuCloseTimer = null;
let artSwapToken = 0;
let artSwapCleanup = null;

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
      const zip = await JSZip.loadAsync(cached.blob);
      $("cache-note").textContent = `Cached ${new Date(cached.savedAt).toLocaleDateString()}`;
      setDownloadStatus("Opening the cached archive…", 1);
      return { blob: cached.blob, zip };
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
  const zip = await JSZip.loadAsync(downloaded);
  await writeCachedZip(downloaded);
  $("cache-note").textContent = "Cached on this device";
  return { blob: downloaded, zip };
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

async function extractPlaylists(blob, loadedZip = null) {
  const zip = loadedZip || await JSZip.loadAsync(blob);
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
  if (Array.isArray(tags?.TXXX)) candidates.push(...tags.TXXX);
  else if (tags?.TXXX) candidates.push(tags.TXXX);
  for (const [tagName, tagValue] of Object.entries(tags || {})) {
    const normalizedName = tagName.toUpperCase();
    if (normalizedName === wanted || normalizedName.endsWith(`:${wanted}`)) candidates.push(tagValue);
  }
  const found = candidates.find((tag) => {
    const payload = tag?.data && typeof tag.data === "object" && !Array.isArray(tag.data) ? tag.data : tag;
    const description = payload?.user_description || payload?.description || payload?.desc || payload?.name || "";
    return String(description).toUpperCase() === wanted;
  }) || candidates.find((tag) => {
    const payload = tag?.data && typeof tag.data === "object" && !Array.isArray(tag.data) ? tag.data : tag;
    return !payload?.user_description && !payload?.description && !payload?.desc && !payload?.name;
  });
  const payload = found?.data && typeof found.data === "object" && !Array.isArray(found.data) ? found.data : found;
  const rawValue = payload?.value ?? payload?.text ?? payload?.data ?? payload;
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const decoded = value instanceof Uint8Array
    ? new TextDecoder().decode(value)
    : value instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(value)) : value;
  const result = Number(String(decoded).trim());
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
    if (state.current === item) updateMarkers();
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

function getDisplayedArtUrl() {
  const image = $("player-art");
  return image?.getAttribute("src") || "";
}

function getShortenedDuration(item) {
  if (!item.duration) return 0;
  const inPoint = item.startPoint === null ? 0 : Math.max(0, item.startPoint);
  const outPoint = item.transitionPoint === null ? item.duration : Math.max(inPoint, Math.min(item.duration, item.transitionPoint));
  return Math.max(0, outPoint - inPoint);
}

function getGroupShortenedDuration(group) {
  return group.songs.reduce((total, item) => total + getShortenedDuration(item), 0);
}

function formatLongDuration(seconds) {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes || !parts.length) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function renderPicker() {
  const renderButton = (group) => `<button class="picker-button" data-group="${group.id}"><span><strong>${esc(group.name)}</strong><span>${formatLongDuration(getGroupShortenedDuration(group))}</span></span><b>›</b></button>`;
  $("picker-list").innerHTML = state.groups.map(renderButton).join("");
  $("picker-list").querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => selectGroup(button.dataset.group)));
}

function renderDrawer() {
  $("drawer-playlists").innerHTML = state.groups.map((group) => `<button class="drawer-playlist${state.selectedGroup?.id === group.id ? " active" : ""}" data-group="${group.id}"><strong>${esc(group.name)}</strong><span>${formatLongDuration(getGroupShortenedDuration(group))}</span></button>`).join("");
  $("drawer-playlists").querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => {
    selectGroup(button.dataset.group);
    closeDrawer();
  }));
}

function renderSetlist() {
  const group = state.selectedGroup;
  if (!group) return;
  const list = $("setlist");
  const scrollTop = list.scrollTop;
  const html = [];
  let elapsedSeconds = (GROUP_START_MINUTES[group.id] || 0) * 60;
  for (const section of group.sections) {
    for (const [sectionIndex, item] of section.items.entries()) {
      if (item.type === "divider") {
        const nextSong = section.items.slice(sectionIndex + 1).find((candidate) => candidate.type === "song");
        const nextSongIndex = nextSong ? group.songs.indexOf(nextSong) : -1;
        const skipped = state.queuedNext && nextSongIndex > state.currentIndex && nextSongIndex < group.songs.indexOf(state.queuedNext) ? " skipped" : "";
        html.push(`<div class="set-divider${skipped}"><span class="set-divider-name">${esc(item.name)}</span><span class="set-divider-time">~${formatClockTime(elapsedSeconds)}</span></div>`);
        continue;
      }
      const itemIndex = group.songs.indexOf(item);
      const current = state.current === item ? " current" : "";
      const skipped = state.queuedNext && itemIndex > state.currentIndex && itemIndex < group.songs.indexOf(state.queuedNext) ? " skipped" : "";
      const art = item.artUrl || "";
      const duration = item.duration ? fmt(item.duration) : "0:00";
      const inPoint = item.startPoint === null ? 0 : Math.max(0, item.startPoint);
      const outPoint = item.transitionPoint === null ? item.duration : Math.max(inPoint, Math.min(item.duration, item.transitionPoint));
      const shortened = item.duration ? fmt(Math.max(0, outPoint - inPoint)) : "0:00";
      const queueActive = state.queuedNext === item ? " active" : "";
      const queueButton = itemIndex > state.currentIndex
        ? `<button class="song-queue-next${queueActive}" data-queue-song="${item.globalIndex}" title="Go here next" aria-label="Go here next">↩</button>`
        : "";
      html.push(`<div class="song-row${current}${skipped}" data-song="${item.globalIndex}"><span class="song-number">${item.globalIndex + 1}</span><img class="song-art"${art ? ` src="${art}"` : ""} alt=""><span class="song-meta"><span class="song-name">${esc(item.name)}</span><span class="song-artist">${esc(item.artist)}</span></span>${queueButton}<span class="song-times"><span class="song-duration">${duration}</span><span class="song-short-duration">${shortened}</span></span></div>`);
      elapsedSeconds += Math.max(0, outPoint - inPoint);
    }
  }

  list.innerHTML = html.join("");
  list.scrollTop = scrollTop;
  list.querySelectorAll("[data-song]").forEach((row) => row.addEventListener("click", () => playSong(group.songs[Number(row.dataset.song)], true)));
  list.querySelectorAll("[data-queue-song]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    setQueuedNext(group.songs[Number(button.dataset.queueSong)]);
  }));
  updateScrollPip();
}

function updateSetlistRow(item) {
  const row = $("setlist").querySelector(`.song-row[data-song="${item.globalIndex}"]`);
  if (!row) return;
  const art = row.querySelector(".song-art");
  if (art) setImage(art, item.artUrl || "");
  const duration = row.querySelector(".song-duration");
  const shortened = row.querySelector(".song-short-duration");
  const inPoint = item.startPoint === null ? 0 : Math.max(0, item.startPoint);
  const outPoint = item.transitionPoint === null ? item.duration : Math.max(inPoint, Math.min(item.duration, item.transitionPoint));
  if (duration) duration.textContent = item.duration ? fmt(item.duration) : "0:00";
  if (shortened) shortened.textContent = item.duration ? fmt(Math.max(0, outPoint - inPoint)) : "0:00";
}

function formatClockTime(seconds) {
  const roundedMinutes = Math.round(Math.max(0, seconds) / 60);
  const hour = Math.floor(roundedMinutes / 60) % 12 || 12;
  const minute = String(roundedMinutes % 60).padStart(2, "0");
  const meridiem = Math.floor(roundedMinutes / 60) % 24 >= 12 ? "pm" : "am";
  return `${hour}:${minute}${meridiem}`;
}

async function preloadMetadata(group) {
  for (const item of group.songs) {
    try {
      await loadItemMetadata(item);
      await analyzeWaveform(item);
    } catch (_) {}
    if (state.selectedGroup === group) updateSetlistRow(item);
    renderPicker();
    renderDrawer();
  }
}

async function preloadGroupDurations(group) {
  await Promise.all(group.songs.map(async (item) => {
    try { await loadItemMetadata(item); } catch (_) {}
  }));
  renderPicker();
  renderDrawer();
}

function clearQueuedNext() {
  state.queuedNext = null;
}

function setQueuedNext(item) {
  const itemIndex = state.songs.indexOf(item);
  if (itemIndex <= state.currentIndex) return;
  if (state.queuedNext === item) {
    clearQueuedNext();
  } else {
    if (transition.active) abortTransition();
    state.queuedNext = item;
  }
  renderSetlist();
  updateUpNext();
}

function updateUpNext() {
  const next = getNextSong();
  const art = $("up-next-art");
  $("up-next-title").textContent = next?.name || "End of set";
  $("up-next-artist").textContent = next?.artist || "No more tracks queued";
  setImage(art, next ? ensureArtUrl(next) : "");
  $("first-dance-button").hidden = state.selectedGroup?.id !== "dinner";
}

function drawerHeightFor(mode) {
  const height = $("player-view").clientHeight;
  if (mode === "closed") return 29;
  if (mode === "open") return height;
  return Math.round(height * .47);
}

function clearDrawerCloseTimer() {
  if (drawerState.closeTimer) clearTimeout(drawerState.closeTimer);
  drawerState.closeTimer = null;
}

function scheduleDrawerClose() {
  clearDrawerCloseTimer();
  if (!$('player-view').hidden && (drawerState.mode === "open" || drawerState.mode === "half")) {
    drawerState.closeTimer = setTimeout(() => setDrawerMode("closed"), 30000);
  }
}

function setDrawerMode(mode) {
  drawerState.mode = mode;
  const pane = $("setlist-pane");
  pane.classList.remove("is-closed", "is-open", "is-dragging");
  if (mode !== "half") pane.classList.add(`is-${mode}`);
  pane.style.removeProperty("height");
  $("player-view").classList.toggle("drawer-closed", mode === "closed");
  const basePadding = window.matchMedia("(max-height: 700px)").matches ? 10 : 14;
  const playerPane = $("player-pane");
  const contentHeight = playerPane ? [...playerPane.children].reduce((total, child) => {
    const style = getComputedStyle(child);
    return total + child.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }, 0) : 0;
  const centeredPadding = Math.max(basePadding, (playerPane.clientHeight - contentHeight - 14) / 2);
  playerPane?.style.setProperty("--player-top-padding", `${mode === "closed" ? centeredPadding : basePadding}px`);
  $("setlist-handle").setAttribute("aria-expanded", String(mode === "open"));
  if (mode === "open" || mode === "half") scheduleDrawerClose();
  else clearDrawerCloseTimer();
  updateUpNext();
}

function animatePlayerArt(item, outgoingArtUrl = "", onComplete = null) {
  const current = $("player-art");
  const outgoing = $("player-art-next");
  if (!current) return;
  artSwapCleanup?.();
  artSwapCleanup = null;
  if (!outgoing || !current.parentElement) {
    setImage(current, item ? ensureArtUrl(item) : "");
    onComplete?.();
    return;
  }
  const wrap = current.parentElement;
  const swapToken = ++artSwapToken;
  setImage(outgoing, outgoingArtUrl);
  setImage(current, item ? ensureArtUrl(item) : "");
  wrap.classList.remove("is-swapping");
  void wrap.offsetWidth;
  wrap.classList.add("is-swapping");
  const onAnimationEnd = (event) => {
    if (event.animationName !== "art-slide-out" || swapToken !== artSwapToken) {
      if (swapToken !== artSwapToken) outgoing.removeEventListener("animationend", onAnimationEnd);
      return;
    }
    setImage(outgoing, "");
    wrap.classList.remove("is-swapping");
    outgoing.removeEventListener("animationend", onAnimationEnd);
    artSwapCleanup = null;
    onComplete?.();
  };
  artSwapCleanup = () => {
    outgoing.removeEventListener("animationend", onAnimationEnd);
    wrap.classList.remove("is-swapping");
    onComplete?.();
  };
  outgoing.addEventListener("animationend", onAnimationEnd);
}

function onDrawerPointerMove(event) {
  if (event.pointerId !== drawerState.pointerId) return;
  const pane = $("setlist-pane");
  const height = $("player-view").clientHeight;
  const nextHeight = Math.max(29, Math.min(height, drawerState.startHeight + drawerState.startY - event.clientY));
  pane.style.height = `${nextHeight}px`;
}

function onDrawerPointerUp(event) {
  if (event.pointerId !== drawerState.pointerId) return;
  const pane = $("setlist-pane");
  const currentHeight = pane.getBoundingClientRect().height;
  const modes = ["closed", "half", "open"];
  const mode = modes.reduce((closest, candidate) => Math.abs(drawerHeightFor(candidate) - currentHeight) < Math.abs(drawerHeightFor(closest) - currentHeight) ? candidate : closest, "half");
  drawerState.pointerId = null;
  pane.releasePointerCapture?.(event.pointerId);
  setDrawerMode(mode);
}

function onDrawerPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  clearDrawerCloseTimer();
  const pane = $("setlist-pane");
  drawerState.pointerId = event.pointerId;
  drawerState.startY = event.clientY;
  drawerState.startHeight = pane.getBoundingClientRect().height;
  pane.classList.add("is-dragging");
  pane.setPointerCapture?.(event.pointerId);
}

function scrollToCurrentSong() {
  if (drawerState.mode === "closed") return;
  const list = $("setlist");
  const row = state.current && list.querySelector(`.song-row[data-song="${state.current.globalIndex}"]`);
  if (!row) return;
  const listBounds = list.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  if (rowBounds.top < listBounds.top || rowBounds.bottom > listBounds.bottom) {
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
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
        updateSetlistRow(item);
        const artWrap = $("player-art-wrap");
        if (state.current === item && !artWrap?.classList.contains("is-swapping")) setImage($("player-art"), ensureArtUrl(item));
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
  const artWrap = $("player-art-wrap");
  const art = $("player-art");
  if (art && (!artWrap || !artWrap.classList.contains("is-swapping"))) setImage(art, item ? ensureArtUrl(item) : "");
  updateMediaSession();
  updatePlayButton();
  updateNextTrackLabel();
  updateUpNext();
  updateMarkers();
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
  button.textContent = "";
  button.classList.toggle("is-playing", Boolean(playing));
  wrapper.classList.toggle("is-fading", state.fading);
  if (!state.fading) wrapper.style.removeProperty("--fade-progress");
  button.setAttribute("aria-label", playing ? "Fade to pause" : "Play next track");
}

function updateNextTrackLabel() {
  const playing = state.fading || (state.current && !audioA.paused);
  const resume = $("resume-button");
  resume.hidden = Boolean(playing || !state.fadePaused);
}

function updateMarkers() {
  const item = state.current;
  const duration = item?.duration || audioA.duration || 0;
  const transitionMarker = $("transition-marker");
  const startMarker = $("start-marker");
  const position = $("scrub-position");
  if (!item || !duration) {
    transitionMarker.style.display = "none";
    startMarker.style.display = "none";
    position.style.display = "none";
    return;
  }
  const inPercent = item.startPoint === null ? 0 : Math.max(0, Math.min(100, item.startPoint / duration * 100));
  const outPercent = item.transitionPoint === null ? 100 : Math.max(inPercent, Math.min(100, item.transitionPoint / duration * 100));
  $("scrub-track").style.setProperty("--scrub-in", `${inPercent}%`);
  $("scrub-track").style.setProperty("--scrub-out", `${outPercent}%`);
  if (item.transitionPoint !== null && item.transitionPoint / duration < .9) {
    transitionMarker.style.display = "block";
    transitionMarker.style.left = `${Math.max(0, Math.min(100, item.transitionPoint / duration * 100))}%`;
  } else transitionMarker.style.display = "none";
  if (item.startPoint !== null) {
    startMarker.style.display = "block";
    startMarker.style.left = `${Math.max(0, Math.min(100, item.startPoint / duration * 100))}%`;
  } else startMarker.style.display = "none";
  position.style.display = "block";
  position.style.left = `${Math.max(0, Math.min(100, audioA.currentTime / duration * 100))}%`;
}

function seekToInPoint(audio, item) {
  if (item.startPoint === null) return Promise.resolve();
  const target = Math.max(0, Math.min(audio.duration || item.duration || item.startPoint, item.startPoint));
  if (target === 0) { audio.currentTime = 0; return Promise.resolve(); }
  return new Promise((resolve) => {
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      audio.removeEventListener("seeked", finish);
      resolve();
    };
    audio.addEventListener("seeked", finish, { once: true });
    timeout = setTimeout(finish, 1500);
    audio.currentTime = target;
  });
}

function setDrawer(open) {
  $("menu-drawer").classList.toggle("open", open);
  $("drawer-backdrop").classList.toggle("open", open);
  $("menu-drawer").setAttribute("aria-hidden", String(!open));
  if (menuCloseTimer) clearTimeout(menuCloseTimer);
  menuCloseTimer = open ? setTimeout(closeDrawer, 30000) : null;
}
function closeDrawer() { setDrawer(false); }

function resetMenuCloseTimer() {
  if ($("menu-drawer").classList.contains("open")) setDrawer(true);
}

function closeSearchModal() {
  $("search-modal").hidden = true;
}

async function searchSongs(query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return;

  $("search-modal").hidden = false;
  $("search-status").textContent = "Searching playlists…";
  $("search-results").innerHTML = "";
  await sleep(0);

  const results = state.groups.flatMap((group) => group.songs
    .filter((song) => song.name.toLowerCase().includes(normalizedQuery) || song.artist.toLowerCase().includes(normalizedQuery))
    .map((song) => ({ group, song })));

  $("search-status").textContent = results.length
    ? `${results.length} match${results.length === 1 ? "" : "es"}`
    : `No matches for "${query.trim()}"`;
  $("search-results").innerHTML = results.map(({ group, song }) => `
    <div class="search-result">
      <div class="search-result-title">${esc(song.name)}</div>
      <div class="search-result-artist">${esc(song.artist)}</div>
      <div class="search-result-playlist">${esc(group.name)} #${song.globalIndex + 1}</div>
    </div>
  `).join("");
}

async function selectGroup(id) {
  const group = state.groups.find((candidate) => candidate.id === id);
  if (!group) return;
  const previous = state.current;
  abortTransition();
  audioA.pause(); audioB.pause();
  audioA.removeAttribute("src");
  audioB.removeAttribute("src");
  audioA.load();
  audioB.load();
  audioA.currentTime = 0;
  audioB.currentTime = 0;
  releaseItemResources(previous);
  state.selectedGroup = group;
  state.songs = group.songs;
  clearQueuedNext();
  state.current = group.songs[0] || null;
  state.currentIndex = state.current ? 0 : -1;
  state.started = false;
  $("playlist-picker").hidden = true;
  $("player-view").hidden = false;
  scheduleDrawerClose();
  $("setlist").scrollTop = 0;
  renderDrawer();
  renderSetlist();
  updatePlayer();
  onAudioTimeUpdate();
  selectInitialSong(state.current);
  preloadArtwork(group);
  preloadMetadata(group);
}

async function playSong(item, shouldPlay, respectInPoint = true) {
  if (!item) return;
  const previous = state.current;
  const previousArtUrl = previous && previous !== item ? ensureArtUrl(previous) || getDisplayedArtUrl() : "";
  clearQueuedNext();
  abortTransition();
  state.fading = false;
  state.fadePaused = null;
  state.resumeFadeIn = false;
  state.started = true;
  state.current = item;
  state.currentIndex = state.songs.indexOf(item);
  await loadItemMetadata(item);
  await analyzeWaveform(item);
  audioA.pause(); audioB.pause();
  audioA.src = ensureUrl(item);
  audioA.load();
  await new Promise((resolve) => {
    const onMetadata = () => {
      if (state.current === item) updateMarkers();
      resolve();
    };
    if (audioA.readyState >= 1) onMetadata();
    else {
      audioA.addEventListener("loadedmetadata", onMetadata, { once: true });
      audioA.addEventListener("error", resolve, { once: true });
    }
  });
  if (state.current === item && respectInPoint) await seekToInPoint(audioA, item);
  else if (state.current === item) audioA.currentTime = 0;
  onAudioTimeUpdate();
  if (shouldPlay) audioA.play().catch(() => toast("Tap play to start audio."));
  if (previous && previous !== item) {
    animatePlayerArt(item, previousArtUrl, () => releaseItemResources(previous));
  }
  renderSetlist();
  updatePlayer();
  preloadTransitionMetadata(item);
}

function getNextSong() {
  if (state.queuedNext) return state.queuedNext;
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
  $("player-view").classList.remove("is-transitioning");
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
  $("player-view").classList.add("is-transitioning");
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
  await seekToInPoint(audioB, next);
  if (!transition.active) return;
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
  const previousArtUrl = previous ? ensureArtUrl(previous) || getDisplayedArtUrl() : "";
  transition.active = false;
  $("player-view").classList.remove("is-transitioning");
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
  if (state.queuedNext === next) clearQueuedNext();
  animatePlayerArt(next, previousArtUrl, () => releaseItemResources(previous));
  loadItemMetadata(next).then(() => analyzeWaveform(next)).catch(() => {});
  renderSetlist();
  updatePlayer();
  onAudioTimeUpdate();
  scrollToCurrentSong();
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
  setTimeout(async () => {
    if (!state.fading) return;
    const pausedTime = audioA.currentTime;
    const pausedItem = state.current;
    audioA.pause();
    const currentTime = audioContext.currentTime;
    graph.cancelScheduledValues(currentTime);
    graph.setValueAtTime(1, currentTime);
    state.fading = false;
    const checkpoint = { item: pausedItem, time: pausedTime };
    state.fadePaused = checkpoint;
    const next = getNextSong();
    if (next) {
      await playSong(next, false, false);
      state.fadePaused = checkpoint;
    }
    updatePlayButton();
    updateNextTrackLabel();
  }, 5000);
  updatePlayButton();
}

async function goBackToPaused() {
  const checkpoint = state.fadePaused;
  if (!checkpoint || state.fading) return;
  await playSong(checkpoint.item, false, false);
  const target = Math.max(0, Math.min(audioA.duration || checkpoint.item.duration || checkpoint.time, checkpoint.time));
  audioA.currentTime = target;
  state.fadePaused = null;
  state.resumeFadeIn = true;
  onAudioTimeUpdate();
  updatePlayer();
}

async function playCurrentWithFadeIn() {
  if (!state.current || state.fading) return;
  if (!state.resumeFadeIn) {
    audioA.play().catch(() => toast("Tap play to start audio."));
    return;
  }
  state.resumeFadeIn = false;
  initAudioGraph();
  const gain = audioGraphs.get(audioA).gain.gain;
  const now = audioContext.currentTime;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(0, now);
  gain.linearRampToValueAtTime(1, now + 1);
  audioA.play().catch(() => toast("Tap play to start audio."));
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
  $("scrub-position").style.left = duration ? `${audioA.currentTime / duration * 100}%` : "0";
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
  else if (state.current) playCurrentWithFadeIn();
  else playNextTrack();
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

function setLocked(locked) {
  if (locked) state.lockEngaged = true;
  state.locked = locked;
  const button = $("lock-button");
  button.textContent = locked ? "🔒" : "🔓";
  button.setAttribute("aria-label", locked ? "Unlock screen" : "Lock screen");
  button.classList.toggle("is-locked", locked);
  if (lockTimeout) clearTimeout(lockTimeout);
  lockTimeout = !locked && state.lockEngaged ? setTimeout(() => setLocked(true), LOCK_TIMEOUT_MS) : null;
  if (locked) enterFullscreen();
  else exitFullscreen();
}

function unlock() {
  if ($("lock-password").value === LOCK_PASSWORD) {
    setLocked(false);
    $("lock-modal").hidden = true;
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
    const archive = await getZipBlob(allowDownload);
    setDownloadStatus("Preparing the sets…", .98);
    state.groups = await extractPlaylists(archive.blob, archive.zip);
    const missing = state.groups.filter((group) => !group.songs.length);
    if (missing.length) throw new Error(`The archive is missing ${missing[0].name}.`);
    renderPicker();
    renderDrawer();
    $("google-signin-button").hidden = true;
    $("download-retry").hidden = true;
    $("download-screen").style.display = "none";
    $("app-shell").hidden = false;
    Promise.all(state.groups.map((group) => preloadGroupDurations(group)));
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
$("menu-drawer").addEventListener("pointerdown", resetMenuCloseTimer);
$("menu-drawer").addEventListener("keydown", resetMenuCloseTimer);
$('play-button').addEventListener("click", handleTransport);
$("resume-button").addEventListener("click", goBackToPaused);
$("first-dance-button").addEventListener("click", () => selectGroup("wedding"));
$("scrub-track").addEventListener("click", onScrubClick);
$("setlist").addEventListener("scroll", () => {
  updateScrollPip();
  clearDrawerCloseTimer();
  if (drawerState.mode === "open" || drawerState.mode === "half") scheduleDrawerClose();
  if (!state.locked) setLocked(false);
}, { passive: true });
$("setlist-handle").addEventListener("pointerdown", onDrawerPointerDown);
$("setlist-pane").addEventListener("pointermove", onDrawerPointerMove);
$("setlist-pane").addEventListener("pointerup", onDrawerPointerUp);
$("setlist-pane").addEventListener("pointercancel", onDrawerPointerUp);
$("setlist-pane").addEventListener("pointerdown", () => {
  clearDrawerCloseTimer();
  if (drawerState.mode === "open" || drawerState.mode === "half") scheduleDrawerClose();
});
$("lock-button").addEventListener("click", () => {
  if (state.locked) showLockPrompt();
  else setLocked(true);
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
$("drawer-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("drawer-search-input");
  searchSongs(input.value);
  input.value = "";
});
$("search-close").addEventListener("click", closeSearchModal);
$("search-modal").addEventListener("click", (event) => {
  if (event.target === $("search-modal")) closeSearchModal();
});
$("google-signin-button").addEventListener("click", () => bootstrap(true));
$("download-retry").addEventListener("click", () => bootstrap(true));

function isLockAllowedTarget(target) {
  return target.closest?.("[data-lock-allowed]") || target.closest?.("#lock-modal");
}

document.addEventListener("click", (event) => {
  if (!state.locked || isLockAllowedTarget(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  shakeLockButton();
}, true);

document.addEventListener("pointerdown", (event) => {
  if (state.locked && !isLockAllowedTarget(event.target)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    shakeLockButton();
    return;
  }
  if (!state.locked) setLocked(false);
}, true);
document.addEventListener("keydown", () => {
  if (!state.locked) setLocked(false);
}, true);

window.addEventListener("resize", () => {
  if (state.current) updateMarkers();
  if (drawerState.mode !== "half") setDrawerMode(drawerState.mode);
  updateScrollPip();
});
setDrawerMode("half");
setLocked(false);

attachAudioListeners();
if (navigator.mediaSession) {
  const setMediaAction = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  };
  setMediaAction("play", playCurrentWithFadeIn);
  setMediaAction("pause", () => {
    if (!audioA.paused) fadeToPause();
  });
  setMediaAction("seekbackward", () => { audioA.currentTime = Math.max(0, audioA.currentTime - 10); });
  setMediaAction("seekforward", () => { audioA.currentTime = Math.min(audioA.duration || Infinity, audioA.currentTime + 10); });
  setMediaAction("nexttrack", playNextTrack);
}
navigator.serviceWorker?.register("service-worker.js", { scope: "./" }).catch(() => {});
bootstrap();