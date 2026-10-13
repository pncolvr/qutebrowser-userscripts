#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SRC_DIR="$script_root/custom/js"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/qutebrowser"
profile_root="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p -- "$config_root/greasemonkey" \
    "$profile_root/qutebrowser-webapp/config/greasemonkey" \
    "$profile_root/qutebrowser-twitch-chat/config/greasemonkey"
for f in "$SRC_DIR"/*.js; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  out_name="_c.js.$name"
  out="$config_root/greasemonkey/$out_name"
  ln -sf "$SRC_DIR/$name" "$out"
  ln -sf "$out" "$profile_root/qutebrowser-webapp/config/greasemonkey/$out_name"
  ln -sf "$out" "$profile_root/qutebrowser-twitch-chat/config/greasemonkey/$out_name"
  echo "Generated $out"
done
