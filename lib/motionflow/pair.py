"""Pair the isolated userscript world with the loopback helper."""

from pathlib import Path
import argparse
import json
import os
import secrets


def ensure_token(cache):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / 'browser.token'
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, 'w') as output:
            output.write(secrets.token_hex(32))
    token = path.read_text().strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise RuntimeError('Invalid browser pairing token')
    path.chmod(0o600)
    return token


def install(cache, destination):
    path = Path(cache) / 'browser.token'
    target = Path(destination) / '_a.motionflow-auth.js'
    if not path.exists():
        return
    token = ensure_token(cache)
    target.parent.mkdir(parents=True, exist_ok=True)
    code = '''// ==UserScript==
// @name MotionFlow local pairing
// @match http://*/*
// @match https://*/*
// @grant none
// @qute-js-world user
// @run-at document-start
// ==/UserScript==
// Local credential, generated outside the source repository.
(()=>{
  const w=document.defaultView;
  // Remain inactive on ordinary pages. Only a real interaction with video
  // enhancement controls provisions this isolated-world credential.
  document.addEventListener('click',event=>{
    if(!event.isTrusted||w.__motionFlowAuth||!document.querySelector('video:not(#qute-motionflow-output)'))return;
    if(!event.target?.closest?.('#qute-motionflow-options,#qute-motionflow-panel'))return;
    Object.defineProperty(w,'__motionFlowAuth',{value:{token:TOKEN}});
  },true);
})();
'''.replace('TOKEN', json.dumps(token))
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(code)
    target.chmod(0o600)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    install(args.cache, args.destination)
