// ==UserScript==
// @name         YouTube embed to link
// @description  Play YouTube embeds through youtube-nocookie.com; show a "Watch on YouTube" card if the player fails.
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://*.youtube-nocookie.com/*
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const NOCOOKIE = 'www.youtube-nocookie.com';
  const NOCOOKIE_ORIGIN = 'https://' + NOCOOKIE;
  const PLAYER_ORIGINS = [NOCOOKIE_ORIGIN, 'https://www.youtube.com', 'https://youtube.com'];
  const HANDSHAKE_MS = 20000;

  const youtubeUrl = src => {
    try {
      const url = new URL(src);
      return /(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname) ? url : null;
    } catch {
      return null;
    }
  };

  const youtubeId = src => {
    const url = youtubeUrl(src);
    return url && /^\/embed\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1] || null;
  };

  // Where a card should send the viewer for this embed URL.
  const watchUrl = src => {
    const url = youtubeUrl(src);
    if (!url) return 'https://www.youtube.com/';
    const list = url.searchParams.get('list');
    const id = youtubeId(src);
    if (id === 'videoseries') {
      return list ? 'https://www.youtube.com/playlist?list=' + encodeURIComponent(list) : 'https://www.youtube.com/';
    }
    if (id === 'live_stream') {
      const channel = url.searchParams.get('channel');
      return channel ? 'https://www.youtube.com/channel/' + encodeURIComponent(channel) + '/live' : 'https://www.youtube.com/';
    }
    if (!id) return 'https://www.youtube.com/';
    return 'https://www.youtube.com/watch?v=' + id + (list ? '&list=' + encodeURIComponent(list) : '');
  };

  // Pages driving the player through YouTube's iframe API expect its messages
  // from the original host; those embeds keep their URL and are only observed.
  const pageControlsPlayer = src => youtubeUrl(src)?.searchParams.get('enablejsapi') === '1';

  const embedlySrc = src => {
    try {
      const url = new URL(src);
      // Embedly's outer frame hides the player; it can only become a card.
      if (url.hostname === 'cdn.embedly.com' && url.pathname === '/widgets/media.html') {
        const inner = url.searchParams.get('src');
        return youtubeId(inner) ? inner : null;
      }
    } catch {
      // Empty or invalid iframe URLs are unrelated to YouTube.
    }
    return null;
  };

  // The same embed on the privacy-enhanced host, with the iframe API enabled
  // so player errors can be detected. Returns null for non-YouTube embeds.
  const nocookieSrc = (src, origin) => {
    const url = youtubeUrl(src);
    if (!url || !/^\/embed\//.test(url.pathname)) return null;
    url.protocol = 'https:';
    url.hostname = NOCOOKIE;
    url.port = '';
    url.searchParams.set('enablejsapi', '1');
    if (!url.searchParams.has('origin') && /^https?:/.test(origin || '')) url.searchParams.set('origin', origin);
    return url.toString();
  };

  // Player errors (onError, or an errorCode on the loaded video) mean the
  // embed shows "This video is unavailable"; anything else keeps playing.
  const embedFailed = data => {
    let message = data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return false; }
    }
    if (!message || typeof message !== 'object') return false;
    if (message.event === 'onError') return true;
    if (message.event === 'initialDelivery' || message.event === 'infoDelivery') {
      return Boolean(message.info?.videoData?.errorCode);
    }
    return false;
  };

  const embedReady = data => {
    let message = data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return false; }
    }
    return message?.event === 'onReady' || message?.event === 'initialDelivery';
  };

  if (globalThis.__quteEmbedTest) {
    globalThis.__quteEmbedTest.exports = {youtubeId, watchUrl, embedlySrc, pageControlsPlayer, nocookieSrc, embedFailed, embedReady};
    return;
  }

  console.info('[YouTube Embed to Link] Enabled — playing embeds via youtube-nocookie.com, cards on error.');

  const style = document.createElement('style');
  style.textContent = `
    a.qute-youtube-card {
      display: grid !important;
      place-items: center;
      container-type: size;
      box-sizing: border-box !important;
      padding: 0 !important;
      overflow: hidden;
      border: 1px solid #ffffff18 !important;
      border-radius: 14px;
      background: linear-gradient(145deg, #202025, #111114) !important;
      color: #f5f5f7 !important;
      font-family: system-ui, sans-serif;
      text-align: center !important;
      text-decoration: none !important;
      cursor: pointer;
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }
    a.qute-youtube-card:hover {
      border-color: #ff656578 !important;
      box-shadow: inset 0 0 60px #ff454509;
    }
    a.qute-youtube-card:focus-visible {
      outline: 3px solid #ff6565 !important;
      outline-offset: 3px;
    }
    .qute-youtube-card > .qute-youtube-content {
      display: grid;
      place-items: center;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      max-width: 100%;
      padding: 24px;
      pointer-events: none;
    }
    .qute-youtube-card .qute-youtube-actions {
      grid-area: 1 / 1;
      align-self: end;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .qute-youtube-card .qute-youtube-play {
      display: grid;
      place-items: center;
      width: 56px;
      height: 40px;
      flex-shrink: 0;
      border-radius: 12px;
      background: #ef4444;
      color: #fff;
      font: 20px/1 system-ui, sans-serif;
    }
    .qute-youtube-card .qute-youtube-title {
      grid-area: 1 / 1;
      width: 100%;
      color: #f5f5f7;
      font: 600 18px/1.4 system-ui, sans-serif;
      overflow-wrap: anywhere;
      text-wrap: balance;
    }
    .qute-youtube-card .qute-youtube-label {
      color: #a5a5af;
      font: 400 13px/1.5 system-ui, sans-serif;
    }
    @container (max-height: 260px) {
      .qute-youtube-card > .qute-youtube-content { padding: 16px; }
      .qute-youtube-card .qute-youtube-actions { flex-direction: row; gap: 12px; }
      .qute-youtube-card .qute-youtube-play { width: 32px; height: 24px; font-size: 13px; }
    }
    @media (prefers-reduced-motion: reduce) {
      a.qute-youtube-card { transition: none; }
    }
  `;
  // At document-start the page may not have a root element yet.
  const addStyle = () => {
    if (style.isConnected) return;
    const root = document.head || document.documentElement;
    if (root) root.append(style);
  };

  // Embeds being watched for player errors: frame -> {href, src, timer}.
  const watched = new Map();

  const forget = frame => {
    clearInterval(watched.get(frame)?.timer);
    watched.delete(frame);
  };

  const toCard = (frame, href) => {
    const rect = frame.getBoundingClientRect();
    const width = rect.width || Number(frame.width) || 560;
    const height = rect.height || Number(frame.height) || 315;
    const layout = getComputedStyle(frame);
    const card = document.createElement('a');
    card.className = frame.className;
    card.classList.add('qute-youtube-card');
    card.href = href;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', (frame.title || 'YouTube video') + ' — open YouTube in a new tab');
    // Keep the embed's footprint, and scale its ratio if the container shrinks.
    card.style.cssText = frame.style.cssText;
    card.style.width = width + 'px';
    card.style.height = 'auto';
    card.style.aspectRatio = width + ' / ' + height;
    card.style.maxWidth = '100%';
    for (const property of ['margin', 'position', 'top', 'right', 'bottom', 'left', 'verticalAlign', 'order', 'alignSelf', 'gridArea']) {
      card.style[property] = layout[property];
    }

    const content = document.createElement('span');
    content.className = 'qute-youtube-content';
    const actions = document.createElement('span');
    actions.className = 'qute-youtube-actions';
    for (const [name, text] of [
      ['title', frame.title || 'YouTube video'],
      ['play', '▶'],
      ['label', 'Watch on YouTube ↗'],
    ]) {
      const line = document.createElement('span');
      line.className = 'qute-youtube-' + name;
      line.textContent = text;
      if (name === 'play') line.setAttribute('aria-hidden', 'true');
      (name === 'title' ? content : actions).append(line);
    }
    content.append(actions);
    card.append(content);
    forget(frame);
    frame.replaceWith(card);
  };

  const listen = frame => {
    try {
      frame.contentWindow?.postMessage(JSON.stringify({event: 'listening', id: 'qute-embed', channel: 'widget'}), NOCOOKIE_ORIGIN);
    } catch {
      // The frame may be navigating.
    }
  };

  // handshake: ask the player to report its state. Without it (page-controlled
  // players) the messages the page's own API receives are only observed.
  const watch = (frame, href, handshake) => {
    forget(frame);
    const entry = {href, src: frame.src, timer: 0};
    if (handshake) {
      entry.timer = setInterval(() => listen(frame), 500);
      setTimeout(() => clearInterval(entry.timer), HANDSHAKE_MS);
    }
    watched.set(frame, entry);
  };

  addEventListener('message', event => {
    if (!PLAYER_ORIGINS.includes(event.origin)) return;
    for (const [frame, entry] of watched) {
      if (frame.contentWindow !== event.source) continue;
      if (embedFailed(event.data)) {
        toCard(frame, entry.href);
      } else if (embedReady(event.data)) {
        clearInterval(entry.timer); // the player keeps reporting later errors
      }
      return;
    }
  });

  const scan = () => {
    addStyle();
    for (const [frame] of watched) {
      if (!frame.isConnected) forget(frame);
    }
    document.querySelectorAll('iframe:not([data-qute-keep-embed])').forEach(frame => {
      const src = frame.src;
      if (!src || watched.get(frame)?.src === src) return;
      const wrapped = embedlySrc(src);
      if (wrapped) {
        const rect = frame.getBoundingClientRect();
        if (rect.width && rect.height) toCard(frame, watchUrl(wrapped));
        return;
      }
      if (!youtubeUrl(src) || !/^\/embed\//.test(youtubeUrl(src).pathname)) return;
      if (pageControlsPlayer(src)) {
        watch(frame, watchUrl(src), false);
        return;
      }
      const target = nocookieSrc(src, location.origin);
      // Assigning src reloads the frame; only do it when the URL changes.
      if (target !== src) frame.src = target;
      watch(frame, watchUrl(src), true);
    });
  };

  scan();
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
})();
