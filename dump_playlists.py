#!/usr/bin/env python3
"""Print playlist files in playback order, including text section names."""

import argparse
import re
import sys
from pathlib import Path

POSITION_PATTERN = re.compile(r"^\s*(\d+)([a-z]*)\s*-\s*(.*)$", re.IGNORECASE)


def position_sort_key(path: Path):
    match = POSITION_PATTERN.match(path.name)
    if not match:
        return (float("inf"), "", path.name.casefold())
    number, suffix, _ = match.groups()
    return (int(number), suffix.casefold(), path.name.casefold())


def display_name(path: Path) -> str:
    """Return the section name stored in a .txt file, with a filename fallback."""
    try:
        section_name = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        section_name = ""
    return section_name or path.stem


def dump_playlists(playlists_dir: Path) -> str:
    lines = []
    playlist_dirs = sorted(
        (path for path in playlists_dir.iterdir() if path.is_dir()),
        key=lambda path: path.name.casefold(),
    )

    for playlist_dir in playlist_dirs:
        files = sorted(
            (
                path for path in playlist_dir.iterdir()
                if path.is_file()
                and not path.name.startswith(".")
                and POSITION_PATTERN.match(path.name)
            ),
            key=position_sort_key,
        )
        if not files:
            continue

        lines.append(f"[{playlist_dir.name}]")
        for path in files:
            match = POSITION_PATTERN.match(path.name)
            position = match.group(1) + match.group(2)
            if path.suffix.casefold() == ".txt":
                lines.append(f"{position}: [SECTION] {display_name(path)}")
            else:
                lines.append(f"{position}: {path.name}")
        lines.append("")

    return "\n".join(lines).rstrip()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Dump playlist files in numeric prefix order."
    )
    parser.add_argument(
        "playlists_dir",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parent / "playlists",
        help="Directory containing playlist subfolders (default: ./playlists)",
    )
    args = parser.parse_args()

    if not args.playlists_dir.is_dir():
        parser.error(f"not a directory: {args.playlists_dir}")
    print(dump_playlists(args.playlists_dir))


if __name__ == "__main__":
    main()
