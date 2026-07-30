#!/usr/bin/env python3
"""Replace playlist divider files using fuzzy song-title anchors.

Run without arguments for a dry run. Pass ``--apply`` to change the files.
The matcher intentionally uses the song title as the primary signal because
artists in downloaded filenames often contain channel or remix suffixes.
"""

import argparse
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
PLAYLISTS_DIR = BASE_DIR / "playlists"
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac", ".webm"}
POSITION_PATTERN = re.compile(r"^\s*(\d+)([a-z]*)\s*-\s*(.*)$", re.IGNORECASE)
EMOJIS = {"💞", "✨", "🍂", "🕺", "🗑️"}


# Only section starts are needed to place dividers. The complete requested
# order is represented here so a moved or renamed song is still easy to audit.
SECTIONS = {
    "Cocktails + Din": [
        ("Modern Love", "Let's Get Married", "bleachers"),
        ("Indie Heartstrings", "Good Riddance (Time of Your Life)", "Green Day"),
        ("2000s Sweethearts", "You Belong With Me", "Taylor Swift"),
        ("Old-School Romance", "I Want It That Way", "Backstreet Boys"),
        ("Soft Landing", "You'll Be In My Heart", "Phil Collins"),
    ],
    "Pizza Party": [
        ("Sunny Day Vibes", "Mr. Blue Sky", "Electric Light Orchestra"),
        ("Classic Singalongs", "This Love", "Maroon 5"),
        ("Dirt Road Anthems", "Heart of Gold (2009 Remaster)", "Neil Young"),
        ("Indie Folk Feels", "I Will Wait", "Mumford & Sons"),
        ("Pop Grab Bag", "Sunflower (Spider-Man Into the Spider-Verse)", "Post Malone, Swae Lee"),
        ("Rock 'n' Roll Jukebox", "What I Like About You", "The Romantics"),
        ("90s Alt Rock", "Semi-Charmed Life", "Third Eye Blind"),
        ("Dance Floor Classics", "One Way Or Another", "Blondie"),
        ("2010s Pop Bangers", "We Don't Talk Anymore", "Charlie Puth"),
        ("Modern Alt-Pop", "bad guy", "Billie Eilish"),
        ("Emo & Indie Throwback", "Check Yes, Juliet", "We The Kings"),
    ],
    "Wedding Reception": [
        ("First Dance", "The One", "Kodaline"),
        ("Disco Ball Divas", "I'm Good (Blue)", "David Guetta, Bebe Rexha"),
        ("Rock Opera Hour", "Bohemian Rhapsody (Remastered 2011)", "Queen"),
        ("Ballad Breather", "Your Song", "Elton John"),
        ("Girl Power Hour", "Man! I Feel Like A Woman!", "Shania Twain"),
        ("Slow Dance Break", "Thinking out Loud", "Ed Sheeran"),
        ("Classic Rock Singalong", "Piano Man", "Billy Joel"),
        ("Pop Party Grab Bag", "What Dreams Are Made Of", "Hilary Duff"),
        ("70s & 80s Icons", "Your Love", "The Outfield"),
        ("Dance Floor Pop", "Blinding Lights", "The Weeknd"),
        ("2000s Pop & R&B", "Wrecking Ball", "Miley Cyrus"),
        ("90s Throwback", "No Scrubs", "TLC"),
        ("Retro Pop Bops", "Girlfriend", "Avril Lavigne"),
        ("Funk & Hip-Hop", "Hey Ya!", "OutKast"),
        ("Pop-Punk & Emo", "I Write Sins Not Tragedies", "Panic! At The Disco"),
        ("Indie Rock Rave-Up", "I Bet You Look Good On The Dancefloor", "Arctic Monkeys"),
        ("Country Hoedown", "Save a Horse (Ride a Cowboy)", "Big & Rich"),
        ("A Bit Of Everything", "Gimme! Gimme! Gimme! (A Man After Midnight)", "ABBA"),
        ("R&B & Pop Bangers", "Jenny from the Block (Track Masters Remix)", "Jennifer Lopez"),
        ("EDM Rave", "Party Rock Anthem", "LMFAO"),
        ("Eurodance Throwback", "Everytime We Touch", "Cascada"),
        ("Hip-Hop Grind", "Coconuts", "Kim Petras"),
        ("TikTok Trash", "Man In Finance (G6 Trust Fund)", "Girl On Couch"),
        ("Last Call Classics", "Come Together (Remastered 2009)", "The Beatles"),
    ],
}

FOLDER_GROUPS = {
    "Pizza Party": ["Pizza Party", "Pizza Party 2"],
}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = value.casefold().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", value)


def parse_song(path: Path):
    match = POSITION_PATTERN.match(path.name)
    if not match or path.suffix.casefold() not in AUDIO_EXTENSIONS:
        return None
    middle = match.group(3)
    middle = middle[:-len(path.suffix)]
    parts = middle.rsplit(" - ", 1)
    if len(parts) != 2:
        return (middle, "")
    title, artist = parts
    if title.split(" - ", 1)[0].strip() in EMOJIS:
        title = title.split(" - ", 1)[1]
    return title.strip(), artist.strip()


def song_score(song, wanted_title, wanted_artist):
    title, artist = song
    title_score = SequenceMatcher(None, normalize(title), normalize(wanted_title)).ratio()
    artist_score = SequenceMatcher(None, normalize(artist), normalize(wanted_artist)).ratio()
    if normalize(wanted_title) in normalize(title):
        title_score = max(title_score, 0.92)
    return title_score * 0.8 + artist_score * 0.2


def find_anchor(files, title, artist, used):
    candidates = []
    for index, path in enumerate(files):
        if index in used:
            continue
        song = parse_song(path)
        if song is None:
            continue
        score = song_score(song, title, artist)
        candidates.append((score, index, path, song))
    candidates.sort(reverse=True, key=lambda item: item[0])
    if not candidates or candidates[0][0] < 0.68:
        raise ValueError(f"could not match {title!r} by {artist!r}")
    if len(candidates) > 1 and candidates[0][0] - candidates[1][0] < 0.04:
        raise ValueError(f"ambiguous match for {title!r} by {artist!r}")
    return candidates[0]


def divider_name(song_index, divider_number, title):
    suffix = chr(ord("a") + divider_number)
    return f"{song_index}{suffix} - {title}.txt"


def process_playlist(name, sections, apply):
    folder_names = FOLDER_GROUPS.get(name, [name])
    folder_files = {}
    songs = []
    local_song_indexes = {}
    for folder_name in folder_names:
        folder = PLAYLISTS_DIR / folder_name
        files = sorted(
            (path for path in folder.iterdir() if path.is_file() and POSITION_PATTERN.match(path.name)),
            key=lambda path: (int(POSITION_PATTERN.match(path.name).group(1)), path.name.casefold()),
        )
        folder_files[folder_name] = files
        folder_songs = [path for path in files if parse_song(path) is not None]
        for index, path in enumerate(folder_songs):
            local_song_indexes[path] = index
        songs.extend(folder_songs)
    used = set()
    anchors = []
    for title, song_title, artist in sections:
        score, index, path, song = find_anchor(songs, song_title, artist, used)
        used.add(index)
        anchors.append((index, title, score, path.name))

    if any(left[0] >= right[0] for left, right in zip(anchors, anchors[1:])):
        raise ValueError(f"section anchors are out of order in {name}")

    old_dividers = [
        path for files in folder_files.values() for path in files
        if path.suffix.casefold() == ".txt"
    ]
    new_dividers = []
    divider_counts = {folder_name: 0 for folder_name in folder_names}
    for song_index, title, score, source_name in anchors:
        source_path = next(path for path in songs if path.name == source_name)
        folder_name = source_path.parent.name
        local_index = local_song_indexes[source_path]
        new_name = divider_name(local_index, divider_counts[folder_name], title)
        divider_counts[folder_name] += 1
        new_dividers.append((folder_name, new_name, score, source_name))

    print(f"[{name}]")
    print(f"  remove {len(old_dividers)} old divider(s)")
    for folder_name, new_name, score, source_name in new_dividers:
        print(f"  add {folder_name}/{new_name} <- {source_name} ({score:.2f})")

    if not apply:
        return
    for path in old_dividers:
        path.unlink()
    for folder_name, new_name, _, _ in new_dividers:
        folder = PLAYLISTS_DIR / folder_name
        (folder / new_name).write_text(new_name.split(" - ", 1)[1][:-4], encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the new divider files")
    args = parser.parse_args()
    for name, sections in SECTIONS.items():
        process_playlist(name, sections, args.apply)
    print("Dry run only; pass --apply to write changes." if not args.apply else "Applied.")


if __name__ == "__main__":
    main()