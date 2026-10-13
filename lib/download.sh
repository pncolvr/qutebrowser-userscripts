#!/usr/bin/env bash

URL="$1"
DIRECTORY=$(echo "$URL" | awk -F/ '{print $3}' | awk -F '.' '{print $2}')
yt-dlp -o "$HOME/Videos/$DIRECTORY/%(uploader)s/%(title)s.%(ext)s" "$URL"
