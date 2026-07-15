import os
import random

def parse_filename(filename):
    # Remove extension
    name = os.path.splitext(filename)[0]
    
    # Split by " - "
    parts = [p.strip() for p in name.split(" - ")]
    
    # Filter out empty strings if any
    parts = [p for p in parts if p]
    
    # The format seems to be:
    # [Number] - [Emoji] - [Optional Trash] - [Song] - [Artist] - [Optional Topic]
    
    # We expect at least Number, Emoji, Song, Artist.
    # But trash/topic might shift things.
    
    # Let's find where the "song" starts.
    # Usually part 0 is number, part 1 is emoji.
    curr_idx = 2
    
    # Check if part 2 is the trash emoji marker
    if len(parts) > curr_idx and "🗑️" in parts[curr_idx]:
        curr_idx += 1
        
    if len(parts) <= curr_idx:
        return None
        
    song = parts[curr_idx]
    artist = "Unknown Artist"
    
    if len(parts) > curr_idx + 1:
        artist = parts[curr_idx + 1]
        
    # Handle the "Topic" case if it exists in a further part
    # Or just keep it as part of the artist if we don't care to strip it.
    # The user wants "Song - Artist".
    
    return f"{song} - {artist}"

def main():
    base_dir = "playlists"
    target_folders = ["Reception 2", "Reception 3"]
    songs = []
    
    for folder in target_folders:
        folder_path = os.path.join(base_dir, folder)
        if not os.path.exists(folder_path):
            print(f"Warning: Folder {folder_path} does not exist.")
            continue
            
        for filename in os.listdir(folder_path):
            if filename.endswith(".mp3"):
                parsed = parse_filename(filename)
                if parsed:
                    songs.append(parsed)
    
    # Shuffle the songs
    # random.shuffle(songs)
    
    # Print them
    for song in songs:
        print(song)

if __name__ == "__main__":
    main()
