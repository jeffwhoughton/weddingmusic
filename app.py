#!/usr/bin/env python3
"""
Playlist Studio — local backend.

Each playlist is a folder under ./playlists.
Items inside a playlist folder encode their order in a numeric filename prefix:

    Songs:    "{pos} - {emoji} - {title} - {artist}.mp3"   e.g. "3 - 🍂 - Bring Me To Life - Evanescence.mp3"
    Dividers: "{pos} - {name}.txt"                          e.g. "2 - Emosongs.txt"

Reordering / moving renames files so the prefix always matches the visible order.
Song title/artist/duration/cover-art are read from the audio file's embedded
metadata (mutagen); the filename is just a human-readable mirror.
"""

import io
import math
import os
import re
import sys
import threading
import uuid
import shutil
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

from flask import (
    Flask, jsonify, request, send_file, send_from_directory, abort, Response
)

try:
    from mutagen import File as MutagenFile
    from mutagen.id3 import ID3, TXXX
    from mutagen.mp4 import MP4, MP4FreeForm
    from mutagen.flac import FLAC
except Exception:  # pragma: no cover
    MutagenFile = None
    TXXX = None
    MP4FreeForm = None

# --------------------------------------------------------------------------- #
#  Configuration
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
PLAYLISTS_DIR = BASE_DIR / "playlists"
STATIC_DIR = BASE_DIR / "static"

ALLOWED_EMOJIS = ["💞", "✨", "🍂", "🕺","🗑️"]
DEFAULT_EMOJI = "✨"
AUDIO_EXTS = {".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac", ".webm"}

DEFAULT_PLAYLISTS = [
    "Pizza Party",
    "Pizza Party 2",
    "The Church",
    "Cocktails + Din",
    "Wedding Reception",
    "Reception 2",
    "Reception 3",
    "End The Night",
    "Extra Songs",
    "Instrumentals",
    "Trash",
]

NUM_PREFIX = re.compile(r"^\s*(\d+)([a-z]*)\s*-\s*(.*)$", re.IGNORECASE | re.DOTALL)

app = Flask(__name__, static_folder=None)

# File ordering touches every item in a playlist. Keep audio reads and ordering
# operations from racing one another inside this process.
FILESYSTEM_MUTATION_LOCK = threading.RLock()


class FileInUseError(OSError):
    """Raised before an ordering operation when Windows will not allow a rename."""

    def __init__(self, path: Path):
        self.path = Path(path)
        super().__init__(f'“{self.path.name}” is in use by another process. Pause or close it, then try again.')


class OrderingError(OSError):
    """Raised when an ordering operation fails after its original names are restored."""


@contextmanager
def hold_files_for_rename(paths, retries=5, retry_delay=0.1):
    """
    On Windows, hold DELETE-access handles while an ordering operation runs.

    Acquiring these handles both checks that every file is currently renameable
    and prevents a new non-delete-sharing reader from grabbing one halfway
    through the operation. Open files do not block renames on POSIX systems.
    """
    unique_paths = list(dict.fromkeys(Path(path).resolve() for path in paths))
    if os.name != "nt":
        yield
        return

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    delete_access = 0x00010000
    share_all = 0x00000001 | 0x00000002 | 0x00000004
    open_existing = 3
    normal_attributes = 0x00000080
    invalid_handle = ctypes.c_void_p(-1).value
    busy_errors = {32, 33}  # ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
    handles = []

    try:
        for attempt in range(retries + 1):
            busy_path = None
            other_error = None
            for path in unique_paths:
                handle = create_file(
                    str(path), delete_access, share_all, None,
                    open_existing, normal_attributes, None,
                )
                if handle == invalid_handle:
                    error = ctypes.get_last_error()
                    if error in busy_errors:
                        busy_path = path
                    else:
                        other_error = OSError(error, os.strerror(error), str(path))
                    break
                handles.append(handle)

            if busy_path is None and other_error is None:
                break

            for handle in handles:
                close_handle(handle)
            handles.clear()
            if other_error is not None:
                raise other_error
            if attempt == retries:
                raise FileInUseError(busy_path)
            time.sleep(retry_delay)

        yield
    finally:
        for handle in handles:
            close_handle(handle)


# --------------------------------------------------------------------------- #
#  Bootstrap
# --------------------------------------------------------------------------- #

def ensure_playlists():
    PLAYLISTS_DIR.mkdir(exist_ok=True)
    for name in DEFAULT_PLAYLISTS:
        (PLAYLISTS_DIR / name).mkdir(exist_ok=True)


def sanitize(text: str) -> str:
    """Make a string safe for use inside a filename (keeps emojis & spaces)."""
    if text is None:
        text = ""
    text = unicodedata.normalize("NFC", str(text))
    # Strip characters illegal on common filesystems.
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", text)
    text = text.strip().strip(".")
    return text or "Untitled"


def playlist_path(name: str) -> Path:
    safe = sanitize(name)
    p = (PLAYLISTS_DIR / safe).resolve()
    if PLAYLISTS_DIR.resolve() not in p.parents and p != PLAYLISTS_DIR.resolve():
        abort(400, "Invalid playlist name")
    return PLAYLISTS_DIR / safe


# --------------------------------------------------------------------------- #
#  Filename parsing helpers
# --------------------------------------------------------------------------- #

def strip_position(filename: str) -> str:
    """Return everything after the leading 'NN - ' or 'NNa - ' position prefix."""
    m = NUM_PREFIX.match(filename)
    return m.group(3) if m else filename


def position_of(filename: str) -> str:
    m = NUM_PREFIX.match(filename)
    return m.group(1) + m.group(2) if m else "9999"


def sort_key_of(filename: str):
    m = NUM_PREFIX.match(filename)
    if m:
        return (int(m.group(1)), m.group(2).lower())
    return (9999, "")


def split_emoji(middle: str):
    """From 'EMOJI - rest' return (emoji, rest); emoji is None if not recognised."""
    parts = middle.split(" - ", 1)
    if len(parts) == 2 and parts[0].strip() in ALLOWED_EMOJIS:
        return parts[0].strip(), parts[1]
    return None, middle


def list_items(pdir: Path):
    """Ordered list of (filename) for a playlist directory (skips temp/hidden)."""
    if not pdir.exists():
        return []
    names = [
        f.name for f in pdir.iterdir()
        if f.is_file() and not f.name.startswith(".") and NUM_PREFIX.match(f.name)
    ]
    names.sort(key=lambda n: (sort_key_of(n), n.lower()))
    return names


# --------------------------------------------------------------------------- #
#  Metadata extraction
# --------------------------------------------------------------------------- #

def read_audio_meta(path: Path):
    """Return dict(title, artist, duration) from embedded tags, with fallbacks."""
    title = artist = None
    duration = 0.0
    if MutagenFile is not None:
        try:
            mf = MutagenFile(str(path))
            if mf is not None:
                if mf.info is not None:
                    duration = float(getattr(mf.info, "length", 0) or 0)
                tags = mf.tags or {}

                def first(*keys):
                    for k in keys:
                        if k in tags:
                            v = tags[k]
                            if isinstance(v, list):
                                v = v[0] if v else None
                            if v:
                                return str(v)
                    return None

                title = first("TIT2", "title", "\xa9nam", "TITLE")
                artist = first("TPE1", "artist", "\xa9ART", "ARTIST")
        except Exception:
            pass

    # Fall back to parsing the filename: "<title> - <artist>.<ext>"
    if not (title and artist):
        stem = strip_position(path.name)
        _, stem = split_emoji(stem)
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", stem)
        if " - " in stem:
            t, a = stem.rsplit(" - ", 1)
            title = title or t.strip()
            artist = artist or a.strip()
        else:
            title = title or stem.strip()
            artist = artist or "Unknown Artist"
    return {"title": title or "Unknown Title",
            "artist": artist or "Unknown Artist",
            "duration": duration}


def read_cover(path: Path):
    """Return (bytes, mimetype) for embedded cover art, or (None, None)."""
    if MutagenFile is None:
        return None, None
    try:
        ext = path.suffix.lower()
        if ext == ".mp3":
            tags = ID3(str(path))
            for k in tags.keys():
                if k.startswith("APIC"):
                    apic = tags[k]
                    return apic.data, apic.mime or "image/jpeg"
        elif ext in (".m4a", ".mp4", ".aac"):
            mp4 = MP4(str(path))
            covr = mp4.tags.get("covr") if mp4.tags else None
            if covr:
                data = bytes(covr[0])
                fmt = covr[0].imageformat
                mime = "image/png" if fmt == MP4.MP4Cover.FORMAT_PNG else "image/jpeg"
                return data, mime
        elif ext == ".flac":
            fl = FLAC(str(path))
            if fl.pictures:
                pic = fl.pictures[0]
                return pic.data, pic.mime or "image/jpeg"
        else:
            mf = MutagenFile(str(path))
            pics = getattr(mf, "pictures", None)
            if pics:
                return pics[0].data, pics[0].mime or "image/jpeg"
    except Exception:
        pass
    return None, None


# --------------------------------------------------------------------------- #
#  Transition-point metadata helpers
# --------------------------------------------------------------------------- #

TRANSITION_TAG_KEY   = "PS_TRANSITION"
START_TAG_KEY        = "PS_START"
QUICK_INTRO_TAG_KEY  = "PS_QUICK_INTRO"
LONG_OUTRO_TAG_KEY   = "PS_LONG_OUTRO"
LONG_OUTRO_SECONDS_TAG_KEY = "PS_LONG_OUTRO_SECONDS"
BPM_OUTRO_TAG_KEY    = "PS_BPM_OUTRO"
BPM_TAG_KEY          = "PS_BPM"


def _read_custom_tag(path: Path, tag_key: str):
    """Generic helper: read a single float custom tag from any supported format."""
    if MutagenFile is None:
        return None
    try:
        ext = path.suffix.lower()
        if ext == ".mp3":
            tags = ID3(str(path))
            for k in list(tags.keys()):
                if k.upper() == f"TXXX:{tag_key}":
                    v = tags[k]
                    text = v.text[0] if v.text else None
                    if text:
                        return float(text)
        elif ext in (".m4a", ".mp4", ".aac"):
            mp4 = MP4(str(path))
            if mp4.tags:
                key = f"----:com.apple.iTunes:{tag_key}"
                vals = mp4.tags.get(key)
                if vals:
                    return float(bytes(vals[0]).decode())
        elif ext == ".flac":
            fl = FLAC(str(path))
            if fl.tags:
                vals = fl.tags.get(tag_key)
                if vals:
                    return float(vals[0])
        else:
            mf = MutagenFile(str(path))
            if mf and mf.tags:
                val = mf.tags.get(tag_key)
                if val:
                    v0 = val[0] if isinstance(val, list) else val
                    return float(str(v0))
    except Exception:
        pass
    return None


def _write_custom_tag(path: Path, tag_key: str, seconds):
    """Generic helper: write (or remove if seconds is None) a float custom tag."""
    if MutagenFile is None:
        return
    try:
        ext = path.suffix.lower()
        if ext == ".mp3":
            from mutagen.id3 import error as ID3Error
            try:
                tags = ID3(str(path))
            except ID3Error:
                tags = ID3()
            tag_key_full = f"TXXX:{tag_key}"
            tags.delall(tag_key_full)
            if seconds is not None:
                tags.add(TXXX(encoding=3, desc=tag_key,
                               text=[str(round(float(seconds), 3))]))
            tags.save(str(path))
        elif ext in (".m4a", ".mp4", ".aac"):
            mp4 = MP4(str(path))
            if mp4.tags is None:
                mp4.add_tags()
            key = f"----:com.apple.iTunes:{tag_key}"
            if seconds is None:
                mp4.tags.pop(key, None)
            else:
                mp4.tags[key] = [MP4FreeForm(
                    str(round(float(seconds), 3)).encode())]
            mp4.save()
        elif ext == ".flac":
            fl = FLAC(str(path))
            if seconds is None:
                if fl.tags:
                    fl.tags.pop(tag_key, None)
            else:
                if fl.tags is None:
                    fl.add_vorbis_comment()
                fl.tags[tag_key] = [str(round(float(seconds), 3))]
            fl.save()
        else:
            mf = MutagenFile(str(path))
            if mf is not None:
                if mf.tags is None:
                    mf.add_tags()
                if seconds is None:
                    mf.tags.pop(tag_key, None)
                else:
                    mf.tags[tag_key] = [str(round(float(seconds), 3))]
                mf.save()
    except Exception:
        pass


def read_transition_point(path: Path):
    return _read_custom_tag(path, TRANSITION_TAG_KEY)


def write_transition_point(path: Path, seconds):
    _write_custom_tag(path, TRANSITION_TAG_KEY, seconds)


def read_start_point(path: Path):
    return _read_custom_tag(path, START_TAG_KEY)


def write_start_point(path: Path, seconds):
    _write_custom_tag(path, START_TAG_KEY, seconds)


def read_quick_intro(path: Path) -> bool:
    """Return True if the song is tagged as having a quick/abrupt intro."""
    val = _read_custom_tag(path, QUICK_INTRO_TAG_KEY)
    return val is not None and val > 0.5


def write_quick_intro(path: Path, value: bool):
    """Set or remove the quick-intro tag."""
    _write_custom_tag(path, QUICK_INTRO_TAG_KEY, 1.0 if value else None)


def read_long_outro(path: Path) -> bool:
    """Return True if the song is tagged as having a long vocal outro."""
    val = _read_custom_tag(path, LONG_OUTRO_TAG_KEY)
    return val is not None and val > 0.5


def write_long_outro(path: Path, value: bool):
    """Set or remove the long-outro tag."""
    _write_custom_tag(path, LONG_OUTRO_TAG_KEY, 1.0 if value else None)


def read_long_outro_seconds(path: Path):
    """Return the saved long-outro tail length, or None for the default."""
    value = _read_custom_tag(path, LONG_OUTRO_SECONDS_TAG_KEY)
    return value if value is not None and math.isfinite(value) and value > 0 else None


def write_long_outro_seconds(path: Path, seconds):
    """Set or remove the saved long-outro tail length."""
    _write_custom_tag(path, LONG_OUTRO_SECONDS_TAG_KEY, seconds)


def read_bpm_outro(path: Path) -> bool:
    """Return True if the song is tagged for BPM-matched outro."""
    val = _read_custom_tag(path, BPM_OUTRO_TAG_KEY)
    return val is not None and val > 0.5


def write_bpm_outro(path: Path, value: bool):
    """Set or remove the BPM-outro tag."""
    _write_custom_tag(path, BPM_OUTRO_TAG_KEY, 1.0 if value else None)


def read_manual_bpm(path: Path):
    """Return manually-set BPM float, or None."""
    return _read_custom_tag(path, BPM_TAG_KEY)


def write_manual_bpm(path: Path, bpm):
    """Set or remove the manual BPM tag."""
    _write_custom_tag(path, BPM_TAG_KEY, bpm)


# --------------------------------------------------------------------------- #
#  Item serialization
# --------------------------------------------------------------------------- #

def human_time(seconds: float) -> str:
    seconds = int(round(seconds or 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def is_song(filename: str) -> bool:
    return Path(filename).suffix.lower() in AUDIO_EXTS


def serialize_item(playlist: str, filename: str):
    pos = position_of(filename)
    middle = strip_position(filename)
    if filename.lower().endswith(".txt"):
        name = re.sub(r"\.txt$", "", middle, flags=re.IGNORECASE)
        return {
            "type": "divider",
            "id": filename,
            "playlist": playlist,
            "position": pos,
            "name": name,
        }
    emoji, rest = split_emoji(middle)
    meta = read_audio_meta(playlist_path(playlist) / filename)
    from urllib.parse import quote
    enc_pl = quote(playlist)
    enc_fn = quote(filename)
    fp = playlist_path(playlist) / filename
    return {
        "type": "song",
        "id": filename,
        "playlist": playlist,
        "position": pos,
        "emoji": emoji or "",
        "title": meta["title"],
        "artist": meta["artist"],
        "duration": meta["duration"],
        "duration_human": human_time(meta["duration"]),
        "audio_url": f"/api/audio/{enc_pl}/{enc_fn}",
        "art_url": f"/api/art/{enc_pl}/{enc_fn}",
        "transition_point": read_transition_point(fp),
        "start_point": read_start_point(fp),
        "quick_intro": read_quick_intro(fp),
        "long_outro": read_long_outro(fp),
        "long_outro_seconds": read_long_outro_seconds(fp) or 6.0,
        "bpm_outro": read_bpm_outro(fp),
        "manual_bpm": read_manual_bpm(fp),
    }


def serialize_playlist_summary(name: str):
    items = list_items(playlist_path(name))
    total = 0.0
    songs = 0
    for fn in items:
        if is_song(fn):
            songs += 1
            total += read_audio_meta(playlist_path(name) / fn)["duration"]
    return {
        "name": name,
        "song_count": songs,
        "duration": total,
        "duration_human": human_time(total),
    }


# --------------------------------------------------------------------------- #
#  Ordering primitives
# --------------------------------------------------------------------------- #

def apply_order(target_dir: Path, entries):
    """
    entries: list of (middle, current_path:Path). Files are moved into
    target_dir and renamed to "{i+1} - {middle}". Two-phase to avoid clobbering.
    Returns the resulting ordered filename list.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    entries = [(middle, Path(cur)) for middle, cur in entries]
    originals = [cur for _, cur in entries]
    if len({path.resolve() for path in originals}) != len(originals):
        raise OrderingError("The same file appeared more than once in an ordering operation.")
    missing = next((path for path in originals if not path.is_file()), None)
    if missing is not None:
        raise OrderingError(f'“{missing.name}” disappeared before it could be moved.')

    token = uuid.uuid4().hex[:8]
    plan = []
    song_count = 0
    divider_count = 0
    for i, (middle, original) in enumerate(entries):
        if not middle.lower().endswith(".txt"):
            song_count += 1
            divider_count = 0
            prefix = str(song_count)
        else:
            divider_count += 1
            if divider_count <= 26:
                letter = chr(ord('a') + divider_count - 1)
            else:
                letter = f"z{divider_count}"  # fallback
            prefix = f"{song_count}{letter}"
        plan.append({
            "original": original,
            "stage": target_dir / f".stage_{token}_{i:04d}",
            "final": target_dir / f"{prefix} - {middle}",
            "current": original,
        })

    def rollback():
        """Two-phase rollback avoids original/final name collisions."""
        parked = []
        for i, item in enumerate(plan):
            current = item["current"]
            if current == item["original"] or not current.exists():
                continue
            parking = target_dir / f".rollback_{token}_{i:04d}"
            shutil.move(str(current), str(parking))
            parked.append((parking, item["original"]))
        for parking, original in parked:
            original.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(parking), str(original))

    with FILESYSTEM_MUTATION_LOCK, hold_files_for_rename(originals):
        try:
            for item in plan:
                shutil.move(str(item["original"]), str(item["stage"]))
                item["current"] = item["stage"]
            for item in plan:
                os.replace(str(item["stage"]), str(item["final"]))
                item["current"] = item["final"]
        except Exception as error:
            try:
                rollback()
            except Exception as rollback_error:
                app.logger.exception("Ordering failed and rollback was incomplete")
                raise OrderingError(
                    f"Ordering failed ({error}); restoring the original filenames also failed ({rollback_error})."
                ) from error
            raise OrderingError(f"Ordering failed; all original filenames were restored. {error}") from error

    return [item["final"].name for item in plan]


def renumber(playlist: str):
    pdir = playlist_path(playlist)
    entries = [(strip_position(fn), pdir / fn) for fn in list_items(pdir)]
    return apply_order(pdir, entries)


# --------------------------------------------------------------------------- #
#  Static frontend
# --------------------------------------------------------------------------- #

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:fn>")
def static_files(fn):
    return send_from_directory(STATIC_DIR, fn)


# --------------------------------------------------------------------------- #
#  API — read
# --------------------------------------------------------------------------- #

@app.get("/api/playlists")
def api_playlists():
    ensure_playlists()
    names = sorted(
        [p.name for p in PLAYLISTS_DIR.iterdir() if p.is_dir()],
        key=lambda n: (DEFAULT_PLAYLISTS.index(n) if n in DEFAULT_PLAYLISTS else 999, n),
    )
    return jsonify([serialize_playlist_summary(n) for n in names])


@app.get("/api/playlists/<path:name>")
def api_playlist(name):
    pdir = playlist_path(name)
    if not pdir.exists():
        abort(404)
    items = [serialize_item(name, fn) for fn in list_items(pdir)]
    return jsonify({"name": name, "items": items})


@app.get("/api/audio/<path:playlist>/<path:filename>")
def api_audio(playlist, filename):
    pdir = playlist_path(playlist)
    fp = (pdir / filename)
    if not fp.exists():
        abort(404)
    # Do not stream from an open disk handle: Windows will otherwise refuse to
    # rename a song for as long as a browser/player keeps the response open.
    with FILESYSTEM_MUTATION_LOCK:
        stat = fp.stat()
        audio_data = fp.read_bytes()
    return send_file(
        io.BytesIO(audio_data), download_name=fp.name, conditional=True,
        last_modified=stat.st_mtime,
    )


@app.get("/api/art/<path:playlist>/<path:filename>")
def api_art(playlist, filename):
    fp = playlist_path(playlist) / filename
    if not fp.exists():
        abort(404)
    data, mime = read_cover(fp)
    if not data:
        return Response(status=204)
    return send_file(io.BytesIO(data), mimetype=mime)


@app.get("/api/artist-occurrences")
def api_artist_occurrences():
    """Count other appearances of an artist across all playlists."""
    artist_query = (request.args.get("artist") or "").strip().lower()
    cur_pl = request.args.get("playlist") or ""
    cur_id = request.args.get("id") or ""
    if not artist_query:
        return jsonify({"total": 0, "text": ""})
    query_artists = {a.strip() for a in artist_query.split(",") if a.strip()}
    
    by_playlist = {}
    for p in PLAYLISTS_DIR.iterdir():
        if not p.is_dir():
            continue
        for fn in list_items(p):
            if not is_song(fn):
                continue
            if p.name == cur_pl and fn == cur_id:
                continue
            meta = read_audio_meta(p / fn)
            track_artists = {a.strip().lower() for a in meta["artist"].split(",") if a.strip()}
            if query_artists & track_artists:
                by_playlist[p.name] = by_playlist.get(p.name, 0) + 1
    total = sum(by_playlist.values())
    # Build a compact human string, e.g. "In Trash 3 times" or
    # "In Trash 2 times, Extra Songs 1 time".
    if total == 0:
        text = ""
    else:
        parts = []
        for pl, c in sorted(by_playlist.items(), key=lambda kv: -kv[1]):
            if pl == cur_pl:
                parts.append(f"{pl} {c} other time" + ("s" if c != 1 else ""))
            else:
                parts.append(f"{pl} {c} time" + ("s" if c != 1 else ""))
        text = "In " + ", ".join(parts)
    return jsonify({"total": total, "by_playlist": by_playlist, "text": text})


# --------------------------------------------------------------------------- #
#  API — mutations
# --------------------------------------------------------------------------- #

@app.errorhandler(FileInUseError)
def handle_file_in_use(error):
    return jsonify({"ok": False, "error": str(error)}), 423


@app.errorhandler(OrderingError)
def handle_ordering_error(error):
    app.logger.warning("Playlist ordering failed: %s", error)
    return jsonify({"ok": False, "error": str(error)}), 409

@app.post("/api/reorder")
def api_reorder():
    data = request.get_json(force=True)
    playlist = data["playlist"]
    order = data["order"]  # list of current filenames in desired order
    pdir = playlist_path(playlist)
    existing = set(list_items(pdir))
    order = [fn for fn in order if fn in existing]
    # append anything that existed but wasn't in the payload (safety)
    for fn in list_items(pdir):
        if fn not in order:
            order.append(fn)
    entries = [(strip_position(fn), pdir / fn) for fn in order]
    apply_order(pdir, entries)
    return api_playlist(playlist)


@app.post("/api/move")
def api_move():
    data = request.get_json(force=True)
    to_playlist = data["to_playlist"]
    moved = data["items"]  # [{playlist, id}, ...] in desired relative order
    tdir = playlist_path(to_playlist)

    # Existing target items keep their order, new ones append at the end.
    existing_entries = [(strip_position(fn), tdir / fn) for fn in list_items(tdir)]
    incoming_entries = []
    sources = set()
    for it in moved:
        src_pl = it["playlist"]
        src_id = it["id"]
        if src_pl == to_playlist:
            continue  # ignore no-op self moves; reorder handles those
        src = playlist_path(src_pl) / src_id
        if not src.exists():
            continue
        incoming_entries.append((strip_position(src_id), src))
        sources.add(src_pl)

    # Preflight and hold every affected file before changing any playlist.
    incoming_paths = {path for _, path in incoming_entries}
    source_entries = {}
    for source in sources:
        source_dir = playlist_path(source)
        source_entries[source] = [
            (strip_position(fn), source_dir / fn)
            for fn in list_items(source_dir)
            if source_dir / fn not in incoming_paths
        ]
    all_paths = [path for _, path in existing_entries + incoming_entries]
    all_paths.extend(path for entries in source_entries.values() for _, path in entries)
    with FILESYSTEM_MUTATION_LOCK, hold_files_for_rename(all_paths):
        apply_order(tdir, existing_entries + incoming_entries)
        for source, entries in source_entries.items():
            apply_order(playlist_path(source), entries)
    return jsonify({"ok": True})


@app.post("/api/divider")
def api_add_divider():
    data = request.get_json(force=True)
    playlist = data["playlist"]
    name = sanitize(data.get("name") or "New Divider")
    pdir = playlist_path(playlist)
    pos = len(list_items(pdir)) + 1
    (pdir / f"{pos} - {name}.txt").write_text(name, encoding="utf-8")
    renumber(playlist)
    return api_playlist(playlist)


@app.put("/api/divider")
def api_rename_divider():
    data = request.get_json(force=True)
    playlist = data["playlist"]
    old_id = data["id"]
    new_name = sanitize(data.get("name") or "Divider")
    pdir = playlist_path(playlist)
    src = pdir / old_id
    if not src.exists() or not old_id.lower().endswith(".txt"):
        abort(404)
    pos = position_of(old_id)
    dst = pdir / f"{pos} - {new_name}.txt"
    os.replace(str(src), str(dst))
    dst.write_text(new_name, encoding="utf-8")
    renumber(playlist)
    return jsonify({"ok": True, "id": dst.name})


@app.post("/api/emoji")
def api_set_emoji():
    data = request.get_json(force=True)
    playlist = data["playlist"]
    item_id = data["id"]
    emoji = data["emoji"]
    if emoji not in ALLOWED_EMOJIS:
        abort(400, "Bad emoji")
    pdir = playlist_path(playlist)
    src = pdir / item_id
    if not src.exists() or not is_song(item_id):
        abort(404)
    pos = position_of(item_id)
    middle = strip_position(item_id)
    _, rest = split_emoji(middle)          # rest == "<title> - <artist>.<ext>"
    new_name = f"{pos} - {emoji} - {rest}"
    dst = pdir / new_name
    os.replace(str(src), str(dst))
    return jsonify({"ok": True, "id": dst.name})


@app.post("/api/transition-point")
def api_set_transition_point():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    time_val = data.get("time")   # float or None
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    if time_val is not None:
        try:
            time_val = float(time_val)
        except (TypeError, ValueError):
            abort(400, "Invalid time value")
    write_transition_point(fp, time_val)
    return jsonify({"ok": True, "transition_point": time_val})


@app.post("/api/start-point")
def api_set_start_point():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    time_val = data.get("time")   # float or None
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    if time_val is not None:
        try:
            time_val = float(time_val)
        except (TypeError, ValueError):
            abort(400, "Invalid time value")
    write_start_point(fp, time_val)
    return jsonify({"ok": True, "start_point": time_val})


@app.post("/api/quick-intro")
def api_set_quick_intro():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    value    = bool(data.get("value", False))
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    write_quick_intro(fp, value)
    return jsonify({"ok": True, "quick_intro": value})


@app.post("/api/long-outro")
def api_set_long_outro():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    value    = bool(data.get("value", False))
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    write_long_outro(fp, value)
    return jsonify({"ok": True, "long_outro": value})


@app.post("/api/long-outro-duration")
def api_set_long_outro_duration():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id = data.get("id", "")
    try:
        seconds = float(data.get("seconds"))
    except (TypeError, ValueError):
        abort(400, "Invalid long-outro duration")
    if not math.isfinite(seconds) or seconds < 1 or seconds > 120:
        abort(400, "Long-outro duration must be between 1 and 120 seconds")
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    write_long_outro_seconds(fp, seconds)
    return jsonify({"ok": True, "long_outro_seconds": seconds})


@app.post("/api/bpm-outro")
def api_set_bpm_outro():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    value    = bool(data.get("value", False))
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    write_bpm_outro(fp, value)
    return jsonify({"ok": True, "bpm_outro": value})


@app.post("/api/bpm")
def api_set_bpm():
    data = request.get_json(force=True)
    playlist = data.get("playlist", "")
    item_id  = data.get("id", "")
    bpm_val  = data.get("bpm")   # float or None
    fp = playlist_path(playlist) / item_id
    if not fp.exists() or not is_song(item_id):
        abort(404)
    if bpm_val is not None:
        try:
            bpm_val = float(bpm_val)
            if bpm_val <= 0:
                abort(400, "BPM must be positive")
        except (TypeError, ValueError):
            abort(400, "Invalid BPM value")
    write_manual_bpm(fp, bpm_val)
    return jsonify({"ok": True, "manual_bpm": bpm_val})


@app.post("/api/song")
def api_add_song():
    """Download a song from a (YouTube Music) URL into the playlist."""
    data = request.get_json(force=True)
    playlist = data["playlist"]
    url = (data.get("url") or "").strip()
    if not url:
        abort(400, "No URL")
    pdir = playlist_path(playlist)

    try:
        import yt_dlp
    except Exception:
        return jsonify({"ok": False,
                        "error": "yt-dlp is not installed. Run: pip install yt-dlp"}), 500

    token = uuid.uuid4().hex[:8]
    outtmpl = str(pdir / f".dl_{token}.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # YouTube now requires an external JS runtime for reliable format URL
        # extraction. Node is installed with Playlist Studio's runtime, but
        # yt-dlp only enables it when explicitly requested.
        "js_runtimes": {"node": {"path": None}},
        # Avoid intermittent 403s caused by YouTube returning media URLs for
        # an IPv6 route that differs from the route used during extraction.
        "source_address": "0.0.0.0",
        "retries": 10,
        "fragment_retries": 10,
        "extractor_retries": 3,
        "writethumbnail": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "256"},
            {"key": "FFmpegMetadata", "add_metadata": True},
            {"key": "EmbedThumbnail"},
        ],
    }
    def cleanup_download():
        for leftover in pdir.glob(f".dl_{token}.*"):
            try:
                leftover.unlink()
            except OSError:
                pass

    # yt-dlp retries individual HTTP requests, but a rejected media URL needs
    # a fresh extraction to obtain a new signed URL. Retry that case once.
    info = None
    for attempt in range(2):
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
            break
        except Exception as e:
            message = str(e)
            transient = any(marker in message.lower() for marker in (
                "http error 403", "http error 429", "timed out",
                "remote end closed", "unable to download video data",
            ))
            cleanup_download()
            if attempt == 0 and transient:
                time.sleep(1)
                continue
            app.logger.warning("Song download failed: %s", message)
            return jsonify({"ok": False,
                            "error": f"Download failed: {message}"}), 502

    # Locate the produced mp3.
    produced = list(pdir.glob(f".dl_{token}.mp3"))
    if not produced:
        produced = sorted(pdir.glob(f".dl_{token}.*"),
                          key=lambda p: p.stat().st_mtime, reverse=True)
    if not produced:
        return jsonify({"ok": False, "error": "Could not find downloaded file"}), 500
    tmp_file = produced[0]

    title = sanitize(info.get("track") or info.get("title") or "Unknown Title")
    artist = sanitize(info.get("artist") or info.get("uploader")
                      or info.get("creator") or "Unknown Artist")
    pos = len(list_items(pdir)) + 1
    final = pdir / f"{pos} - {DEFAULT_EMOJI} - {title} - {artist}{tmp_file.suffix}"
    os.replace(str(tmp_file), str(final))
    # tidy any leftover thumbnail / temp files
    cleanup_download()
    return jsonify({"ok": True, "item": serialize_item(playlist, final.name)})


# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    ensure_playlists()
    port = int(os.environ.get("PORT", 5005))
    print(f"\n  ♪  Playlist Studio running at  http://127.0.0.1:{port}\n")
    app.run(host="0.0.0.0", debug=True, port=port)
