import os
import re
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3

def get_song_info(file_path):
    try:
        audio = EasyID3(file_path)
        title = audio.get('title', [os.path.splitext(os.path.basename(file_path))[0]])[0]
        artist = audio.get('artist', ['Unknown Artist'])[0]
        return f"{title} - {artist}"
    except Exception:
        # Fallback to filename parsing if metadata fails
        filename = os.path.basename(file_path)
        name_without_ext = os.path.splitext(filename)[0]
        parts = name_without_ext.split(" - ")
        if len(parts) >= 2:
            return f"{parts[-2]} - {parts[-1]}"
        return name_without_ext

def sort_key(filename):
    # Extract the leading number
    match = re.match(r'^(\d+)', filename)
    if match:
        return int(match.group(1))
    return float('inf')  # Put files without numbers at the end

def process_folders(folder_names):
    base_dir = "playlists"
    
    for folder_name in folder_names:
        folder_path = os.path.join(base_dir, folder_name)
        if not os.path.isdir(folder_path):
            print(f"Directory not found: {folder_path}")
            continue
            
        # Get mp3 files
        files = [f for f in os.listdir(folder_path) if f.lower().endswith(".mp3")]
        
        # Sort files by filename number
        sorted_files = sorted(files, key=sort_key)
        
        for filename in sorted_files:
            file_path = os.path.join(folder_path, filename)
            song_info = get_song_info(file_path)
            print(song_info)

if __name__ == "__main__":
    target_folders = ["Wedding Reception", "Reception 2", "Reception 3"]
    process_folders(target_folders)
