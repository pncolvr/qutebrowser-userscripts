# Qutebrowser userscripts

Custom executable userscripts live in this repository. Qutebrowser discovers them
by name in `~/.local/share/qutebrowser/userscripts`.

| Script | Purpose |
| --- | --- |
| `readability-js` | Run the packaged Mozilla reader with generated HTML in private session storage. |
| `to_mpv` | Play the current or hinted Twitch/YouTube URL in mpv with the existing window and chat integration. |

Use `:spawn --userscript to_mpv` for the current page or
`:hint links userscript to_mpv` to choose a link. It also accepts a URL argument
when run from a terminal. Dependencies are `mpv`, its video extractor, `playerctl`,
`hyprctl`, `jq`, and `logger`. Twitch chat uses
`${ZDOTDIR:-$HOME/.config/zsh}/scripts/default-browser/default-browser.sh`.

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
```

The media checks mock desktop commands. Reader checks use private sample HTML
and cover article rendering and extraction returning no article. The checks do
not play media, open browser tabs, or change window focus.

Generated `/readability.html` is ignored by Git as a fallback for direct calls to
the packaged readers. An already tracked copy must also be removed from the index.
