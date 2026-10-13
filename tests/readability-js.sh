#!/usr/bin/env bash
# Use private sample HTML; never open a browser tab or fetch a real page.
set -euo pipefail
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/readability-js-test.XXXXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -m 700 "$test_dir/runtime"
mkdir "$test_dir/browser-data"
export XDG_RUNTIME_DIR="$test_dir/runtime" QUTE_DATA_DIR="$test_dir/browser-data"
export QUTE_FIFO="$test_dir/commands" QUTE_URL=https://example.invalid/article QUTE_MODE=command
python3 - "$test_dir" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
paragraph = 'This sample article verifies that a reader can extract useful text and store it outside its source repository. ' * 30
(root / 'article.html').write_text('<html><head><title>Reader regression check</title></head><body><article><h1>Reader regression check</h1><p>' + paragraph + '</p></article></body></html>')
(root / 'empty.html').write_text('<html><head><title>Empty page</title></head><body></body></html>')
PY
export QUTE_HTML="$test_dir/article.html"
: > "$QUTE_FIFO"
bash "$script_root/readability-js" > "$test_dir/stdout" 2> "$test_dir/stderr"
output="$XDG_RUNTIME_DIR/qutebrowser-readability/userscripts/readability.html"
rg -Fq 'Reader regression check' "$output"
rg -Fq 'extract useful text' "$output"
rg -Fq "$output" "$QUTE_FIFO"
[[ $(stat -c %a "$output") == 600 && ! -s $test_dir/stderr ]]
[[ ! -e $QUTE_DATA_DIR/userscripts ]]
previous=$(sha256sum "$output")
printf 'PASS: articles render in private runtime storage and emit a browser open command\n'

export QUTE_HTML="$test_dir/empty.html"
: > "$QUTE_FIFO"
bash "$script_root/readability-js" > "$test_dir/stdout" 2> "$test_dir/stderr"
rg -Fq 'message-info' "$QUTE_FIFO"
rg -Fq 'No readable article could be extracted from this page.' "$QUTE_FIFO"
! rg -q '^open ' "$QUTE_FIFO"
[[ ! -s $test_dir/stderr && $(sha256sum "$output") == "$previous" ]]
! compgen -G "$XDG_RUNTIME_DIR/qutebrowser-readability/.readability-js.*.js" >/dev/null
printf 'PASS: a page without an article reports a message, preserves prior output and cleans the patched copy\n'
