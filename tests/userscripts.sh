#!/usr/bin/env bash
# Private fixtures and command mocks; no live clipboard, terminal or browser use.
set -euo pipefail
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/qutebrowser-userscripts-test.XXXXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/home" "$test_dir/browser-data/sessions"
export HOME="$test_dir/home" XDG_CONFIG_HOME="$test_dir/home/.config"
export XDG_CACHE_HOME="$test_dir/cache"
export XDG_DATA_HOME="$test_dir/home/.local/share" QUTE_DATA_DIR="$test_dir/browser-data"
export QUTE_CONFIG_DIR="$XDG_CONFIG_HOME/qutebrowser" QUTE_FIFO="$test_dir/commands"
export USERSCRIPTS_TEST_DIR="$test_dir" PATH="$test_dir/bin:$PATH"
mkdir -p "$QUTE_CONFIG_DIR/greasemonkey" "$XDG_CONFIG_HOME/quickshell/src/services/launcher"
cat > "$test_dir/bin/wl-copy" <<'MOCK'
#!/usr/bin/env bash
if (($#)); then printf '%s' "$1"; else cat; fi > "$USERSCRIPTS_TEST_DIR/clipboard"
MOCK
cat > "$test_dir/bin/ghostty" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1]' > "$USERSCRIPTS_TEST_DIR/terminal"
MOCK
cat > "$XDG_CONFIG_HOME/quickshell/src/services/launcher/launcher.sh" <<'MOCK'
#!/usr/bin/env bash
cat > "$USERSCRIPTS_TEST_DIR/choices"
[[ ${USERSCRIPTS_TEST_CANCEL:-0} == 0 ]] || exit 1
printf '%s\n' 'First tab'
MOCK
chmod +x "$test_dir/bin/"* "$XDG_CONFIG_HOME/quickshell/src/services/launcher/launcher.sh"

export QUTE_URL='https://www.youtube.com/watch?v=test&list=extra'
: > "$QUTE_FIFO"
"$script_root/clean_url"
[[ $(cat "$test_dir/clipboard") == 'https://www.youtube.com/watch?v=test' ]]
"$script_root/clean_url" 'https://example.test/explicit'
[[ $(cat "$test_dir/clipboard") == 'https://example.test/explicit' ]]
rg -Fq 'copied' "$QUTE_FIFO"
printf 'PASS: URL cleaner uses QUTE_URL or an explicit URL and keeps its clipboard behaviour\n'

cat > "$QUTE_DATA_DIR/sessions/_autosave.yml" <<'JSON'
{"windows":[{"tabs":[{"history":[{"active":true,"title":"First tab","url":"https://youtube.com/watch?v=one&list=extra"}]},{"history":[{"active":true,"title":"Second tab","url":"https://example.test/two"}]}]}]}
JSON
"$script_root/select_urls"
[[ $(cat "$test_dir/clipboard") == 'https://youtube.com/watch?v=one' ]]
rg -Fq 'Second tab' "$test_dir/choices"
before=$(cat "$test_dir/clipboard")
USERSCRIPTS_TEST_CANCEL=1 "$script_root/select_urls"
[[ $(cat "$test_dir/clipboard") == "$before" ]]
printf 'PASS: saved-tab selection keeps the Quickshell picker, URL cleanup and cancellation\n'

# Exercise qutebrowser's real parser and file-loading handler. JavaScript execution
# is captured by a fake tab; no browser window or website is used.
ln -s -- "$script_root" "$test_dir/scripts with spaces"
for action_root in "$script_root" "$test_dir/scripts with spaces"; do
    for name in mono unlockinsta home; do
        : > "$QUTE_FIFO"
        "$action_root/$name"
        python3 - "$QUTE_FIFO" "$action_root/js/$name.js" <<'PYTEST'
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from qutebrowser.browser import commands  # Registers the actual jseval command.
from qutebrowser.commands import parser

command_file, source = map(Path, sys.argv[1:])
parsed = parser.CommandParser().parse(command_file.read_text().rstrip('\n'))
assert parsed.cmd.name == 'jseval'
options = vars(parsed.cmd.parser.parse_args(parsed.args))
loaded = []
tab = SimpleNamespace(run_js_async=lambda code, **kwargs: loaded.append(code))
dispatcher = SimpleNamespace(_current_widget=lambda: tab, _jseval_cb=lambda _: None)
with patch('qutebrowser.browser.commands.standarddir.data', return_value=os.environ['QUTE_DATA_DIR']):
    parsed.cmd.handler(dispatcher, **options)
assert loaded == [source.read_text()], 'jseval must load the relocated JavaScript'
PYTEST
        node --check "$action_root/js/$name.js"
    done
done
printf 'PASS: page actions load through qutebrowser, including paths containing spaces\n'

node --input-type=module - "$script_root/js/unlockinsta.js" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.argv[2], 'utf8');
const assigned = [];
const context = {
    URL,
    encodeURIComponent,
    window: {
        location: {
            href: 'https://www.instagram.com/missmikkaa/',
            assign: url => assigned.push(url)
        }
    }
};
vm.runInNewContext(source, context);
assert.deepEqual(assigned, ['https://instapeep.com/?u=missmikkaa']);
console.log('PASS: UnlockInsta opens the matching InstaPeep profile');
JS

for name in certificate download; do
    "$script_root/$name"
    jq -e --arg root "$script_root" --arg name "$name" --arg url "$QUTE_URL" \
        '. == ["-e",($root+"/lib/hold.sh"),($root+"/lib/"+$name+".sh"),$url]' "$test_dir/terminal" >/dev/null
done
printf 'PASS: certificate and download entry points open their relocated terminal helpers\n'

export QUTE_URL='https://example.test/article'
: > "$QUTE_FIFO"
"$script_root/darkreader" toggle domain
mapfile -t generated < <(rg --files --hidden "$QUTE_CONFIG_DIR/greasemonkey")
[[ ${#generated[@]} == 1 ]]
rg -Fq '@include       https://example.test*' "${generated[0]}"
rg -Fq 'greasemonkey-reload' "$QUTE_FIFO"
"$script_root/darkreader" toggle domain
[[ ! -e ${generated[0]} ]]
printf 'PASS: Dark Reader toggles generated scripts in the active profile\n'

# Exercise the filename migration without removing independent user scripts.
legacy_name='_c.js.youtube-smoothvision.js'
legacy_main="$QUTE_CONFIG_DIR/greasemonkey/$legacy_name"
ln -s "$script_root/custom/js/youtube-smoothvision.js" "$legacy_main"
for profile in qutebrowser-webapp qutebrowser-twitch-chat qutebrowser-hobby; do
    mkdir -p "$XDG_DATA_HOME/$profile/config/greasemonkey"
done
ln -s "$legacy_main" "$XDG_DATA_HOME/qutebrowser-webapp/config/greasemonkey/$legacy_name"
printf '%s\n' '// independently installed user script' > "$XDG_DATA_HOME/qutebrowser-twitch-chat/config/greasemonkey/$legacy_name"
printf '%s\n' '// unrelated source' > "$test_dir/independent.js"
ln -s "$test_dir/independent.js" "$XDG_DATA_HOME/qutebrowser-hobby/config/greasemonkey/$legacy_name"
mkdir -p "$XDG_CACHE_HOME/qute-motionflow"
printf '%064d' 0 > "$XDG_CACHE_HOME/qute-motionflow/browser.token"
: > "$QUTE_FIFO"
"$script_root/apply_custom" > "$test_dir/generation"
[[ $(cat "$QUTE_FIFO") == $'greasemonkey-reload\nreload' ]]
for source in "$script_root"/custom/css/*.css; do
    name=${source##*/}; name=${name%.css}
    [[ -f $QUTE_CONFIG_DIR/greasemonkey/_g.css.$name.js ]]
done
for source in "$script_root"/custom/js/*.js; do
    name=${source##*/}
    [[ $(readlink -f "$QUTE_CONFIG_DIR/greasemonkey/_c.js.$name") == "$source" ]]
    for profile in qutebrowser-webapp qutebrowser-twitch-chat qutebrowser-hobby; do
        [[ $(readlink -f "$XDG_DATA_HOME/$profile/config/greasemonkey/_c.js.$name") == "$source" ]]
    done
done
for profile in qutebrowser-webapp qutebrowser-twitch-chat qutebrowser-hobby; do
    [[ $(readlink -f "$XDG_DATA_HOME/$profile/data/userscripts") == "$script_root" ]]
done
[[ ! -e $legacy_main && ! -L $legacy_main ]]
[[ ! -e $XDG_DATA_HOME/qutebrowser-webapp/config/greasemonkey/$legacy_name && ! -L $XDG_DATA_HOME/qutebrowser-webapp/config/greasemonkey/$legacy_name ]]
rg -Fq 'independently installed user script' "$XDG_DATA_HOME/qutebrowser-twitch-chat/config/greasemonkey/$legacy_name"
[[ $(readlink "$XDG_DATA_HOME/qutebrowser-hobby/config/greasemonkey/$legacy_name") == "$test_dir/independent.js" ]]
printf 'PASS: MotionFlow filename migration removes managed links and preserves independent files/links\n'
printf 'PASS: custom assets install into all profiles before reload\n'

paired="$QUTE_CONFIG_DIR/greasemonkey/_a.motionflow-auth.js"
[[ -f $paired && ! -L $paired && $(stat -c %a "$paired") == 600 ]]
rg -Fq '@qute-js-world user' "$paired"
rg -Fq 'event.isTrusted' "$paired"
for profile in qutebrowser-webapp qutebrowser-twitch-chat qutebrowser-hobby; do
    [[ ! -e $XDG_DATA_HOME/$profile/config/greasemonkey/_a.motionflow-auth.js ]]
done
printf 'PASS: private MotionFlow pairing is restricted to the active profile and trusted video controls\n'

# Canonical targets must also work through relative paths and directory aliases,
# even after the renamed source and the main legacy link no longer exist.
relative_source=$(python3 - "$script_root/custom/js/youtube-smoothvision.js" "${legacy_main%/*}" <<'PYTEST'
import os,sys
print(os.path.relpath(sys.argv[1],sys.argv[2]))
PYTEST
)
ln -s -- "./$relative_source" "$legacy_main"
legacy_secondary="$XDG_DATA_HOME/qutebrowser-webapp/config/greasemonkey/$legacy_name"
relative_main=$(python3 - "$legacy_main" "${legacy_secondary%/*}" <<'PYTEST'
import os,sys
print(os.path.relpath(sys.argv[1],sys.argv[2]))
PYTEST
)
ln -s -- "$relative_main" "$legacy_secondary"
"$script_root/lib/js-apply.sh" > "$test_dir/relative-generation"
[[ ! -L $legacy_main && ! -L $legacy_secondary ]]
ln -s -- "$test_dir/scripts with spaces/custom/js/../js/youtube-smoothvision.js" "$legacy_main"
"$script_root/lib/js-apply.sh" > "$test_dir/aliased-generation"
[[ ! -L $legacy_main ]]
rg -Fq 'independently installed user script' "$XDG_DATA_HOME/qutebrowser-twitch-chat/config/greasemonkey/$legacy_name"
[[ $(readlink "$XDG_DATA_HOME/qutebrowser-hobby/config/greasemonkey/$legacy_name") == "$test_dir/independent.js" ]]
printf 'PASS: legacy migration resolves relative, aliased and dangling managed targets without deleting independent scripts\n'
