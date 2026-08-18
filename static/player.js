const GOOGLE_CLIENT_ID = "465530902895-smsu60b8qvdv83ahrbr7pi7grl5cjh8b.apps.googleusercontent.com";
const DRIVE_URL = "https://www.googleapis.com/drive/v3/files/1S2aGqe7ttVQ-SznPjTu93wQSQT5rfNdj?alt=media&acknowledgeAbuse=true";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CACHE_DB = "playlist-studio-player-cache";
const CACHE_STORE = "archives";
const TRACK_CACHE_PREFIX = "track:";
const MAX_CACHED_TRACKS = 4;
const LOCK_PASSWORD = "1235";
const LOCK_TIMEOUT_MS = 30_000;
const SHORTENED_DURATION_CACHE = "playlist-studio-shortened-durations";
const SONG_METADATA_CACHE = "playlist-studio-song-metadata-v2";
const PLAYBACK_STATE_KEY = "playlist-studio-playback-state-v1";
const PAUSE_FADE_MS = 3500;
const PLAYBACK_CHECKPOINT_MS = 2000;
const DEFAULT_SHORTENED_DURATIONS = { pizza: 4 * 3600 + 21 * 60, dinner: 2 * 3600 + 36 * 60, wedding: 6 * 3600 + 12 * 60 };
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
    shortenedDurations: { ...DEFAULT_SHORTENED_DURATIONS },
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
let fadeTimer = null;
let metadataCache = {};
let metadataCacheTimer = null;
let lastPlaybackCheckpoint = 0;
let lastMediaPositionUpdate = 0;
let playRequestToken = 0;
let archiveZipPromise = null;

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
const yieldToBrowser = () => new Promise((resolve) => {
  if (window.requestIdleCallback) window.requestIdleCallback(resolve, { timeout: 1000 });
  else setTimeout(resolve, 50);
});
const yieldForMetadata = async () => {
  await yieldToBrowser();
  if (!audioA.paused) await sleep(350);
};

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function itemKey(item) {
  return `${item.folder}/${item.filename}`;
}

function loadSongMetadataCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SONG_METADATA_CACHE) || "{}");
    metadataCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    metadataCache = {};
  }
}

function applyTimingMetadata(item, metadata) {
  const duration = Number(metadata?.duration);
  if (!(duration > 0)) return false;
  const optionalNumber = (value) => value === null || value === undefined || value === ""
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  item.duration = duration;
  item.transitionPoint = optionalNumber(metadata.transitionPoint);
  if (item.transitionPoint === null) item.transitionPoint = Math.max(0, duration - 8);
  item.startPoint = optionalNumber(metadata.startPoint);
  item.quickIntro = Boolean(metadata.quickIntro);
  item.longOutro = Boolean(metadata.longOutro);
  item.longOutroSeconds = Math.max(1, Math.min(120, Number(metadata.longOutroSeconds) || 6));
  item.bpmOutro = Boolean(metadata.bpmOutro);
  item.manualBpm = optionalNumber(metadata.manualBpm);
  item.metadataLoaded = true;
  return true;
}

function hydrateCachedSongMetadata(groups) {
  loadSongMetadataCache();
  for (const item of groups.flatMap((group) => group.songs)) {
    applyTimingMetadata(item, metadataCache[itemKey(item)]);
  }
}

function flushSongMetadataCache() {
  metadataCacheTimer = null;
  try { localStorage.setItem(SONG_METADATA_CACHE, JSON.stringify(metadataCache)); } catch (_) {}
}

function cacheItemMetadata(item) {
  if (!item.duration) return;
  metadataCache[itemKey(item)] = {
    duration: item.duration,
    transitionPoint: item.transitionPoint,
    startPoint: item.startPoint,
    quickIntro: item.quickIntro,
    longOutro: item.longOutro,
    longOutroSeconds: item.longOutroSeconds,
    bpmOutro: item.bpmOutro,
    manualBpm: item.manualBpm,
  };
  if (metadataCacheTimer) return;
  metadataCacheTimer = setTimeout(flushSongMetadataCache, 500);
}

async function hydrateServerSongMetadata(groups) {
  if (navigator.onLine === false) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  const folders = [...new Set(groups.flatMap((group) => group.folders))];
  const byKey = new Map(groups.flatMap((group) => group.songs).map((item) => [itemKey(item), item]));
  let hydrated = 0;
  try {
    const responses = await Promise.allSettled(folders.map(async (folder) => {
      const response = await fetch(`/api/playlists/${encodeURIComponent(folder)}`, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
      return response.json();
    }));
    for (const result of responses) {
      if (result.status !== "fulfilled") continue;
      for (const metadata of result.value?.items || []) {
        if (metadata.type !== "song") continue;
        const item = byKey.get(`${metadata.playlist}/${metadata.id}`);
        if (!item || !applyTimingMetadata(item, {
          duration: metadata.duration,
          transitionPoint: metadata.transition_point,
          startPoint: metadata.start_point,
          quickIntro: metadata.quick_intro,
          longOutro: metadata.long_outro,
          longOutroSeconds: metadata.long_outro_seconds,
          bpmOutro: metadata.bpm_outro,
          manualBpm: metadata.manual_bpm,
        })) continue;
        cacheItemMetadata(item);
        hydrated++;
      }
    }
  } catch (_) {
    // The installed player also works offline; embedded metadata remains the fallback.
  } finally {
    clearTimeout(timeout);
  }
  return hydrated;
}

function persistedItem(item) {
  return item ? { folder: item.folder, filename: item.filename } : null;
}

function findPersistedItem(group, reference) {
  if (!group || !reference) return null;
  return group.songs.find((item) => item.folder === reference.folder && item.filename === reference.filename) || null;
}

function readPlaybackState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_STATE_KEY) || "null");
    return saved && saved.version === 1 ? saved : null;
  } catch (_) {
    return null;
  }
}

function persistPlaybackState(force = false) {
  if (!state.selectedGroup || !state.current) return;
  const now = Date.now();
  if (!force && now - lastPlaybackCheckpoint < PLAYBACK_CHECKPOINT_MS) return;
  lastPlaybackCheckpoint = now;
  const checkpoint = {
    version: 1,
    savedAt: now,
    groupId: state.selectedGroup.id,
    current: persistedItem(state.current),
    currentTime: Number.isFinite(audioA.currentTime) ? audioA.currentTime : 0,
    started: state.started,
    wasPlaying: !audioA.paused,
    queuedNext: persistedItem(state.queuedNext),
    fadePaused: state.fadePaused ? {
      item: persistedItem(state.fadePaused.item),
      time: state.fadePaused.time,
    } : null,
  };
  try { localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(checkpoint)); } catch (_) {}
}

async function restorePlaybackState() {
  const saved = readPlaybackState();
  const group = state.groups.find((candidate) => candidate.id === saved?.groupId);
  const item = findPersistedItem(group, saved?.current);
  if (!group || !item) return false;
  await selectGroup(group.id, { prepareInitial: false });
  await playSong(item, false, false);
  const duration = audioA.duration || item.duration || saved.currentTime;
  audioA.currentTime = Math.max(0, Math.min(duration || 0, Number(saved.currentTime) || 0));
  state.started = Boolean(saved.started);
  state.queuedNext = findPersistedItem(group, saved.queuedNext);
  const pausedItem = findPersistedItem(group, saved.fadePaused?.item);
  state.fadePaused = pausedItem ? { item: pausedItem, time: Math.max(0, Number(saved.fadePaused.time) || 0) } : null;
  onAudioTimeUpdate();
  renderSetlist();
  updatePlayer();
  preloadTransitionMetadata(item);
  persistPlaybackState(true);
  return true;
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

async function writeCachedZip(blob, paths = [], savedAt = Date.now()) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE)
      .put({ blob, paths, savedAt }, "playlist-zip");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeCachedZip() {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function trackCacheKey(item) {
  return `${TRACK_CACHE_PREFIX}${itemKey(item)}`;
}

async function readCachedTrack(item) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(trackCacheKey(item));
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeCachedTrack(item, blob) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CACHE_STORE, "readwrite");
    const store = transaction.objectStore(CACHE_STORE);
    store.put({ kind: "track", key: trackCacheKey(item), blob, savedAt: Date.now() }, trackCacheKey(item));
    const range = IDBKeyRange.bound(TRACK_CACHE_PREFIX, `${TRACK_CACHE_PREFIX}\uffff`);
    const request = store.getAll(range);
    request.onsuccess = () => {
      const tracks = request.result.filter((record) => record?.kind === "track")
        .sort((a, b) => b.savedAt - a.savedAt);
      for (const record of tracks.slice(MAX_CACHED_TRACKS)) store.delete(record.key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
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

  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const progressStream = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      setDownloadStatus(total ? `Downloading the playlist archive… ${Math.round(received / total * 100)}%` : "Downloading the playlist archive…", total ? received / total : null);
      controller.enqueue(chunk);
    },
  });
  const blob = response.body
    ? await new Response(response.body.pipeThrough(progressStream)).blob()
    : await response.blob();
  setDownloadStatus("Checking the archive…", .92);
  return blob;
}

async function getZipBlob(allowDownload = false) {
  const cached = await readCachedZip();
  if (cached?.blob) {
    if (Array.isArray(cached.paths) && cached.paths.length) {
      $("cache-note").textContent = `Cached ${new Date(cached.savedAt).toLocaleDateString()}`;
      setDownloadStatus("Opening the cached archive…", 1);
      archiveZipPromise = null;
      return { blob: cached.blob, zip: null, paths: cached.paths };
    }
    try {
      const zip = await JSZip.loadAsync(cached.blob);
      const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
      archiveZipPromise = Promise.resolve(zip);
      writeCachedZip(cached.blob, paths, cached.savedAt).catch(() => {});
      $("cache-note").textContent = `Cached ${new Date(cached.savedAt).toLocaleDateString()}`;
      setDownloadStatus("Opening the cached archive…", 1);
      return { blob: cached.blob, zip, paths };
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
  const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
  archiveZipPromise = Promise.resolve(zip);
  await writeCachedZip(downloaded, paths);
  $("cache-note").textContent = "Cached on this device";
  return { blob: downloaded, zip, paths };
}

function loadArchiveZip(blob) {
  if (!archiveZipPromise) archiveZipPromise = JSZip.loadAsync(blob);
  return archiveZipPromise;
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
    artUrl: null, artBlob: null, artworkLoaded: false, duration: 0, transitionPoint: null, startPoint: null, metadataLoaded: false,
    quickIntro: false, longOutro: false, longOutroSeconds: 6, bpmOutro: false, manualBpm: null,
  };
}

async function extractPlaylists(blob, loadedZip = null, cachedPaths = null) {
  const paths = cachedPaths || Object.keys(loadedZip?.files || {});
  const physicalFolders = new Set(GROUPS.flatMap((group) => group.folders));
  const entries = new Map();
  for (const path of paths) {
    const entry = loadedZip?.files[path] || {
      name: path,
      async: async (type) => {
        const zip = await loadArchiveZip(blob);
        const lazyEntry = zip.file(path);
        if (!lazyEntry) throw new Error(`The archive entry ${path} is missing.`);
        return lazyEntry.async(type);
      },
    };
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

async function ensureBlob(item, cacheTrack = false) {
  if (!item.blob) {
    if (!item.blobPromise) {
      item.blobPromise = (async () => {
        let blob = cacheTrack ? await readCachedTrack(item).catch(() => null) : null;
        if (blob) item.blobCacheSaved = true;
        else blob = await item.entry.async("blob");
        item.blob = blob;
        return blob;
      })()
        .finally(() => { item.blobPromise = null; });
    }
    await item.blobPromise;
  }
  if (cacheTrack && item.blob && !item.blobCacheSaved) {
    item.blobCacheSaved = true;
    writeCachedTrack(item, item.blob).catch(() => { item.blobCacheSaved = false; });
  }
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
  if (!item.metadataPromise) {
    item.metadataPromise = loadItemMetadataInternal(item)
      .finally(() => { item.metadataPromise = null; });
  }
  return item.metadataPromise;
}

async function loadItemMetadataInternal(item) {
  const tags = await loadTags(item);
  if (tags) {
    item.transitionPoint = numberFromTag(tags, "PS_TRANSITION");
    item.startPoint = numberFromTag(tags, "PS_START");
    item.quickIntro = booleanFromTag(tags, "PS_QUICK_INTRO");
    item.longOutro = booleanFromTag(tags, "PS_LONG_OUTRO");
    item.longOutroSeconds = Math.max(1, Math.min(120, numberFromTag(tags, "PS_LONG_OUTRO_SECONDS") || 6));
    item.bpmOutro = booleanFromTag(tags, "PS_BPM_OUTRO");
    item.manualBpm = numberFromTag(tags, "PS_BPM");
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
  if (item.duration && item.transitionPoint === null) item.transitionPoint = Math.max(0, item.duration - 8);
  item.metadataLoaded = true;
  cacheItemMetadata(item);
  return item;
}

async function loadItemArtwork(item) {
  if (item.artworkLoaded) return item;
  if (!item.artworkPromise) {
    item.artworkPromise = (async () => {
      await ensureBlob(item);
      const tags = await loadTags(item);
      const pictureTag = tags?.picture || tags?.APIC || tags?.covr;
      if (pictureTag?.data?.length) {
        item.artBlob = new Blob([new Uint8Array(pictureTag.data)], { type: pictureTag.format || pictureTag.mime || "image/jpeg" });
      }
      item.artworkLoaded = true;
      ensureArtUrl(item);
      return item;
    })().finally(() => { item.artworkPromise = null; });
  }
  return item.artworkPromise;
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
  item.blobCacheSaved = false;
  item.tagsPromise = null;
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

function loadShortenedDurationCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(SHORTENED_DURATION_CACHE) || "{}");
    for (const group of GROUPS) {
      if (Number.isFinite(cached[group.id])) state.shortenedDurations[group.id] = cached[group.id];
    }
  } catch (_) {}
}

function saveShortenedDuration(groupId, seconds) {
  state.shortenedDurations[groupId] = seconds;
  try {
    const cached = JSON.parse(localStorage.getItem(SHORTENED_DURATION_CACHE) || "{}");
    cached[groupId] = seconds;
    localStorage.setItem(SHORTENED_DURATION_CACHE, JSON.stringify(cached));
  } catch (_) {}
}

function formatPlaylistDuration(seconds) {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes || !hours) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function getGroupShortenedDuration(group) {
  return state.shortenedDurations[group.id] || 0;
}

function renderPicker() {
  const renderButton = (group) => `<button class="picker-button" data-group="${group.id}"><span><strong>${esc(group.name)}</strong><span>${formatPlaylistDuration(getGroupShortenedDuration(group))}</span></span><b>›</b></button>`;
  $("picker-list").innerHTML = state.groups.map(renderButton).join("");
  $("picker-list").querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => selectGroup(button.dataset.group)));
}

function renderDrawer() {
  $("drawer-playlists").innerHTML = state.groups.map((group) => `<button class="drawer-playlist${state.selectedGroup?.id === group.id ? " active" : ""}" data-group="${group.id}"><strong>${esc(group.name)}</strong><span>${formatPlaylistDuration(getGroupShortenedDuration(group))}</span></button>`).join("");
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

async function preloadMetadataInternal(group) {
  if (group.songs.every((item) => item.metadataLoaded && item.duration)) {
    saveShortenedDuration(group.id, group.songs.reduce((total, item) => total + getShortenedDuration(item), 0));
    if (state.selectedGroup === group) {
      for (const item of group.songs) updateSetlistRow(item);
    }
    renderPicker();
    renderDrawer();
    return;
  }
  let total = 0;
  let loaded = 0;
  for (const item of group.songs) {
    try {
      await loadItemMetadata(item);
      total += getShortenedDuration(item);
      if (item.duration) loaded++;
    } catch (_) {}
    if (state.selectedGroup === group) updateSetlistRow(item);
    if (item !== state.current && item !== state.queuedNext && item !== getNextSong()) releaseItemResources(item);
    await yieldForMetadata();
  }
  if (loaded === group.songs.length) saveShortenedDuration(group.id, total);
  renderPicker();
  renderDrawer();
}

function preloadMetadata(group) {
  if (!group.metadataPreloadPromise) {
    group.metadataPreloadPromise = preloadMetadataInternal(group)
      .finally(() => { group.metadataPreloadPromise = null; });
  }
  return group.metadataPreloadPromise;
}

function preloadGroupDurations(group) {
  return preloadMetadata(group);
}

async function preloadAllGroupDurations() {
  for (const group of state.groups) {
    await preloadGroupDurations(group);
    await yieldToBrowser();
  }
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
  pane.classList.toggle("is-content-veiled", mode === "closed");
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

function updateDrawerContentVeil(height) {
  $("setlist-pane").classList.toggle("is-content-veiled", height <= 64);
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
  if (event.clientY < drawerState.startY) pane.classList.remove("is-content-veiled");
  else updateDrawerContentVeil(nextHeight);
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

async function selectInitialSong(item) {
  if (!item) return;
  try {
    await ensureBlob(item, true);
    await Promise.all([loadItemMetadata(item), loadItemArtwork(item)]);
    if (state.current === item) updatePlayer();
    preloadTransitionMetadata(item);
  } catch (_) {}
}

async function preloadTransitionMetadata(item) {
  const next = item === state.current ? getNextSong() : state.songs[state.songs.indexOf(item) + 1];
  if (!next) return;
  try {
    await ensureBlob(next, true);
    await loadItemMetadata(next);
    ensureUrl(next);
    loadItemArtwork(next).then(() => {
      if (state.selectedGroup?.songs.includes(next)) updateSetlistRow(next);
      if (getNextSong() === next) updateUpNext();
    }).catch(() => {});
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
  const now = performance.now();
  if (now - lastMediaPositionUpdate < 1000) return;
  lastMediaPositionUpdate = now;
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
  button.setAttribute("aria-label", state.fading ? "Cancel pause fade" : playing ? "Fade to pause" : "Play current track");
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
  if (item.startPoint !== null && item.startPoint / duration >= .05) {
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

async function selectGroup(id, { prepareInitial = true } = {}) {
  const group = state.groups.find((candidate) => candidate.id === id);
  if (!group) return;
  playRequestToken++;
  const previous = state.current;
  abortTransition();
  state.fading = false;
  state.fadePaused = null;
  state.resumeFadeIn = false;
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
  if (prepareInitial) selectInitialSong(state.current);
}

async function playSong(item, shouldPlay, respectInPoint = true) {
  if (!item) return;
  const requestToken = ++playRequestToken;
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
  await ensureBlob(item, true);
  await loadItemMetadata(item);
  if (requestToken !== playRequestToken || state.current !== item) return;
  loadItemArtwork(item).then(() => {
    if (state.current === item) updatePlayer();
    if (state.selectedGroup?.songs.includes(item)) updateSetlistRow(item);
  }).catch(() => {});
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
  if (requestToken !== playRequestToken || state.current !== item) return;
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
  persistPlaybackState(true);
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

function abortTransition(preserveCurrentGain = false) {
  if (transition.timer) clearTimeout(transition.timer);
  if (transition.rateTimer) clearInterval(transition.rateTimer);
  if (fadeTimer) clearTimeout(fadeTimer);
  transition.timer = null;
  transition.rateTimer = null;
  fadeTimer = null;
  transition.active = false;
  $("player-view").classList.remove("is-transitioning");
  if (audioContext) {
    const now = audioContext.currentTime;
    const currentGraph = audioGraphs.get(audioA);
    const nextGraph = audioGraphs.get(audioB);
    const currentGain = preserveCurrentGain ? (currentGraph?.gain.gain.value ?? 1) : 1;
    currentGraph?.gain.gain.cancelScheduledValues(now);
    currentGraph?.gain.gain.setValueAtTime(currentGain, now);
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
  await ensureBlob(next, true);
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
  const bpmA = currentItem.manualBpm;
  const bpmB = next.manualBpm;
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
  }, 100);

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
  preloadTransitionMetadata(next);
  renderSetlist();
  updatePlayer();
  onAudioTimeUpdate();
  scrollToCurrentSong();
  persistPlaybackState(true);
}

function fadeToPause() {
  if (state.fading || audioA.paused) return;
  abortTransition(true);
  state.fading = true;
  initAudioGraph();
  const graph = audioGraphs.get(audioA).gain.gain;
  const now = audioContext.currentTime;
  const startingGain = Math.max(.001, Math.min(1, graph.value));
  graph.cancelScheduledValues(now);
  graph.setValueAtTime(startingGain, now);
  graph.exponentialRampToValueAtTime(.001, now + PAUSE_FADE_MS / 1000);
  fadeTimer = setTimeout(async () => {
    fadeTimer = null;
    if (!state.fading) return;
    const pausedTime = audioA.currentTime;
    const pausedItem = state.current;
    audioA.pause();
    const currentTime = audioContext.currentTime;
    graph.cancelScheduledValues(currentTime);
    graph.setValueAtTime(0, currentTime);
    state.fading = false;
    const checkpoint = { item: pausedItem, time: pausedTime };
    state.fadePaused = checkpoint;
    persistPlaybackState(true);
    const next = getNextSong();
    if (next) {
      await playSong(next, false, false);
      state.fadePaused = checkpoint;
    }
    updatePlayButton();
    updateNextTrackLabel();
    persistPlaybackState(true);
  }, PAUSE_FADE_MS + 40);
  updatePlayButton();
}

function cancelPauseFade() {
  if (!state.fading) return;
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
  state.fading = false;
  initAudioGraph();
  const gain = audioGraphs.get(audioA).gain.gain;
  const now = audioContext.currentTime;
  if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
  else {
    const heldGain = Math.max(.001, Math.min(1, gain.value));
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(heldGain, now);
  }
  gain.linearRampToValueAtTime(1, now + .18);
  audioA.play().catch(() => toast("Tap play to keep playing."));
  updatePlayButton();
  updateNextTrackLabel();
  persistPlaybackState(true);
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

function onAudioPlay() {
  audioContext?.resume().catch(() => {});
  updatePlayButton();
  updateNextTrackLabel();
  updateMediaSession();
  persistPlaybackState(true);
}
function onAudioPause() {
  updatePlayButton();
  updateNextTrackLabel();
  updateMediaSession();
  persistPlaybackState(true);
}
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
  persistPlaybackState();
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
  if (state.fading) {
    cancelPauseFade();
    return;
  }
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
  persistPlaybackState(true);
  abortTransition();
  audioA.pause(); audioB.pause();
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls.clear();
  await removeCachedZip();
  archiveZipPromise = null;
  if (metadataCacheTimer) clearTimeout(metadataCacheTimer);
  metadataCacheTimer = null;
  metadataCache = {};
  try {
    localStorage.removeItem(SONG_METADATA_CACHE);
    localStorage.removeItem(SHORTENED_DURATION_CACHE);
  } catch (_) {}
  $("app-shell").hidden = true;
  $("download-screen").style.display = "grid";
  await bootstrap(true);
}

async function refreshMetadataInBackground() {
  const needsMetadata = state.groups.some((group) => group.songs.some((item) => !item.metadataLoaded || !item.duration));
  if (needsMetadata) {
    await hydrateServerSongMetadata(state.groups);
    renderPicker();
    renderDrawer();
    if (state.selectedGroup) renderSetlist();
  }
  await preloadAllGroupDurations();
}

async function bootstrap(allowDownload = false) {
  try {
    const archive = await getZipBlob(allowDownload);
    setDownloadStatus("Preparing the sets…", .98);
    state.groups = await extractPlaylists(archive.blob, archive.zip, archive.paths);
    const missing = state.groups.filter((group) => !group.songs.length);
    if (missing.length) throw new Error(`The archive is missing ${missing[0].name}.`);
    hydrateCachedSongMetadata(state.groups);
    loadShortenedDurationCache();
    renderPicker();
    renderDrawer();
    $("google-signin-button").hidden = true;
    $("download-retry").hidden = true;
    $("download-screen").style.display = "none";
    $("app-shell").hidden = false;
    await restorePlaybackState();
    navigator.storage?.persist?.().catch(() => {});
    refreshMetadataInBackground().catch(() => {});
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
  setMediaAction("play", () => state.fading ? cancelPauseFade() : playCurrentWithFadeIn());
  setMediaAction("pause", () => {
    if (state.fading) cancelPauseFade();
    else if (!audioA.paused) fadeToPause();
  });
  setMediaAction("seekbackward", () => { audioA.currentTime = Math.max(0, audioA.currentTime - 10); });
  setMediaAction("seekforward", () => { audioA.currentTime = Math.min(audioA.duration || Infinity, audioA.currentTime + 10); });
  setMediaAction("nexttrack", playNextTrack);
}
const checkpointPlayback = () => persistPlaybackState(true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") checkpointPlayback();
  else if (!audioA.paused) audioContext?.resume().catch(() => {});
});
document.addEventListener("freeze", checkpointPlayback);
document.addEventListener("resume", () => {
  if (!audioA.paused) audioContext?.resume().catch(() => {});
});
window.addEventListener("pagehide", checkpointPlayback);
navigator.serviceWorker?.register("service-worker.js", { scope: "./" }).catch(() => {});
bootstrap();
