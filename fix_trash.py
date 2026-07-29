import os
import re
import uuid
import argparse
from pathlib import Path
from mutagen import File as MutagenFile
from app import read_audio_meta, sanitize

DEFAULT_FOLDER = Path("playlists/Reception 3")
CORRUPTED_PATTERN = re.compile(r"^\.?stage_[a-f0-9]+_(\d+)(?:\.\w+)?$")
RENUMBER_PATTERN = re.compile(r"^\.renumber_([a-f0-9]+)_(\d+)$")
RECOVERED_PATTERN = re.compile(r"^\d+\s*-\s*\.recover_[a-f0-9]+_\d+$")
POSITION_PATTERN = re.compile(r"^\s*(\d+)([a-z]*)\s*-\s*", re.IGNORECASE)


def _visible_files(folder):
    return [
        path for path in folder.iterdir()
        if path.is_file() and not path.name.startswith(".")
    ]


def fix_reception_corrupted_files(folder=DEFAULT_FOLDER):
    folder = Path(folder)
    pattern = CORRUPTED_PATTERN
    corrupted_files = []

    for file_path in folder.iterdir():
        if not file_path.is_file() or file_path.name == ".DS_Store":
            continue
        match = pattern.match(file_path.name)
        if match:
             corrupted_files.append((int(match.group(1)), file_path))

    corrupted_files.sort(key=lambda item: (item[0], item[1].name.lower()))

    counter = 1
    for _, file_path in corrupted_files:
        number = counter
        counter += 1

        # Check if it's likely a text divider (small file size, e.g. < 1000 bytes)
        if file_path.stat().st_size < 1000:
            try:
                content = file_path.read_text(encoding="utf-8").strip()
                name = sanitize(content) or "Divider"
                new_name = f"{number} - {name}.txt"
            except Exception:
                new_name = f"{number} - Unknown Divider.txt"
        else:
            # Read mp3 metadata
            meta = read_audio_meta(file_path)
            title = sanitize(meta["title"])
            artist = sanitize(meta["artist"])

            # Determine extension
            ext = ".mp3"  # default
            try:
                mf = MutagenFile(str(file_path))
                if mf and getattr(mf, "mime", None):
                    mime = mf.mime[0] if isinstance(mf.mime, list) else mf.mime
                    if "mp4" in mime or "m4a" in mime:
                        ext = ".m4a"
                    elif "flac" in mime:
                        ext = ".flac"
            except Exception:
                pass

            new_name = f"{number} - ✨ - {title} - {artist}{ext}"

        new_path = folder / new_name

        print(f"Renaming: '{file_path.name}' -> '{new_name}'")
        os.replace(str(file_path), str(new_path))


def _audio_extension(file_path):
    try:
        mf = MutagenFile(str(file_path))
        mime = getattr(mf, "mime", None) if mf else None
        mime = mime[0] if isinstance(mime, list) else mime
        if mime:
            extensions = {
                "audio/mp4": ".m4a",
                "audio/x-m4a": ".m4a",
                "audio/flac": ".flac",
                "audio/ogg": ".ogg",
                "audio/opus": ".opus",
                "audio/wav": ".wav",
            }
            for prefix, extension in extensions.items():
                if mime.startswith(prefix):
                    return extension
    except Exception:
        pass
    return ".mp3"


def _recovered_middle(file_path):
    """Return the filename portion after the position prefix."""
    if file_path.stat().st_size < 1000:
        try:
            name = sanitize(file_path.read_text(encoding="utf-8").strip())
        except (OSError, UnicodeError):
            name = "Unknown Divider"
        return f"{name or 'Divider'}.txt"

    meta = read_audio_meta(file_path)
    title = sanitize(meta["title"])
    artist = sanitize(meta["artist"])
    return f"✨ - {title} - {artist}{_audio_extension(file_path)}"


def repair_renumber_files(folder=DEFAULT_FOLDER):
    """Recover files left behind by an interrupted renumber operation."""
    folder = Path(folder)
    batches = {}
    for file_path in folder.iterdir():
        if not file_path.is_file():
            continue
        match = RENUMBER_PATTERN.fullmatch(file_path.name)
        if match:
            token, index = match.groups()
            batches.setdefault(token, []).append((int(index), file_path))

    all_visible = _visible_files(folder)
    recovered_leftovers = [path for path in all_visible if RECOVERED_PATTERN.fullmatch(path.name)]
    if not batches and not recovered_leftovers:
        return

    if recovered_leftovers and not batches:
        # This is the shape left by an older recovery attempt: the staged
        # batch follows the first visible six-song tail, with the final
        # staged files carrying a .recover name.
        tail = [
            path for path in all_visible
            if (
                POSITION_PATTERN.match(path.name)
                and POSITION_PATTERN.match(path.name).group(2) == ""
                and _position_sort_key(path)[0] <= 6
            )
        ]
        staged = [path for path in all_visible if path not in tail]
        ordered_sources = sorted(staged, key=_position_sort_key) + sorted(tail, key=_position_sort_key)
        derive_all_names = True
    else:
        staged = []
        for token, entries in sorted(batches.items()):
            for index, file_path in sorted(entries, key=lambda item: (item[0], item[1].name)):
                staged.append(file_path)
        visible = sorted(
            [path for path in all_visible if path not in set(staged)],
            key=_position_sort_key,
        )
        ordered_sources = staged + visible
        derive_all_names = False

    # Move every source out of the way before creating names that may collide.
    move_token = uuid.uuid4().hex[:8]
    staged_sources = []
    for index, source in enumerate(ordered_sources):
        temporary = folder / f".recover_{move_token}_{index:04d}"
        os.replace(str(source), str(temporary))
        staged_sources.append(temporary)

    for index, source in enumerate(staged_sources):
        if derive_all_names or index < len(staged):
            middle = _recovered_middle(source)
        else:
            middle = POSITION_PATTERN.sub("", ordered_sources[index].name, count=1)
        destination = folder / f"{index + 1} - {middle}"
        print(f"Restoring '{source.name}' -> '{destination.name}'")
        os.replace(str(source), str(destination))


def _position_sort_key(path):
    match = POSITION_PATTERN.match(path.name)
    if not match:
        return (float("inf"), "", path.name.lower())
    return (int(match.group(1)), match.group(2).lower(), path.name.lower())


def _divider_prefix(song_count, divider_count):
    if divider_count <= 26:
        letter = chr(ord("a") + divider_count - 1)
    else:
        letter = f"z{divider_count}"
    return f"{song_count}{letter}"


def renumber_playlist(folder=DEFAULT_FOLDER):
    """Normalize song and divider prefixes without changing playlist order."""
    folder = Path(folder)
    files = sorted(_visible_files(folder), key=_position_sort_key)
    if not files:
        return

    renamed = []
    song_count = 0
    divider_count = 0
    for file_path in files:
        if file_path.suffix.lower() == ".txt":
            divider_count += 1
            prefix = _divider_prefix(song_count, divider_count)
        else:
            song_count += 1
            divider_count = 0
            prefix = str(song_count)

        middle = POSITION_PATTERN.sub("", file_path.name, count=1)
        renamed.append((file_path, folder / f"{prefix} - {middle}"))

    token = uuid.uuid4().hex[:8]
    staged = []
    for index, (source, destination) in enumerate(renamed):
        temporary = folder / f".renumber_{token}_{index:04d}"
        os.replace(str(source), str(temporary))
        staged.append((temporary, destination))

    for (source, destination), (temporary, _) in zip(renamed, staged):
        if source.name != destination.name:
            print(f"Renaming: '{source.name}' -> '{destination.name}'")
        os.replace(str(temporary), str(destination))


def main():
    parser = argparse.ArgumentParser(description="Repair corrupted playlist files and normalize numbering.")
    parser.add_argument("--folder", type=Path, default=DEFAULT_FOLDER)
    parser.add_argument("--repair", action="store_true", help="Repair corrupted staged files.")
    parser.add_argument("--repair-renumber", action="store_true", help="Repair interrupted .renumber files.")
    parser.add_argument("--renumber", action="store_true", help="Normalize song and divider numbering.")
    args = parser.parse_args()

    any_action = args.repair or args.repair_renumber or args.renumber
    repair = args.repair or not any_action
    repair_renumber = args.repair_renumber or not any_action
    renumber = args.renumber or repair_renumber or not any_action
    if repair:
        fix_reception_corrupted_files(args.folder)
    if repair_renumber:
        repair_renumber_files(args.folder)
    if renumber:
        renumber_playlist(args.folder)

if __name__ == "__main__":
    main()