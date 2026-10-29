// Shared output choices; inference resolution and delivery resolution are separate.
const RESOLUTIONS = {
  auto: 'Auto',
  source: 'Source · no enlargement',
  '480': '480p',
  '720': '720p',
  '1080': '1080p',
  '1440': '1440p',
  '2160': '2160p · 4K'
};
const BUFFER_CHOICES = {
  auto: 'Auto',
  '750': '0.75 seconds',
  '1500': '1.5 seconds',
  '3000': '3 seconds',
  '6000': '6 seconds'
};
const BUFFER_MEMORY_CHOICES = {
  '256': '256 MiB',
  '512': '512 MiB · default',
  '1024': '1 GiB',
  '2048': '2 GiB',
  '4096': '4 GiB',
  '8192': '8 GiB'
};
const UPSCALE_METHODS = {
  lanczos: 'Lanczos',
  ai: 'AI · Real-ESRGAN'
};
const UPSCALE_DETAILS = {
  general: 'General model · 80% restoration',
  animation: 'AnimeVideo-v3 · 100% restoration',
  live: 'General model · 65% restoration; gentler textures',
  gameplay: 'General model · 50% restoration; conservative HUD/text'
};
const CONTENTS = {
  general: 'General',
  animation: 'Animation',
  live: 'Live action',
  gameplay: 'Gameplay'
};
// Requested controls stay unchanged; only effective delivery quality adapts.
class AdaptiveQuality {
  constructor() {
    this.key = '';
    this.level = 0;
    this.lastAt = -Infinity;
    this.blocked = new Map();
  }
  configure({key, enabled, height, sourceHeight, method}) {
    const identity = JSON.stringify([key, enabled, height, sourceHeight, method]);
    if (identity === this.key) return;
    this.key = identity;
    this.level = this.bad = this.good = 0;
    this.lastAt = -Infinity;
    this.cooldown = 0;
    this.skipped = 0;
    this.blocked.clear();
    this.enabled = enabled;
    this.levels = [{height, method}];
    if (!enabled) return;
    const floor = Math.min(height, sourceHeight);
    for (const h of [2160, 1440, 1080, 720])
      if (h < height - 2 && h > floor + 2) this.levels.push({height: h, method});
    const lowest = this.levels.at(-1).height;
    if (method === 'ai') this.levels.push({height: lowest, method: 'lanczos'});
    if (floor < lowest - 2) this.levels.push({height: floor, method: 'lanczos'});
  }
  get effective() {
    return this.levels?.[this.level];
  }
  sample({
    now,
    readyAt,
    fps,
    workMs,
    showing,
    held = 0,
    buffered = 0,
    targetBuffer = 0,
    skipped = 0,
    deliveredFps = NaN,
    queued = 0
  }) {
    if (!this.enabled || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(workMs) ||
        workMs <= 0 || now - readyAt < 1800 || now - this.lastAt < 950 || now < this.cooldown)
      return false;
    this.lastAt = now;
    const lost = Math.max(0, skipped - this.skipped);
    this.skipped = skipped;
    const budget = 1000 / fps;
    // Holds alone cannot distinguish intentional low FPS from insufficient work rate.
    const hasRate = Number.isFinite(deliveredFps) && deliveredFps >= 0;
    const shortfall = hasRate && deliveredFps < fps * .85;
    const timely = hasRate && deliveredFps >= fps * .9;
    const backlog = shortfall && queued >= 2;
    const unhealthy = workMs > budget * 1.05 || backlog ||
        showing && held > 3 && buffered < Math.min(150, targetBuffer * .35) && shortfall;
    const healthy = workMs < budget * .68 && (held < 1 || timely) && !lost && !backlog &&
        (!showing || buffered >= targetBuffer * .6);
    this.bad = unhealthy ? this.bad + 1 : 0;
    this.good = healthy ? this.good + 1 : 0;
    if (this.bad >= 2 && this.level < this.levels.length - 1) {
      this.blocked.set(this.level, now + 60000);
      this.level++;
      this.bad = this.good = 0;
      this.cooldown = now + 3000;
      return true;
    }
    if (this.good >= 15 && this.level > 0 && now >= (this.blocked.get(this.level - 1) || 0)) {
      this.level--;
      this.good = this.bad = 0;
      this.cooldown = now + 5000;
      return true;
    }
    return false;
  }
}
function adaptiveSizing(video, requested, height) {
  if (!height || height >= requested.outputHeight) return requested;
  const scale = height / requested.outputHeight;
  const outputWidth = Math.max(2, Math.round(requested.outputWidth * scale));
  const outputHeight = Math.max(2, Math.round(requested.outputHeight * scale));
  const sw = video.videoWidth, sh = video.videoHeight;
  const process = Math.min(1, outputWidth / sw, outputHeight / sh, 1920 / sw, 1080 / sh);
  return {
    ...requested,
    outputWidth,
    outputHeight,
    processingWidth: Math.max(2, Math.round(sw * process)),
    processingHeight: Math.max(2, Math.round(sh * process)),
    resize: outputWidth !== sw || outputHeight !== sh,
    upscaling: outputWidth > sw || outputHeight > sh
  };
}

function bufferingOptions(bufferId, memoryId, automatic) {
  const manual = bufferId !== 'auto' && Object.hasOwn(BUFFER_CHOICES, bufferId);
  const bufferMs = manual ? Number(bufferId) : Math.max(50, automatic - 150);
  const memoryMiB = Object.hasOwn(BUFFER_MEMORY_CHOICES, memoryId) ? Number(memoryId) : 512;
  return {
    delayMs: manual ? bufferMs + 150 : automatic,
    bufferMs,
    maxBufferBytes: memoryMiB * 1024 * 1024
  };
}
function outputSizing(video, profile, resolution, upscale) {
  const sw = video?.videoWidth || 1280, sh = video?.videoHeight || 720;
  const limit = resolution === 'auto' ? (upscale ? Math.min(sh * 2, 2160) : profile.outputHeight) :
      resolution === 'source'         ? Math.min(sh, 1080) :
                                        Number(resolution);
  const capWidth =
      resolution === 'auto' ? (upscale ? 3840 : profile.outputWidth) : Math.round(limit * 16 / 9);
  const scale = Math.min(upscale ? Infinity : 1, capWidth / sw, limit / sh);
  const outputWidth = Math.max(2, Math.round(sw * scale)),
        outputHeight = Math.max(2, Math.round(sh * scale));
  const processScale = Math.min(1, outputWidth / sw, outputHeight / sh, 1920 / sw, 1080 / sh);
  return {
    outputWidth,
    outputHeight,
    processingWidth: Math.max(2, Math.round(sw * processScale)),
    processingHeight: Math.max(2, Math.round(sh * processScale)),
    resize: outputWidth !== sw || outputHeight !== sh,
    upscaling: outputWidth > sw || outputHeight > sh
  };
}
function settingsSelect(id, label, choices, change) {
  const row = document.createElement('label');
  row.className = 'mf-select-row';
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', label);
  for (const [value, text] of Object.entries(choices)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.addEventListener('change', event => {
    if (acceptsInput(event)) change(select.value)
  });
  select.addEventListener('click', e => e.stopPropagation());
  row.append(uiText('mf-label', label), select);
  return row;
}
function videoSelection() {
  if (SITE === 'youtube') {
    const player = document.getElementById('movie_player'),
          video = player?.querySelector('video.html5-main-video');
    if (video && video.getBoundingClientRect().width > 0) return {player, video};
  }
  const videos = [...document.querySelectorAll('video:not(#qute-motionflow-output)')].filter(
      v => !v.closest('#qute-motionflow-worker-host'));
  const visible = videos.filter(v => {
    const r = v.getBoundingClientRect();
    return r.width >= 120 && r.height >= 68 && r.bottom > 0 && r.top < browser.innerHeight;
  });
  const video = visible.sort(
                    (a, b) => Number(!b.paused) - Number(!a.paused) ||
                        (b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight))[0] ||
      null;
  const fullscreen = document.fullscreenElement;
  const player = video ?
      (fullscreen?.contains(video) ?
           fullscreen :
           video.closest(
               '[data-a-target="video-player"],.video-player,.video-js,.plyr,.jwplayer,.shaka-video-container') ||
               video.parentElement) :
      null;
  return {video, player: video && player === video ? video.parentElement : player};
}
function playerBar(player) {
  if (SITE === 'youtube' && player?.querySelector('.ytp-right-controls'))
    return player.querySelector('.ytp-right-controls');
  if (!player.classList.contains('mf-player')) player.classList.add('mf-player');
  if (browser.getComputedStyle(player).position === 'static') player.style.position = 'relative';
  let bar = player.querySelector(':scope > .mf-generic-controls');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mf-generic-controls';
    player.append(bar);
  }
  return bar;
}
