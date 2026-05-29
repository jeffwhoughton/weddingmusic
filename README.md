# Playlist Studio

A local, three-column web app for building and sequencing playlists. Songs and
dividers live as real files on disk; the app renames them so the filename always
mirrors the visible order, emoji tag, title and artist.

```
playlists/
  Pizza Party/
    1 - ✨ - Bring Me To Life - Evanescence.mp3
    2 - Emosongs.txt                ← a divider
    3 - 🍂 - My Immortal - Evanescence.mp3
  Wedding Church/
  ...
```

## What it does

- **Column 1 — Playlists.** The seven starter playlists, each showing its song
  count and total duration. Drag songs/dividers from column 2 onto any playlist
  here to move them; files are renamed and both playlists renumbered.
- **Column 2 — The current playlist.** Each song shows a checkbox, its emoji,
  cover art (read from the file's embedded metadata), title and artist. Dividers
  appear as labelled rules. Drag to reorder; check several boxes and drag to move
  them all at once. Check a single divider to rename it inline. Buttons at the
  bottom add a new divider or open the download dialog.
- **Column 3 — Player.** Plays the selected song and auto-advances to the next
  one (skipping dividers). Shows artwork, a scrubber, and a row of emoji tags
  (💞 ✨ 🍂 🕺) — picking one renames the file. A line of small text reports how
  many other times the artist appears across your playlists.

## Requirements

- **Python 3.9+**
- **ffmpeg** on your PATH — required by yt-dlp to extract audio and embed
  artwork/metadata.
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - Windows: download from https://ffmpeg.org and add it to PATH

## Setup

```bash
cd playlist-studio
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open **http://127.0.0.1:5005** in your browser. The seven starter playlists
are created automatically as empty folders on first run.

## Adding songs

Click **Add New Song**, paste a YouTube Music link
(`https://music.youtube.com/watch?v=…`) and hit Download & Add. yt-dlp fetches
the audio as MP3 with embedded artwork + metadata, then it's added to the end of
the current playlist with a default ✨ tag (change it in the player).

> Only download content you have the right to use. This tool is for managing your
> own library.

## Notes

- The position number, emoji, and order all live in the filename. The song's
  title, artist, duration and cover art are read from the file's embedded tags,
  so renaming never loses information.
- Everything is stored under `playlists/`. Back up or move that folder freely —
  the app reads whatever it finds there on the next refresh.
