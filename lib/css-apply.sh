#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SRC_DIR="$script_root/custom/css"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/qutebrowser"
profile_root="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p -- "$config_root/greasemonkey" \
    "$profile_root/qutebrowser-webapp/config/greasemonkey" \
    "$profile_root/qutebrowser-twitch-chat/config/greasemonkey"
rm -f "$config_root/greasemonkey"/_g.css.*.js
for f in "$SRC_DIR"/*.css; do
  [ -f "$f" ] || continue
  name="$(basename "${f%.css}")"
  out_name="_g.css.$name.js"
  out="$config_root/greasemonkey/$out_name"
  content=$(cat "$f")
  cat > "$out" <<EOF
// ==UserScript==
// @name         $name
// @namespace    http://$name/
// @version      0.1
// @description  $name
// @author       pncolvr
// @match        https://$name/*
// @match        https://*.$name/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    GM_addStyle(\`
$content
\`)
})();
EOF
  ln -sf "$out" "$profile_root/qutebrowser-webapp/config/greasemonkey/$out_name"
  ln -sf "$out" "$profile_root/qutebrowser-twitch-chat/config/greasemonkey/$out_name"
  echo "Generated $out"
done
