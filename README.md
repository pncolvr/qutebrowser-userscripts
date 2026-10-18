# Qutebrowser userscripts

Custom executable userscripts live in this repository. Qutebrowser discovers them
by name in `~/.local/share/qutebrowser/userscripts`.

| Script | Purpose |
| --- | --- |
| `readability-js` | Run the packaged Mozilla reader with generated HTML in private session storage. |
| `clean_url` / `select_urls` | Copy cleaned page/link URLs or selected saved tabs. |
| `certificate` / `download` | Show the TLS certificate or download a video in Ghostty. |
| `mono` / `unlockinsta` / `home` | Run page JavaScript actions. |
| `darkreader` | Toggle Dark Reader for a domain. |
| `apply_custom` | Install custom CSS/JavaScript, then reload Greasemonkey and the page. |
| `cookie-cleaner.sh` | Interactively remove cookies from a closed browser profile. |
| `to_mpv` | Play the current or hinted Twitch/YouTube URL in mpv with the existing window and chat integration. |
| `qute-rbw` | Private rbw helper for the browser-owned `>bw` credential operation. |

Use `:spawn --userscript to_mpv` for the current page or
`:hint links userscript to_mpv` to choose a link. It also accepts a URL argument
when run from a terminal. Dependencies are `mpv`, its video extractor, `playerctl`,
`hyprctl`, `jq`, and `logger`. Twitch chat opens directly in qutebrowser using
the dedicated `qutebrowser-twitch-chat` profile.

The `readability-js` wrapper redirects generated articles outside this repository.
The `,rr` binding calls this wrapper by name. Use `readability-js` rather than an
absolute path to the packaged script in `/usr/share`, which bypasses the wrapper.

The JavaScript reader wrapper uses the libraries installed under
`~/.local/share/qutebrowser/readability-js/node_modules`. It adds a no-article
guard to a temporary copy of the packaged script; a page
that cannot be extracted produces a browser message rather than a crash. The
copy is removed when the process exits. Its HTML output goes to
`$XDG_RUNTIME_DIR/qutebrowser-readability/userscripts/readability.html`.

Run the userscript checks with:

```sh
bash tests/to_mpv.sh
bash tests/readability-js.sh
bash tests/userscripts.sh
```

The media checks mock desktop commands. Reader checks use private sample HTML
and cover article rendering and extraction returning no article. The checks do
not play media, open browser tabs, or change window focus.

Generated `/readability.html` is ignored by Git as a fallback for direct calls to
the packaged readers. An already tracked copy must also be removed from the index.

## Layout

Root executables are launched by name with `spawn --userscript`. `lib/` contains
shared shell helpers, `js/` contains page actions, and `custom/` contains site
CSS and Greasemonkey scripts. The browser config keeps the global scrollbar CSS.
The custom installers update the main, webapp and Twitch-chat profiles. Editor
tasks for rebuilding them live in this repository. `apply_custom` also links the
shared userscripts into each profile's `data/userscripts` directory when absent,
so bindings by name work with their separate `--basedir` directories.

URL selection uses the existing Quickshell picker and `yq`/`jq`. Certificate
inspection needs OpenSSL; downloads use yt-dlp. Cookie cleanup uses fzf/sqlite3
and must be run after closing qutebrowser. `cookie-jar` in Zsh calls it here.

## rbw autofill

Focus a login field and press `>bw`, or use `:rbw-fill` in qutebrowser. The
browser captures the original tab/document, starts `qute-rbw`, and always asks
you to confirm an entry and destination in Quickshell. The entry picker preserves
the pointer position so the browser interaction can resume where it started.
This is shared launcher behavior; the client sends no pointer-specific option.
The helper supports rbw
1.15.x; it does not handle the master password or cache unlock tokens. rbw's
agent and the Quickshell pinentry adapter own unlocking.

Only the selected entry is retrieved. UUID, URI matching and the encrypted
cache's master-password-reprompt flag are checked before credentials are served
once over a private socket. Browser commands carry a handle, never credentials.
Do not invoke `qute-rbw` directly with `spawn --userscript`: the browser command
must own the pending operation. Username/password/TOTP-only modes use
`:rbw-fill username`, `:rbw-fill password` and `:rbw-fill totp`.

Setup, compatibility limits and every new cross-repository test are in
`~/.config/quickshell/docs/features/rbw.md` and `tests/security/rbw/` in the
Quickshell repository. Protected/unknown entries, regex-only matching rules,
unsupported forms/frames and line breaks in credentials are refused. No form is
submitted and no credential is copied to the clipboard automatically.

An unfocused or unsupported field produces a focus message. Launcher startup or
reply failures produce `rbw: entry picker unavailable; check Quickshell.`;
`rbw: cancelled.` indicates cancellation rather than a launcher command failure.
