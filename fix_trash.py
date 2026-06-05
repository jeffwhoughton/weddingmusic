import os
import re
from pathlib import Path
from mutagen import File as MutagenFile
from app import read_audio_meta, sanitize

def fix_reception_corrupted_files():
    folder = Path("playlists/Wedding Reception")
    pattern = re.compile(r"^\.?stage_[a-f0-9]+_(\d+)(?:\.\w+)?$")
    
    counter = 1
    for file_path in folder.iterdir():
        if not file_path.is_file() or file_path.name == ".DS_Store":
            continue
            
        m = pattern.match(file_path.name)
        if m:
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

if __name__ == "__main__":
    fix_reception_corrupted_files()