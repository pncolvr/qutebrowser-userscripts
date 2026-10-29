#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SRC_DIR="$script_root/custom/js"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/qutebrowser"
profile_root="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p -- "$config_root/greasemonkey" \
    "$profile_root/qutebrowser-webapp/config/greasemonkey" \
    "$profile_root/qutebrowser-twitch-chat/config/greasemonkey" \
    "$profile_root/qutebrowser-hobby/config/greasemonkey"
# Retire only links installed under the previous MotionFlow filename.
legacy_name="_c.js.youtube-smoothvision.js"
legacy_source=$(readlink -m -- "$SRC_DIR/youtube-smoothvision.js")
# Normalize the directory without following the legacy link itself. The main
# link is removed before secondary profiles, which may still point to its path.
legacy_main="$(readlink -m -- "$config_root/greasemonkey")/$legacy_name"
for legacy_dir in "$config_root/greasemonkey" \
    "$profile_root/qutebrowser-webapp/config/greasemonkey" \
    "$profile_root/qutebrowser-twitch-chat/config/greasemonkey" \
    "$profile_root/qutebrowser-hobby/config/greasemonkey"; do
  legacy="$legacy_dir/$legacy_name"
  if [[ -L $legacy ]]; then
    legacy_target=$(readlink -m -- "$legacy") || continue
    if [[ $legacy_target == "$legacy_source" ||
          $legacy_target == "$legacy_main" ]]; then
      rm -- "$legacy"
    fi
  fi
done
for f in "$SRC_DIR"/*.js; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  out_name="_c.js.$name"
  out="$config_root/greasemonkey/$out_name"
  ln -sf "$SRC_DIR/$name" "$out"
  ln -sf "$out" "$profile_root/qutebrowser-webapp/config/greasemonkey/$out_name"
  ln -sf "$out" "$profile_root/qutebrowser-twitch-chat/config/greasemonkey/$out_name"
  ln -sf "$out" "$profile_root/qutebrowser-hobby/config/greasemonkey/$out_name"
  echo "Generated $out"
done

helper_cache="${XDG_CACHE_HOME:-$HOME/.cache}/qute-motionflow"
pairing_root="${QUTE_CONFIG_DIR:-$config_root}"
python3 "$script_root/lib/motionflow/pair.py" "$helper_cache" "$pairing_root/greasemonkey"
