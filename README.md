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
| `motionflow-helper` | Set up, start, restart, stop or inspect the local MotionFlow GPU helper. |
| `install-motionflow` | Install its user launcher and desktop entry; print the Hyprland startup line. |
| `apply_custom` | Restart the configured MotionFlow helper, install custom CSS/JavaScript, then reload Greasemonkey and the page. |
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
node tests/twitch-ads.cjs
```

The media checks mock desktop commands. Reader checks use private sample HTML
and cover article rendering and extraction returning no article. The checks do
not play media, open browser tabs, or change window focus.

Generated `/readability.html` is ignored by Git as a fallback for direct calls to
the packaged readers. An already tracked copy must also be removed from the index.

## Preview the Twitch ad badge

With the Twitch userscript enabled and a stream playing normally, open the
developer console (`:devtools`) and paste this snippet. Change `seconds` to choose
the duration. It simulates the ad mini-player that the userscript detects, so the
stream is temporarily muted and the real badge appears. No ad is downloaded.
When the timer ends, the userscript hides the badge and restores your previous
mute state and volume on its next poll (within about 500 ms).

```js
(() => {
  const seconds = 10;
  const id = 'qute-twitch-ad-preview';
  const mainVideo = document.querySelector('div.video-ref video');
  const currentAd = document.querySelector('div.picture-by-picture-player');
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Choose a positive number of seconds.');
  }
  if (document.getElementById(id)) {
    throw new Error('An ad preview is already running.');
  }
  if (!mainVideo) {
    throw new Error('Wait for the Twitch player to finish loading.');
  }
  if (currentAd && !currentAd.classList.contains('picture-by-picture-player--collapsed')) {
    throw new Error('Wait for the current ad to finish.');
  }

  const preview = document.createElement('div');
  preview.id = id;
  preview.className = 'picture-by-picture-player';
  preview.hidden = true;
  const miniVideo = document.createElement('video');
  miniVideo.hidden = true;
  preview.appendChild(miniVideo);
  document.body.prepend(preview);
  console.info(`[Twitch Ads Preview] Entering ad mode for ${seconds} seconds.`);

  setTimeout(() => {
    preview.remove();
    miniVideo.remove();
    console.info('[Twitch Ads Preview] Exiting ad mode; audio will restore on the next poll.');
  }, seconds * 1000);
})();
```

Run it once with audio enabled and once with audio already muted to check both
restoration cases. Keep the stream open until the preview finishes. If a real ad
starts during the preview, ad mode continues until that ad ends.
After each preview, check that play/pause, mute and the volume slider still work.

## MotionFlow video enhancement

Two userscripts share the same controller, workers, settings and local helper:

- `custom/js/youtube-motionflow.js` integrates with YouTube's player controls.
- `custom/js/video-motionflow.js` adds a floating settings icon to other HTTP(S)
  pages with a visible HTML video, including Twitch-style players. It excludes
  the dedicated YouTube hosts to avoid duplicate controls. The largest playing
  visible video is selected. Videos in accessible player frames can run their
  own instance; closed shadow roots and browser-native video fullscreen controls
  are not supported.

Independent implementation: no code from the original extension is included.
Credit for the original project and inspiration goes to **Arunhari124**:
[Live 60 fps converting extension for YouTube](https://github.com/Arunhari124/Live-60-fps-converting-extension-for-youtube).
The optional AI backend uses the separately developed RIFE 4.25 model, credited
below. Upscaling defaults to GPU Lanczos-3; Real-ESRGAN detail reconstruction is an optional method.

Run `>gr` or `:spawn --userscript apply_custom` to install/reload both scripts and
pairing for the active browser profile. Each new video page starts with processing
off; replacing the player within the same video page retains your choices.

### Settings

- **Motion smoothing:** starts or stops frame interpolation at the selected FPS.
  **Upscaling** independently starts or stops the selected upscaler, including when smoothing
  is off. Turning both off holds the last processed picture, seeks the original
  to its displayed timestamp, and releases native audio once the sought frame is
  ready. Playing video keeps playing and paused video stays paused. This requires
  a seekable file or live DVR window; an unavailable seek is reported in the panel.
  Workers and added audio delay are released during this handoff. Settings
  restarts also seek back to the visible position before preparing new output.
- **Mono audio:** mixes the video channels to mono through both speakers. Switch
  it off to restore the original channels. It works independently of smoothing
  and upscaling, keeps the current audio delay, and crossfades channel changes.
  Each new video starts with mono off. Protected or cross-origin-restricted audio
  may be unavailable; the panel shows the error without taking over its audio.
- **FPS:** 24, 30, 45, 60, or a custom value from 1–240 (including fractional FPS).
  FPS choices only select the target; they never enable or disable processing.
  A lower target caps faster video by selecting source frames before pixel copying,
  transfer or upscaling. Upscaling honors this cap even with motion smoothing off.
  A higher target interpolates only when motion smoothing is on. Dropped frames
  retain source timestamps; playback speed and the audio timeline do not change.
  Type a custom value and press Enter or leave the field to select it. With this
  qutebrowser configuration, click the field and press `i` first: automatic insert
  mode is disabled (`input.insert_mode.auto_enter = false`). Resolution,
  buffer and content choices also leave the operation switches unchanged.
  Choices survive navigation within the current document; full reload restores defaults.
- **Resolution:** Auto, Source (no enlargement, up to 1080p), 480p, 720p, 1080p, 1440p or 2160p/4K.
  With upscaling off, Auto keeps the 60 fps/720p and 45 fps/1080p interpolation
  defaults. With upscaling on, Auto requests 2× the source dimensions, bounded by
  3840×2160. Source never enlarges a low-resolution video.
  Aspect ratio is always preserved. The **Upscaling** switch allows output larger
  than the source. With it off, smaller sources are never enlarged.
- **Upscaler:** **Lanczos** is the default: a separable Lanczos-3 filter on the
  local GPU, with native CPU Lanczos as a fallback. It resizes without inventing
  detail and needs no super-resolution weights. Statistics report the actual
  GPU/CPU backend. The **AI · Real-ESRGAN** option enables detail reconstruction. The
  compact general-x4v3 and AnimeVideo-v3 models synthesize plausible detail; they
  can alter faces, textures and text. They do not recover ground-truth detail.
  The panel shows the selected method, AI model/strength where applicable, and
  source/output dimensions. Content profiles adjust the AI method; the Lanczos
  filter remains the same across profiles.
  Processing order is **interpolate → upscale → output conversion**.
  Interpolation runs at source resolution or the selected smaller size, up to
  1080p, before upscaling. Overlapping GPU tiles bound activation memory. Model
  resizing, profile blending and byte conversion stay on the GPU; the stitched
  grid is fitted to the requested dimensions without filter seams.
  Interpolation output, SR tile padding/stitching, Lanczos fitting, and BT.709
  delivery conversion share GPU image buffers. The helper downloads the final
  delivery pixels instead of round-tripping full RGBA images between stages.
  Blocking CUDA completion events let the host sleep while the GPU works.
  First-use RIFE compilation has an explicit preparation phase; playback holds
  and restarts from the displayed position once the model is cached, rather than
  timing out a normal frame request or requiring a manual backward seek.
  Browser capture, input-format conversion, duplicate/cut checks and WebSocket
  delivery still involve CPU work. Native CPU conversion remains a fallback and
  handles non-aligned widths such as 854px without leaving unwritten pixels
  along the right edge.
  Model weights require about 7 MiB of additional downloads and no PyTorch.
- **Prefer smoothness:** on by default. Starts at your requested resolution and
  upscaler. Sustained processing or delivery overload reduces the effective
  resolution while keeping AI enabled; Lanczos is the fallback after lower AI
  resolutions cannot keep up. Sustained spare capacity lets it try higher quality
  again, with a cooldown after a failed attempt. Normal holds at a selected
  lower FPS do not justify reducing quality: starvation must also show delivery
  below the effective FPS target. Processing overload and growing backlogs still
  trigger adaptation. The panel reports effective quality; your requested resolution and FPS stay selected. Turn it off to always
  use the requested quality, even if playback stutters. Quality changes use the
  same matching-position handoff and preparation buffer as manual changes.
- **Buffer:** Auto, 0.75, 1.5, 3 or 6 seconds of prepared video frames. The progress
  bar shows actual ready frame duration and count, separate from the site's
  network/download buffer. A preview stays still while preparing, then plays
  with matching delayed audio. Manual buffers add about 150 ms of scheduling
  headroom. Initial model compilation can add preparation time. Worker/model setup pauses the
  source. Setup shows its current stage (starting workers, connecting to the helper,
  loading the GPU pipeline or preparing the model) with an indeterminate bar;
  percentages appear only once frame buffering starts. Buffer filling then captures real-time source playback behind a still
  picture with muted audio; visible playback resumes when ready. On YouTube,
  the progress bar and YouTube's existing elapsed-time text follow the processed picture and
  stay still during preparation rather than exposing the advancing capture clock.
- **Frame memory:** 256 MiB, 512 MiB (default), 1, 2, 4 or 8 GiB for prepared
  original/enhanced frames. Higher budgets let large outputs retain longer
  buffers. This is an upper limit allocated as needed, not reserved GPU VRAM;
  total browser/helper memory can be higher. Changing it leaves both processing
  switches unchanged.
- **AI engine:** uses the local RIFE/RTX helper. Turn it off for the
  independent browser-only optical-flow renderer. Upscaling and output above
  1080p require the helper.
- **General:** adapts to repeated drawings; general upscaler at 80% strength.
- **Animation:** bridges repeated drawings to the next changed drawing, with
  bounded lookahead through static shots; AnimeVideo-v3 at 100% strength.
- **Live action:** follows source frames; general upscaler at 65% strength
  to retain more of the original texture.
- **Gameplay:** follows source frames with a shorter automatic buffer and more
  conservative scene changes; general upscaler at 50% strength to limit
  invented HUD and text details. Strength blends neural output with plain resizing.
- **Compare:** the toggle is the requested mode and survives FPS, resolution,
  buffer, engine changes and same-video player replacements. A temporary native
  bypass or preparation phase leaves the toggle selected and explains why the
  comparison is waiting; matching split output resumes automatically. Processing errors
  show the actual failure; turn Compare off and on to retry a failed session. The setting
  can also be selected before processing starts. Only toggling it off or moving
  to a different video clears it.
  Delayed original on the left, enhanced picture on the right, in
  the same output frame and on the same audio clock. Drag the divider; Left/Right
  move it by 2%, Shift by 10%, and Home/End to the edges. The original bypasses
  AI upscaling and uses native browser scaling. Pause retains the last presented
  original/enhanced frame pair; comparison and its divider still work immediately
  while all workers, capture tracks and added audio delay are released. Resuming
  starts a fresh playback buffer. Comparison can also be armed before playback.
  Natural completion drains prepared frames and delayed audio before releasing
  processing, preserving the final frame. Short videos can finish even when
  their duration is shorter than the selected buffer. Seeking, disabling
  processing and leaving the page still cancel immediately.
- **Statistics:** toggles live on-screen FPS, operation states, resolution,
  prepared duration, frame-memory use, held/dropped frames and audio delay.
  It does not print diagnostics to the console.

The panel separately reports **Motion smoothing** and **Upscaling** states.
Videos above the selected FPS are capped without estimating intermediate motion;
only retained frames are upscaled. A plain cap without resizing passes captured
video frames directly to the presenter, without sending frame pixels to the helper.
With a matching target (within the FPS detection tolerance) and no explicit
resize, the original video and audio bypass processing. Slower sources keep their FPS during upscaling alone; motion smoothing
can interpolate them up to the target. Every content profile follows these rules.
The final source frame and original clip duration are retained when a cap is active.
If browser capture is slow, a warning reports the limitation; your selected
resizing continues. High resolution/FPS combinations remain selectable even
when they may stutter or drop frames. Prefer smoothness can reduce effective
upscaling quality; requested controls and target FPS are never changed.

Prepared frame memory defaults to **512 MiB** and can be raised to **8 GiB**;
larger pictures automatically shorten the effective buffer when it reaches the
selected budget. This budget covers queued frames, not all browser,
GPU-model or transport memory. A buffer absorbs temporary stalls; it cannot
sustain a resolution/FPS combination that processing cannot keep up with. Start
with 720p/60 or 1080p/45 and lower output resolution/FPS if the buffer stays low.
Once the buffer target is met, extra queued data mainly adds memory and latency;
more is not always better. Capture follows real-time source playback, so a larger
buffer does not by itself raise GPU use or inference quality. Select a higher
output resolution or target FPS to ask for more processing; Animation is the
intended profile for drawn material. Slow inference contributes to the reported
audio delay instead of trapping startup in a refill loop. Demanding settings can
still stutter.
45 fps has uneven cadence on 60 Hz displays.

Capture timestamps are normalized across paused/live clock switches. If the
source advances but frame presentation stalls, MotionFlow retries the capture
pipeline automatically without a backward seek or changing the selected quality.
Repeated failures stop retries and show an error; processing can be toggled to
try again. A bounded capture queue retains adjacent source frames through short processing
stalls instead of immediately dropping inputs. Its memory is separate from the
prepared-frame budget. Restored original frames can reuse immutable delivery
pixels; generated model buffers are never reused as originals. Balanced,
overlapping SR tiles reduce wasted padding while preserving the existing halo.
Statistics include clock-reset counts, capture gaps, queue skips, restoration
cache hits and the active pixel backend.

To inspect detail reconstruction, use [Big Buck Bunny from Blender](https://www.youtube.com/watch?v=aqz-KE-bpKQ)
at a fixed YouTube quality of **360p or 480p**, select MotionFlow **1080p**, enable
**Upscaling**, select **AI · Real-ESRGAN** and **Animation**, and leave motion smoothing off to isolate the
upscaler. Enable **Compare**, then pause and drag the divider. Native 1080p/4K
from YouTube remains a better reference than detail inferred from a low-resolution
copy. Grainy, heavily compressed footage may gain plausible texture, not reliable
new facial detail.

The YouTube menu uses the native menu's background color and corner radius, with
no backdrop blur. The settings icon has no active/open highlight. Its slider
knobs move to the opposite positions when opened, hold there, and return on any
close action while the tracks stay fixed; switches animate when toggled. Reduced
motion preferences are respected. Escape or clicking outside closes the panel;
keyboard arrows navigate buttons; number fields and selectors keep their native
typing and keys. Settings remain open while hovered, being edited, or navigated
with the keyboard; an idle panel still dismisses with YouTube controls. The panel
uses the browser top layer when supported to stay
above player overlays, including in fullscreen.
Status messages expire after four seconds; statistics remain visible only when
explicitly enabled.

### Local helper and browser pairing

The helper targets Linux x86_64, an NVIDIA RTX GPU, Python 3.11–3.13, 7-Zip (`7z`)
and FFmpeg's `libswscale`/`libavutil`. From this userscripts directory:

```sh
./motionflow-helper setup
./motionflow-helper start
./motionflow-helper status
./motionflow-helper restart
./motionflow-helper stop
```

Setup creates an isolated runtime/model cache under
`${XDG_CACHE_HOME:-~/.cache}/qute-motionflow` and verifies the downloaded RIFE ONNX
model and official Real-ESRGAN weights by checksum. Compact model tensors are
converted to ONNX in the isolated runtime with a restricted tensor-only reader. It does not modify system Python or require PyTorch/a CUDA
compiler toolkit. `>gr` (or `apply_custom`) restarts an already configured helper,
installs browser pairing and reloads scripts. Restart waits for the previous process to exit so
updated Python code is loaded; it briefly interrupts enhancement in other tabs.
It never installs dependencies automatically. If restart fails, it reports the
error and continues installing browser assets.
The helper starts at login only if you add it to your desktop session startup.
Use `:spawn --userscript motionflow-helper start` in the browser, or start it
directly from any terminal directory:

```sh
~/.local/share/qutebrowser/userscripts/motionflow-helper start
~/.local/share/qutebrowser/userscripts/motionflow-helper status
```

`start` runs the helper in the background, so the terminal can be closed afterward.
The runtime and model setup persist across reboots; setup does not need repeating.

To install a desktop entry and command-line launcher, run this once as your
normal user (without `sudo`) from this checkout:

```sh
./install-motionflow
```

It creates `~/.local/bin/motionflow-helper` and
`${XDG_DATA_HOME:-~/.local/share}/applications/motionflow-helper.desktop`.
The entry starts the helper in the background and offers **Restart helper** and
**Stop helper** desktop actions. Installation does not start the helper, download
its runtime, or edit your compositor configuration. Run `./motionflow-helper setup`
first if you have not configured the runtime. Re-running the installer updates
its launcher after moving this checkout.

For this Hyprland configuration, add the following line **inside the existing**
`hl.on("hyprland.start", function () ... end)` callback in
`~/.config/hypr/config/autostart.lua`:

```lua
hl.exec_cmd("gtk-launch motionflow-helper")
```

`gtk-launch` launches the installed desktop entry by its ID. It is available on
this machine; logging into Hyprland then starts the helper once. To test the same
entry immediately, run `gtk-launch motionflow-helper`. Manual command-line
management is also available with `~/.local/bin/motionflow-helper start`,
`restart`, `status` and `stop` after installation. The launcher does not need to
be on `PATH` for the desktop entry to work. The installed CLI shim forwards to
this checkout; `apply_custom` restarts the configured helper using updated code
without rewriting that shim. Rerun `install-motionflow` if you move the checkout.

The service listens only on **127.0.0.1:8768**, handles one video at a time, and
requires a private token for browser WebSocket connections. The token is sent in
a WebSocket subprotocol, not a URL. `apply_custom` generates a mode-0600 pairing
userscript only in the active profile's Greasemonkey directory. It provisions
the credential only after a real click on MotionFlow controls on a page with a
video. Synthetic page-triggered clicks cannot activate enhancement. The
credential stays in the isolated userscript world, outside this source repository. Ordinary page scripts
cannot read that global. Unpaired origins are rejected before GPU work starts.

Captured pixels remain local; the helper receives no media URL, cookies or
audio. Frames travel uncompressed, with native I420/NV12 capture where available
and SDR BT.709 I420 output. Range/matrix conversion and resizing are explicit.
There is no extra video compression codec; standard 4:2:0 chroma sampling still
applies. The interpolation model initializes only when needed; native-FPS
resizing does not initialize or run RIFE. Engines are cached on disk and GPU
resources are released after 90 idle seconds. Frame data is not saved to disk.

Audio follows estimated actual video latency, with mute, volume and playback
speed preserved. Preparation is silent until delayed video starts. Stopping,
seeking, ads on YouTube, hidden tabs and Picture-in-Picture release processing
and bypass added audio delay. An already created Web Audio source/context is
reused until reload. Timing compensation is not a physical speaker/display sync
measurement.

YouTube's restrictive worker policy uses its validated, same-origin plain-text
`/robots.txt` document as a worker context. Generic players use an inherited
`about:blank` context and respect the page's worker policy. No browser security
settings or site CSP are relaxed. Unsupported APIs, protected/DRM media,
inaccessible cross-origin frames and sites that forbid workers may prevent
processing; failures retain original playback. Browser support requires
WebGL2, OffscreenCanvas, VideoFrame, captureStream, transferable media tracks/
streams, worker requestAnimationFrame and loopback WebSockets.

AI can still deform objects or miss occlusions and scene changes. HDR-to-SDR
conversion, chroma sampling and upscaling can change color/fine-detail appearance.
Artifact-free reconstruction is not guaranteed.

### Development and checks

```sh
python lib/motionflow/build.py           # builds both scripts from one core
python lib/motionflow/build.py --check
python tests/motionflow-manage.py
python tests/motionflow-install.py
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-superres.py
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-lanczos.py
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-gpu-pipeline.py
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-gpu-pipeline.py --benchmark
node tests/motionflow-settings.cjs
node tests/motionflow-fps.cjs
node tests/motionflow-adaptive.cjs
node tests/motionflow-clock.cjs
node tests/motionflow-output.cjs
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-tiling.py
node tests/motionflow-audio.cjs
python tests/motionflow-audio.py       # offline Web Audio samples; no speakers/server
node tests/motionflow-presentation.cjs
node tests/motionflow-low-fps.cjs
node tests/motionflow-controls.cjs
node tests/motionflow-return.cjs
python tests/youtube-motionflow.py     # isolated browser-only regression suite
```

To compare processing orders on the local GPU:

```sh
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-order.py --profile animation --target-fps 45 --output /tmp/motionflow-order-animation
~/.cache/qute-motionflow/venv/bin/python tests/motionflow-order.py --profile general --target-fps 60 --output /tmp/motionflow-order-general
```

This measures warm stage costs for both orders and saves midpoint/reference PNGs.
It estimates per-output cost at the requested cadence, excluding browser capture,
transport, compilation, cuts and repeated animation drawings. Interpolate-first
keeps RIFE at the smaller size but upscales every output frame. Upscale-first
can cache restored source frames, reducing SR calls, but runs RIFE at the larger
size with greater memory requirements. Neither is a universal quality winner;
the synthetic-reference PSNR is a limited regression aid, not a ranking for real
footage. The default remains interpolate-first. Joint spatial/temporal models
are another approach, as studied in [Zooming Slow-Mo (CVPR 2020)](https://openaccess.thecvf.com/content_CVPR_2020/html/Xiang_Zooming_Slow-Mo_Fast_and_Accurate_One-Stage_Space-Time_Video_Super-Resolution_CVPR_2020_paper.html).

GPU pipeline checks validate odd-sized BT.709 delivery, multi-tile stitching,
GPU-resident model handoffs and optional CPU/wall-time measurements. CUDA kernel
source and precompiled PTX ship together; the regeneration command is in
`lib/motionflow/gpu-pixels.cu`. No CUDA compiler is needed to run the helper.

The producer stream checks (`node tests/motionflow-neural-stream.cjs`) exercise
normal EOF and explicit finishing through outstanding RPCs and held animation
frames, capture backlog and per-output processing telemetry. Adaptive-quality
checks cover AI-first startup, resolution-before-filter fallback and recovery
cooldowns. Timer checks verify that the existing YouTube span is reused.
Presenter checks cover complete finite streams and short buffered clips.

Browser checks use an in-memory profile/audio sink and generated video; no sound
is played through speakers. They cover playback pacing, real composited pixel
changes through 100 ms page stalls, audio, comparison dragging, fullscreen,
cleanup, CSP and Trusted Types. GPU image fixtures cover motion boundaries, cuts
and occlusions at three sizes. Optional neural checks use a separate test helper:

```sh
~/.cache/qute-motionflow/venv/bin/python lib/motionflow/helper.py \
  --cache ~/.cache/qute-motionflow --port 8770 --allow-test-origin
python tests/youtube-motionflow.py --case neural-upscale
python tests/youtube-motionflow.py --case neural-generic \
  --pairing-token-file ~/.cache/qute-motionflow/browser.token
python tests/youtube-motionflow.py --case neural-gameplay
```

The helper-interpreter checks `tests/motionflow-helper.py`,
`tests/motionflow-colors.py` and `tests/motionflow-gpu-conversion.py` validate
cadence rules, pairing, passthrough, raw transport, resizing, color/range
conversion and GPU conversion. Optional local-clip quality checks:

```sh
python tests/youtube-motionflow.py --quality-only --neural-quality \
  --quality-scale 2 --clip /path/to/clip.webm --quality-output /tmp/motionflow-quality
```

Withheld animation frames need not match synthetic midpoints; clip errors are
diagnostics, not a perceptual-quality score. Downloaded samples stay outside the
repo. AI upscaling: [Real-ESRGAN / Xintao Wang et al.](https://github.com/xinntao/Real-ESRGAN)
(BSD-3-Clause); see `lib/motionflow/licenses/Real-ESRGAN-BSD-3-Clause.txt`. AI motion credits: [Practical-RIFE / hzwer](https://github.com/hzwer/Practical-RIFE)
(MIT model), [vs-mlrt](https://github.com/AmusementClub/vs-mlrt) (ONNX distribution),
[NVIDIA TensorRT-RTX](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/)
(separately installed inference runtime), and [FFmpeg](https://ffmpeg.org/)
(system pixel-conversion/resizing libraries). Upstream RIFE and vs-mlrt license
notices are included under `lib/motionflow/licenses/` and copied beside the model.
No third-party model/runtime binaries are checked into this repository.

## Layout

Root executables are launched by name with `spawn --userscript`. `lib/` contains
shared shell helpers, `js/` contains page actions, and `custom/` contains site
CSS and Greasemonkey scripts.
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
