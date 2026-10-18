#!/usr/bin/env bash
# Mock desktop commands; never launch a player or change browser focus.
set -euo pipefail
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/to-mpv-test.XXXXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/home"
export HOME="$test_dir/home" TO_MPV_TEST_DIR="$test_dir"
export PATH="$test_dir/bin:$PATH"
cat > "$test_dir/bin/mpv" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]' > "$TO_MPV_TEST_DIR/mpv"
sleep 0.1
exit "${TO_MPV_TEST_EXIT:-0}"
MOCK
cat > "$test_dir/bin/hyprctl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TO_MPV_TEST_DIR/hyprctl"
if [[ $1 == clients ]]; then
    printf '[{"class":"mpv-youtube"},{"class":"mpv-twitch"}]\n'
fi
MOCK
cat > "$test_dir/bin/playerctl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TO_MPV_TEST_DIR/playerctl"
if [[ $1 == --list-all ]]; then printf 'chromium.instance.test\n'; fi
MOCK
cat > "$test_dir/bin/logger" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$test_dir/bin/qutebrowser" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]' > "$TO_MPV_TEST_DIR/browser"
MOCK
chmod +x "$test_dir/bin/"*

QUTE_URL='https://www.youtube.com/watch?v=test&list=extra' bash "$script_root/to_mpv"
jq -e '. == ["--force-window=immediate","--wayland-app-id=mpv-youtube","https://www.youtube.com/watch?v=test"]' "$test_dir/mpv" >/dev/null
rg -Fq -- '--player chromium.instance.test pause' "$test_dir/playerctl"
rg -Fq 'class:mpv-youtube' "$test_dir/hyprctl"
[[ ! -e $test_dir/browser ]]
printf 'PASS: QUTE_URL, YouTube cleanup, immediate window, app class and browser pause\n'

QUTE_URL='https://www.twitch.tv/test_channel?foo=bar' bash "$script_root/to_mpv"
jq -e '. == ["--force-window=immediate","--wayland-app-id=mpv-twitch","https://www.twitch.tv/test_channel?foo=bar"]' "$test_dir/mpv" >/dev/null
jq -e --arg home "$HOME" '. == ["--desktop-file-name","qutebrowser-twitch-chat","--target","window","-C",($home + "/.config/qutebrowser/config.py"),"-B",($home + "/.local/share/qutebrowser-twitch-chat"),"https://www.twitch.tv/popout/test_channel/chat?popout="]' "$test_dir/browser" >/dev/null
[[ $(rg -c 'class:qutebrowser-twitch-chat' "$test_dir/hyprctl") == 2 ]]
printf 'PASS: Twitch chat opening, channel parsing and window cleanup preserved\n'

QUTE_URL='https://www.twitch.tv/ignored' bash "$script_root/to_mpv" 'https://youtube.com/watch?v=explicit'
jq -e '.[2] == "https://youtube.com/watch?v=explicit"' "$test_dir/mpv" >/dev/null
TO_MPV_TEST_EXIT=7 QUTE_URL='https://youtube.com/watch?v=failure' bash "$script_root/to_mpv"
rg -Fq 'Playback failed' "$test_dir/hyprctl"
status=0
QUTE_URL='' bash "$script_root/to_mpv" 2> "$test_dir/error" || status=$?
[[ $status == 2 ]]
rg -Fq 'Usage: to_mpv' "$test_dir/error"
before=$(cat "$test_dir/mpv")
status=0
QUTE_URL='https://example.test/video' bash "$script_root/to_mpv" || status=$?
[[ $status == 1 && $(cat "$test_dir/mpv") == "$before" ]]
printf 'PASS: standalone URL override, playback failure notification and invalid/missing URLs\n'
