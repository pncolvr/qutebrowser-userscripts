// ==UserScript==
// @name         YouTube embed to link
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  console.info('[YouTube Embed to Link] Enabled — watching for embedded videos.');

  const youtubeId = src => {
    try {
      const url = new URL(src);
      if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname)) return null;
      return /^\/embed\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1] || null;
    } catch {
      return null;
    }
  };

  const embedId = src => {
    const direct = youtubeId(src);
    if (direct) return direct;
    try {
      const url = new URL(src);
      // Replace Embedly's outer frame so the card is hintable on the host page.
      if (url.hostname === 'cdn.embedly.com' && url.pathname === '/widgets/media.html') {
        return youtubeId(url.searchParams.get('src'));
      }
    } catch {
      // Empty or invalid iframe URLs are unrelated to YouTube.
    }
    return null;
  };

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
  (document.head || document.documentElement).append(style);

  const swap = () => {
    document.querySelectorAll('iframe').forEach(frame => {
      const id = embedId(frame.src);
      if (!id) return;
      const rect = frame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const layout = getComputedStyle(frame);
      const card = document.createElement('a');
      card.className = frame.className;
      card.classList.add('qute-youtube-card');
      card.href = 'https://www.youtube.com/watch?v=' + id;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.setAttribute('aria-label', (frame.title || 'YouTube video') + ' — open YouTube in a new tab');
      // Keep the embed's footprint, and scale its ratio if the container shrinks.
      card.style.cssText = frame.style.cssText;
      card.style.width = rect.width + 'px';
      card.style.height = 'auto';
      card.style.aspectRatio = rect.width + ' / ' + rect.height;
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
      frame.replaceWith(card);
    });
  };

  swap();
  new MutationObserver(swap).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'style', 'class', 'width', 'height'],
  });
})();
