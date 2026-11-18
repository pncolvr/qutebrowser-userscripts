// ==UserScript==
// @name         Twitch YouTube switch
// @namespace    qutebrowser-userscripts
// @version      1.0
// @description  When a Twitch streamer is also live on YouTube, offer a toggle that swaps the player to the YouTube stream.
// @match        https://www.twitch.tv/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  // Twitch login (lowercase) -> YouTube channel ID ("UC" + 22 characters).
  // Needed when the streamer only links an @handle on Twitch.
  const CHANNELS = {
    "ricfazeres": "UC7I9vRncx1-vox41l1A0ACQ",
  };

  // Switch to YouTube as soon as its live stream is found. Choosing
  // "Back to Twitch" keeps Twitch for the rest of that channel visit.
  const AUTO_SWITCH = false;

  const TAG = '[Twitch YouTube Switch]';
  const CACHE_PREFIX = 'qute-twitch-youtube:';
  const FOUND_TTL = 7 * 24 * 3600 * 1000;
  const MISSING_TTL = 24 * 3600 * 1000;
  const RECHECK_MS = 150 * 1000;
  const PROBE_TIMEOUT_MS = 15 * 1000;
  const MARGIN = 32;
  const EMBED_ORIGINS = ['https://www.youtube.com', 'https://www.youtube-nocookie.com'];
  const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const RESERVED = new Set([
    'directory', 'downloads', 'drops', 'friends', 'inventory', 'jobs', 'messages',
    'p', 'payments', 'popout', 'prime', 'search', 'settings', 'store', 'subscriptions',
    'turbo', 'videos', 'wallet', 'login', 'signup', 'moderator', 'u',
  ]);

  // ---- Pure helpers (exported for tests) ----

  function loginFromPath(pathname) {
    const match = /^\/([A-Za-z0-9_]{2,25})\/?$/.exec(pathname || '');
    if (!match) return null;
    const login = match[1].toLowerCase();
    return RESERVED.has(login) ? null : login;
  }

  function channelIdFromUrl(url) {
    try {
      const parsed = new URL(url, 'https://www.youtube.com');
      if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) return null;
      return /^\/channel\/(UC[\w-]{22})(?:\/|$)/.exec(parsed.pathname)?.[1] || null;
    } catch {
      return null;
    }
  }

  function channelIdFromSocials(socials) {
    for (const social of socials || []) {
      const id = channelIdFromUrl(social?.url);
      if (id) return id;
    }
    return null;
  }

  const CHANNEL_IN_TEXT = /(?:^|[^\w.-])(?:https?:\/\/)?(?:[\w-]+\.)?youtube\.com\/channel\/(UC[\w-]{22})(?![\w-])/;
  const HANDLE_IN_TEXT = /(?:^|[^\w.-])(?:https?:\/\/)?(?:[\w-]+\.)?youtube\.com\/(@[\w.-]{3,30})/g;

  function channelIdFromText(text) {
    return CHANNEL_IN_TEXT.exec(String(text || ''))?.[1] || null;
  }

  // Twitch "About" panels: a panel's link, then links written in its text.
  function channelIdFromPanels(panels) {
    for (const panel of panels || []) {
      const id = channelIdFromUrl(panel?.linkURL) || channelIdFromText(panel?.description);
      if (id) return id;
    }
    return null;
  }

  function youtubeHandles(texts) {
    const handles = new Set();
    for (const text of texts) {
      for (const match of String(text || '').matchAll(HANDLE_IN_TEXT)) handles.add(match[1]);
    }
    return [...handles];
  }

  function readCache(storage, login, now) {
    try {
      const entry = JSON.parse(storage.getItem(CACHE_PREFIX + login));
      if (!entry || typeof entry.at !== 'number') return undefined;
      const ttl = entry.channelId ? FOUND_TTL : MISSING_TTL;
      if (now - entry.at > ttl) return undefined;
      return entry.channelId || null;
    } catch {
      return undefined;
    }
  }

  function writeCache(storage, login, channelId, now) {
    try {
      storage.setItem(CACHE_PREFIX + login, JSON.stringify({channelId: channelId || null, at: now}));
    } catch {
      // Storage may be unavailable; detection still works without it.
    }
  }

  // Fold one iframe-API message into the probe state. Returns 'live',
  // 'unavailable' or null (keep waiting).
  function probeStep(state, data) {
    let message = data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return null; }
    }
    if (!message || typeof message !== 'object') return null;
    if (message.event === 'onError') return 'unavailable';
    if (message.event !== 'initialDelivery' && message.event !== 'infoDelivery') return null;
    const info = message.info || {};
    if (info.videoData) state.videoData = {...state.videoData, ...info.videoData};
    const video = state.videoData;
    if (!video) return null;
    if (video.errorCode) return 'unavailable';
    // The live_stream embed resolves to the current broadcast's real video ID.
    // Offline channels keep the placeholder ID "live_stream" with errorCode
    // "auth". isLive stays false until playback starts, so it cannot be used.
    const id = video.video_id;
    if (typeof id === 'string' && /^[\w-]{11}$/.test(id) && id !== 'live_stream' &&
        video.isPlayable === true) return 'live';
    return null;
  }

  // Links viewers post in chat must never pick the channel.
  const NOT_CHANNEL_INFO = [
    '.chat-shell', '.stream-chat', '.chat-room', '.chat-line__message', '.video-chat',
    '.channel-root__right-column', '.right-column', '[data-a-target="chat-scroller"]',
    '[data-a-target="right-column-chat-bar"]', '[data-test-selector*="chat"]',
  ].join(',');
  function pageLinkAllowed(anchor) {
    return !anchor.closest(NOT_CHANNEL_INFO);
  }

  if (globalThis.__quteTwitchYoutubeTest) {
    globalThis.__quteTwitchYoutubeTest.exports = {
      loginFromPath, channelIdFromUrl, channelIdFromSocials, channelIdFromText, channelIdFromPanels,
      youtubeHandles, pageLinkAllowed, readCache, writeCache, probeStep,
    };
    return;
  }

  // ---- Browser side ----

  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const root = document.documentElement;
  let login = null;
  let channelId = null;
  let live = null;        // {videoId, title} while live and embeddable
  let active = false;
  let declined = false;   // the viewer chose Twitch (or the embed failed) this visit
  let generation = 0;     // bumps on channel change to discard stale async work
  let probe = null;
  let recheckTimer = 0;
  let pointer = null;
  let button = null;
  let overlay = null;
  let twitchState = null; // {muted, volume, paused}
  let playerListening = 0;

  const style = document.createElement('style');
  style.textContent = `
    .qute-yt-switch {
      position:absolute;bottom:12px;right:12px;z-index:63;height:38px;width:48px;
      display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;
      margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer;
      opacity:0;pointer-events:none;transition:opacity 120ms ease;
    }
    .qute-yt-switch[data-visible=true],.qute-yt-switch:focus-visible {opacity:1;pointer-events:auto}
    .qute-yt-switch:focus-visible {outline:2px solid #fff;outline-offset:-5px}
    .qute-yt-switch svg {width:25px;height:25px;opacity:.9;filter:drop-shadow(0 1px 2px #000b)}
    .qute-yt-switch:hover svg,.qute-yt-switch:focus-visible svg {opacity:1}
    .qute-yt-switch[aria-pressed=true] {top:64px;bottom:auto;right:12px;z-index:72;background:#000a}
    .qute-yt-overlay {position:absolute;left:0;top:0;width:100%;height:100%;z-index:71;border:0;background:#000}
  `;
  (document.head || root).append(style);

  const ICON_YOUTUBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l-6 6 6 6M4 12h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const player = () => document.querySelector('[data-a-target="video-player"]');
  const twitchVideo = () => player()?.querySelector('video') || document.querySelector('div.video-ref video');

  function resetChannel() {
    generation++;
    resolving = false;
    declined = false;
    stopProbe();
    clearTimeout(recheckTimer);
    if (active) deactivate();
    live = null;
    channelId = null;
    render();
  }

  let resolving = false;
  let hintedHandles = '';

  async function resolveChannel(forLogin, gen) {
    if (CHANNELS[forLogin]) return CHANNELS[forLogin];
    const cached = storage ? readCache(storage, forLogin, Date.now()) : undefined;
    if (cached !== undefined) return cached;
    // Separate operations, so an unknown field in one cannot void the other.
    const queries = [
      'query($login:String!){user(login:$login){channel{socialMedias{name url}}}}',
      'query($login:String!){user(login:$login){panels{...on DefaultPanel{linkURL description}}}}',
    ];
    let results;
    try {
      const response = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {'Client-Id': TWITCH_GQL_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8'},
        body: JSON.stringify(queries.map(query => ({query, variables: {login: forLogin}}))),
      });
      results = await response.json();
    } catch (error) {
      console.warn(TAG, 'Could not read Twitch channel links:', error.message);
      return null; // Don't cache a network failure; the page scan still runs.
    }
    const [socialResult, panelResult] = Array.isArray(results) ? results : [];
    const socials = socialResult?.data?.user?.channel?.socialMedias;
    const panels = panelResult?.data?.user?.panels;
    const found = channelIdFromSocials(socials) || channelIdFromPanels(panels);
    if (!found) {
      hintHandles(forLogin, [
        ...(socials || []).map(s => s?.url),
        ...(panels || []).flatMap(p => [p?.linkURL, p?.description]),
      ]);
    }
    if (gen === generation && storage) writeCache(storage, forLogin, found, Date.now());
    return found;
  }

  function hintHandles(forLogin, texts) {
    const handles = youtubeHandles(texts);
    const key = forLogin + ':' + handles.join(',');
    if (!handles.length || key === hintedHandles) return;
    hintedHandles = key;
    console.info(TAG, `${forLogin} links YouTube as ${handles.join(', ')}; add its channel ID to CHANNELS to enable switching.`);
  }

  // The About section and panels under the player render lazily, so keep
  // looking at them until a channel turns up.
  function scanPage() {
    const anchors = [...document.querySelectorAll('a[href*="youtube.com/"]')].filter(pageLinkAllowed);
    for (const anchor of anchors) {
      const id = channelIdFromUrl(anchor.href);
      if (id) return id;
    }
    hintHandles(login, anchors.map(a => a.href));
    return null;
  }

  function stopProbe() {
    if (!probe) return;
    clearTimeout(probe.timeout);
    clearInterval(probe.hello);
    probe.frame.remove();
    probe = null;
  }

  function startProbe(gen) {
    stopProbe();
    if (!channelId || document.hidden) return scheduleRecheck(gen);
    const frame = document.createElement('iframe');
    frame.dataset.quteKeepEmbed = '';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:200px;height:113px;border:0;visibility:hidden;pointer-events:none';
    const params = new URLSearchParams({
      channel: channelId, enablejsapi: '1', autoplay: '0', mute: '1', origin: location.origin,
    });
    frame.src = 'https://www.youtube-nocookie.com/embed/live_stream?' + params;
    const state = {};
    probe = {frame, state, gen, hello: 0, timeout: 0};
    probe.hello = setInterval(() => listen(frame), 250);
    probe.timeout = setTimeout(() => finishProbe(gen, null), PROBE_TIMEOUT_MS);
    document.body.append(frame);
  }

  function listen(frame) {
    try {
      frame.contentWindow?.postMessage(JSON.stringify({event: 'listening', id: 1, channel: 'widget'}), '*');
    } catch {
      // The frame may be navigating.
    }
  }

  function finishProbe(gen, result) {
    if (!probe || probe.gen !== gen) return;
    stopProbe();
    if (gen !== generation) return;
    const wasLive = !!live;
    live = result;
    if (wasLive !== !!live) console.info(TAG, live ? `YouTube live: ${live.title || live.videoId}` : 'YouTube stream not live.');
    if (!live && active) deactivate();
    render();
    autoSwitch();
    scheduleRecheck(gen);
  }

  function autoSwitch() {
    if (!AUTO_SWITCH || !live || active || declined || !player()) return;
    console.info(TAG, 'Switching to the YouTube stream automatically.');
    activate({auto: true});
  }

  function scheduleRecheck(gen) {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => { if (gen === generation) startProbe(gen); }, RECHECK_MS);
  }

  window.addEventListener('message', event => {
    if (!EMBED_ORIGINS.includes(event.origin)) return;
    if (probe && event.source === probe.frame.contentWindow) {
      const verdict = probeStep(probe.state, event.data);
      if (verdict === 'live') {
        const video = probe.state.videoData;
        finishProbe(probe.gen, {videoId: video.video_id, title: video.title || ''});
      } else if (verdict === 'unavailable') {
        finishProbe(probe.gen, null);
      }
    } else if (overlay && event.source === overlay.contentWindow) {
      handlePlayerMessage(event.data);
    }
  });

  function command(func, args = []) {
    try {
      overlay?.contentWindow?.postMessage(JSON.stringify({event: 'command', func, args}), '*');
    } catch {
      // Ignore a navigating frame.
    }
  }

  function handlePlayerMessage(data) {
    let message = data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return; }
    }
    if (!message || typeof message !== 'object') return;
    if (message.event === 'onReady' || message.event === 'initialDelivery') {
      clearInterval(playerListening);
      playerListening = 0;
      if (twitchState) {
        command('setVolume', [Math.round(twitchState.volume * 100)]);
        command(twitchState.muted ? 'mute' : 'unMute');
      }
    } else if (message.event === 'onError') {
      console.warn(TAG, 'YouTube player error', message.info, '— returning to Twitch.');
      live = null;
      declined = true;
      deactivate();
      render();
    } else if (message.event === 'infoDelivery' && message.info?.playerState === 0) {
      console.info(TAG, 'YouTube stream ended — returning to Twitch.');
      live = null;
      deactivate();
      render();
    }
  }

  // Twitch's player element can extend below what is shown (an ancestor clips
  // it to the video box), so match the visible video area instead.
  function visibleBox(host) {
    const target = host.querySelector('.video-player__container') || twitchVideo() || host;
    const hostRect = host.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const left = Math.max(rect.left, hostRect.left), top = Math.max(rect.top, hostRect.top);
    const right = Math.min(rect.right, hostRect.right), bottom = Math.min(rect.bottom, hostRect.bottom);
    if (right - left < 50 || bottom - top < 50) {
      return {left: 0, top: 0, width: hostRect.width, height: hostRect.height, rightGap: 0};
    }
    return {
      left: left - hostRect.left, top: top - hostRect.top,
      width: right - left, height: bottom - top, rightGap: hostRect.right - right,
    };
  }

  let resizeObserver = null;
  function fitOverlay() {
    const host = player();
    if (!overlay || !host) return;
    const box = visibleBox(host);
    const css = {left: box.left, top: box.top, width: box.width, height: box.height};
    for (const [key, value] of Object.entries(css)) {
      const px = Math.round(value) + 'px';
      if (overlay.style[key] !== px) overlay.style[key] = px;
    }
    if (button && active) {
      button.style.top = Math.round(box.top + 64) + 'px';
      button.style.right = Math.round(box.rightGap + 12) + 'px';
    }
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(fitOverlay);
      resizeObserver.observe(host);
      const target = host.querySelector('.video-player__container');
      if (target) resizeObserver.observe(target);
    }
  }
  window.addEventListener('resize', fitOverlay);
  document.addEventListener('fullscreenchange', fitOverlay);

  function activate({auto = false} = {}) {
    const host = player();
    const video = twitchVideo();
    if (!live || !host) return;
    // An automatic switch can happen before Twitch starts playing; resume it on return.
    twitchState = video ? {muted: video.muted, volume: video.volume, paused: auto ? false : video.paused} : null;
    if (video) {
      video.muted = true;
      video.pause();
    }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    overlay = document.createElement('iframe');
    overlay.className = 'qute-yt-overlay';
    // Leaving the iframe for the button over it must count as "near the button".
    overlay.addEventListener('mouseenter', event => setOverlayHovered(true, event));
    overlay.addEventListener('mouseleave', event => setOverlayHovered(false, event));
    overlay.dataset.quteKeepEmbed = '';
    overlay.title = live.title || 'YouTube live stream';
    overlay.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    overlay.allowFullscreen = true;
    const params = new URLSearchParams({autoplay: '1', enablejsapi: '1', playsinline: '1', origin: location.origin});
    // The privacy-enhanced host sends no youtube.com session cookies, which
    // can make signed-in embeds fail with "This video is unavailable" (152-4).
    overlay.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(live.videoId)}?${params}`;
    host.append(overlay);
    fitOverlay();
    clearInterval(playerListening);
    playerListening = setInterval(() => listen(overlay), 250);
    setTimeout(() => { clearInterval(playerListening); playerListening = 0; }, 10000);
    active = true;
    root.dataset.quteYoutubeSwitch = 'active';
    render();
  }

  function deactivate() {
    clearInterval(playerListening);
    playerListening = 0;
    overlay?.remove();
    overlay = null;
    overlayHovered = false;
    resizeObserver?.disconnect();
    resizeObserver = null;
    active = false;
    delete root.dataset.quteYoutubeSwitch;
    const video = twitchVideo();
    if (video && twitchState) {
      video.volume = twitchState.volume;
      video.muted = twitchState.muted;
      if (!twitchState.paused) video.play().catch(() => {});
    }
    twitchState = null;
    render();
  }

  function ensureButton(host) {
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'qute-yt-switch';
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (!event.isTrusted) return;
        if (active) {
          declined = true;
          deactivate();
        } else {
          activate();
        }
      });
    }
    if (button.parentElement !== host) host.append(button);
    return button;
  }

  function render() {
    const host = player();
    if (!live || !host) {
      button?.remove();
      return;
    }
    const control = ensureButton(host);
    control.setAttribute('aria-pressed', String(active));
    const label = active ? 'Back to Twitch' : `Watch on YouTube${live.title ? ': ' + live.title : ''}`;
    control.title = label;
    control.setAttribute('aria-label', label);
    const icon = active ? ICON_BACK : ICON_YOUTUBE;
    if (control.dataset.icon !== String(active)) {
      control.innerHTML = icon;
      control.dataset.icon = String(active);
    }
    place(host, control);
  }

  // Sit immediately left of MotionFlow's controls when they exist.
  function place(host, control) {
    if (active) {
      control.style.bottom = control.style.height = '';
      fitOverlay(); // positions the button inside the visible video area
      // Pointer moves inside the cross-origin player never reach this page,
      // so "over the YouTube player" is the closest hover signal available.
      control.dataset.visible = String(overlayHovered || nearPointer(control));
      return;
    }
    // Follow MotionFlow's rendered position (on Twitch it ends up at the
    // top-right, not where its stylesheet's bottom offset suggests).
    const bar = host.querySelector(':scope > .mf-generic-controls');
    const barRect = bar?.getBoundingClientRect();
    if (barRect && barRect.width > 0 && barRect.height > 0) {
      const hostRect = host.getBoundingClientRect();
      control.style.right = Math.max(0, Math.round(hostRect.right - barRect.left)) + 'px';
      control.style.top = Math.round(barRect.top - hostRect.top) + 'px';
      control.style.bottom = 'auto';
      control.style.height = Math.round(barRect.height) + 'px';
    } else {
      control.style.right = '12px';
      control.style.top = control.style.height = '';
      control.style.bottom = '12px';
    }
    control.dataset.visible = String(nearPointer(control));
  }

  function nearPointer(control) {
    const rect = control.getBoundingClientRect();
    return Boolean(pointer && rect.width > 0 &&
      pointer.x >= rect.left - MARGIN && pointer.x <= rect.right + MARGIN &&
      pointer.y >= rect.top - MARGIN && pointer.y <= rect.bottom + MARGIN);
  }

  let overlayHovered = false;
  function setOverlayHovered(value, event) {
    overlayHovered = value;
    if (event) pointer = {x: event.clientX, y: event.clientY};
    if (button?.isConnected) place(button.parentElement, button);
  }

  const syncPointer = event => {
    pointer = {x: event.clientX, y: event.clientY};
    if (button?.isConnected) place(button.parentElement, button);
  };
  const clearPointer = () => {
    pointer = null;
    if (button?.isConnected) place(button.parentElement, button);
  };
  document.addEventListener('pointermove', syncPointer, {capture: true, passive: true});
  document.addEventListener('pointerdown', syncPointer, {capture: true, passive: true});
  document.addEventListener('pointerout', event => { if (!event.relatedTarget) clearPointer(); }, true);
  window.addEventListener('blur', clearPointer);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && channelId && !probe) startProbe(generation);
  });

  async function tick() {
    const current = loginFromPath(location.pathname);
    if (current !== login) {
      login = current;
      resetChannel();
      if (!login) return;
      const gen = generation;
      resolving = true;
      const id = await resolveChannel(login, gen);
      if (gen !== generation) return;
      resolving = false;
      channelId = id;
      if (channelId) startProbe(gen);
      return;
    }
    if (login && !channelId && !resolving) {
      const id = scanPage();
      if (id) {
        console.info(TAG, `Found YouTube channel ${id} in the links below the video.`);
        channelId = id;
        if (storage) writeCache(storage, login, id, Date.now());
        startProbe(generation);
      }
    }
    if (active) {
      const host = player();
      if (!host) return deactivate();
      // Twitch can rebuild its player or resume playback on its own.
      if (overlay && overlay.parentElement !== host) {
        host.append(overlay);
        resizeObserver?.disconnect();
        resizeObserver = null;
      }
      fitOverlay();
      const video = twitchVideo();
      if (video && !video.paused) {
        video.muted = true;
        video.pause();
      }
    }
    render();
    autoSwitch(); // retries until Twitch's player has rendered
  }

  setInterval(tick, 1000);
  tick();
  console.info(TAG, 'Enabled — checking streamers for a simultaneous YouTube live stream.');
})();
