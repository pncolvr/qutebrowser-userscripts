// Code-native SVG and scoped CSS keep the controls self-contained and compatible
// with Trusted Types. No HTML strings or external icon/font assets are loaded.
let acceptsInput = event => event.isTrusted;
function motionIcon(name) {
  const paths = {
    motion: [
      'M5 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z', 'm8 9 5 3-5 3Z',
      'M20 8v8M23 10v4'
    ],
    settings: ['M3 6h20M3 12h20M3 18h20'],
    check: ['m5 12 4 4L19 6'],
    compare: [
      'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM12 4v16M6 8h3M6 12h3M6 16h3'
    ],
    audio: ['M4 9h4l5-4v14l-5-4H4Z', 'M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14'],
    diagnostics: ['M4 19V5m0 14h16M8 15v-4m4 4V8m4 7v-6m4 6V5'],
    arrow: ['m9 5 7 7-7 7'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 26 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('mf-icon');
  for (const data of paths[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', data);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  if (name === 'settings') {
    for (const [x, y, travel] of [[9, 6, 8], [17, 12, -8], [9, 18, 8]]) {
      const knob = document.createElementNS(svg.namespaceURI, 'circle');
      knob.setAttribute('cx', x);
      knob.setAttribute('cy', y);
      knob.setAttribute('r', '3');
      knob.setAttribute('fill', 'currentColor');
      knob.classList.add('mf-slider-knob');
      knob.style.setProperty('--mf-slide', travel + 'px');
      svg.append(knob);
    }
  }
  return svg;
}

function installControlStyle() {
  if (document.getElementById('qute-motionflow-style')) return;
  const style = document.createElement('style');
  style.id = 'qute-motionflow-style';
  style.textContent = `
    :is(#movie_player,.mf-player) .mf-control {
      position:relative;display:inline-flex;align-items:center;justify-content:center;
      box-sizing:border-box;width:48px;height:100%;min-height:36px;margin:0;padding:0;
      border:0;background:transparent;color:#fff;vertical-align:top;cursor:pointer;
      font:500 12px/1 Roboto,Arial,sans-serif;gap:3px;white-space:nowrap;
    }
    :is(#movie_player,.mf-player) .mf-control .mf-icon {width:25px;height:25px;flex:none;opacity:.9;transition:opacity .15s}
    :is(#movie_player,.mf-player) .mf-control:hover .mf-icon,:is(#movie_player,.mf-player) .mf-control:focus-visible .mf-icon {opacity:1}
    :is(#movie_player,.mf-player) .mf-control:focus-visible {outline:2px solid #fff;outline-offset:-5px;border-radius:6px}
    #qute-motionflow-options::after {content:'';position:absolute;bottom:7px;left:16px;right:16px;height:3px;background:#ff0033;border-radius:2px;opacity:0}
    #qute-motionflow-options[data-enabled=true]::after {opacity:0}
    #qute-motionflow-options[data-state=error] {color:#ff8a80}
    #qute-motionflow-options[aria-expanded=true] {background:transparent;border-radius:6px}
    #qute-motionflow-options[aria-expanded=true] .mf-icon {opacity:1}
    #qute-motionflow-panel {
      position:fixed;inset:auto;margin:0;z-index:2147483647;box-sizing:border-box;
      width:326px;max-width:calc(100% - 24px);max-height:calc(100% - 76px);overflow:auto;
      padding:8px;background:rgba(28,28,28,.97);color:#fff;border:0;border-radius:12px;
      box-shadow:0 8px 28px #0004;backdrop-filter:none;pointer-events:auto;
      font:400 13px/1.4 Roboto,Arial,sans-serif;text-align:left;scrollbar-width:thin;scrollbar-color:#ffffff66 transparent;
    }
    :is(#movie_player,.mf-player).mf-finishing .html5-endscreen {visibility:hidden;pointer-events:none}
    #movie_player.mf-clock-active .ytp-play-progress {transform:scaleX(var(--mf-progress))!important}
    #movie_player.mf-clock-active .ytp-scrubber-container {transform:translateX(var(--mf-progress-px))!important}
    #qute-motionflow-panel::-webkit-scrollbar {width:6px}
    #qute-motionflow-panel::-webkit-scrollbar-track {background:transparent}
    #qute-motionflow-panel::-webkit-scrollbar-thumb {background:#ffffff66;border-radius:3px}
    #qute-motionflow-panel .mf-heading {padding:10px 16px 14px;font-size:14px;font-weight:500;border-bottom:1px solid #ffffff1a}
    #qute-motionflow-panel .mf-group {padding:6px 0}
    #qute-motionflow-panel .mf-row {
      display:flex;align-items:center;justify-content:flex-start;box-sizing:border-box;
      width:100%;min-height:48px;padding:10px 16px;margin:0;border:0;border-radius:8px;
      background:transparent;color:inherit;text-align:left;cursor:pointer;gap:12px;
      font:400 14px/1.35 Roboto,Arial,sans-serif;white-space:nowrap;
    }
    #qute-motionflow-panel .mf-row:not(:disabled):hover {background:#ffffff14}
    #qute-motionflow-panel .mf-row:focus-visible {outline:2px solid #fff;outline-offset:-3px;border-radius:4px;background:#ffffff14}
    #qute-motionflow-panel .mf-row:disabled {opacity:.38;cursor:default}
    #qute-motionflow-panel .mf-icon {width:20px;height:20px;flex:none}
    #qute-motionflow-panel .mf-check {opacity:0}
    #qute-motionflow-panel [aria-checked=true] .mf-check {opacity:1}
    #qute-motionflow-panel .mf-label {flex:1;min-width:0}
    #qute-motionflow-panel .mf-value {color:#bbb;font-size:14px;text-align:right;line-height:1.25}
    #qute-motionflow-panel .mf-detail {display:block;font-size:10px;color:#aaa;margin-top:2px}
    #qute-motionflow-panel .mf-separator {height:1px;background:#ffffff1a;margin:0 0 6px}
    #qute-motionflow-panel .mf-switch {position:relative;width:38px;height:22px;flex:none;border-radius:10px;background:#777;transition:background .15s}
    #qute-motionflow-panel .mf-switch::after {content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .15s}
    #qute-motionflow-panel [aria-checked=true] .mf-switch {background:#888}
    #qute-motionflow-panel [aria-checked=true] .mf-switch::after {transform:translateX(14px)}
    #qute-motionflow-panel .mf-diagnostic-result {display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;color:#ccc}
    #qute-motionflow-panel .mf-content {display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 8px 8px}
    #qute-motionflow-panel .mf-note {display:flex;justify-content:space-between;margin-top:5px;padding:10px 20px 7px;border-top:1px solid #ffffff1a;color:#aaa;font-size:11px}
    #qute-motionflow-status {position:absolute;bottom:58px;left:50%;transform:translateX(-50%);z-index:60;background:#1c1c1ce8;color:#eee;padding:7px 12px;border-radius:6px;font:12px/1.4 Roboto,Arial,sans-serif;pointer-events:none;max-width:85%;text-align:center}
    #movie_player.ytp-autohide #qute-motionflow-status,#movie_player.ytp-hide-controls #qute-motionflow-status {opacity:0}
    #qute-motionflow-divider {position:absolute;width:24px;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:12;display:none;pointer-events:auto;outline:0;user-select:none}
    #qute-motionflow-divider::before {content:'';position:absolute;left:11px;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 3px #0009}
    #qute-motionflow-divider::after {content:'‹ ›';position:absolute;left:-5px;top:50%;transform:translateY(-50%);width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#1c1c1cd9;color:#fff;font:700 18px Arial,sans-serif;box-shadow:0 1px 5px #0008}
    #qute-motionflow-divider:focus-visible::after {outline:2px solid #fff;outline-offset:3px}


    #qute-motionflow-options[aria-expanded=true]::after {opacity:0}
    #qute-motionflow-options .mf-slider-knob {transform:translateX(0);transition:transform .18s ease-in-out}
    #qute-motionflow-options[aria-expanded=true] .mf-slider-knob {transform:translateX(var(--mf-slide))}
    .mf-player > .mf-generic-controls {position:absolute;right:12px;bottom:12px;z-index:62;height:38px;display:flex;background:transparent;border-radius:8px}
    .mf-generic-controls .mf-icon {filter:drop-shadow(0 1px 2px #000b)}
    #qute-motionflow-panel .mf-fps {display:flex;flex-wrap:wrap;gap:6px}
    #qute-motionflow-panel .mf-fps .mf-label {flex:none}
    #qute-motionflow-panel .mf-select-row {display:flex;align-items:center;gap:8px;min-height:46px;padding:0 16px;font-size:14px}
    #qute-motionflow-panel select {max-width:195px;background:transparent;border:0;color:#ddd;cursor:pointer;text-align:right;font:inherit;outline-offset:3px}
    #qute-motionflow-panel input {width:85px;background:#ffffff12;border:1px solid #ffffff30;border-radius:4px;color:#fff;font:inherit;padding:5px 7px;text-align:right}
    #qute-motionflow-panel .mf-upscale-detail {padding:4px 16px 10px;color:#aaa;font-size:11px;white-space:normal}
    #qute-motionflow-panel .mf-performance-note {padding:4px 16px 10px;color:#ffcb87;font-size:11px;line-height:1.4}
    #qute-motionflow-panel option {background:#282828;color:#fff}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) .mf-row {
      width:auto;min-height:32px;height:32px;border-radius:999px;padding:7px 12px;
      justify-content:center;gap:5px;background:#ffffff14;font:500 12px/18px Roboto,Arial,sans-serif;
    }
    #qute-motionflow-panel .mf-fps .mf-row {min-width:48px;flex:1 1 auto;padding:7px 6px;gap:4px}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) .mf-check {display:none;width:14px;height:14px;opacity:1}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) [aria-checked=true] .mf-check {display:block}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) .mf-row[aria-checked=true] {background:#ffffff26}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) .mf-row:not(:disabled):hover {background:#ffffff30}
    #qute-motionflow-panel :is(.mf-fps,.mf-content) .mf-row:not(:disabled):active {background:#ffffff3d}
    #qute-motionflow-panel .mf-summary {padding:10px 16px 5px;font-size:12px;color:#ddd}
    #qute-motionflow-panel .mf-summary > div {display:flex;justify-content:space-between;margin:3px 0}
    #qute-motionflow-panel .mf-summary > div > :last-child {color:#aaa}
    #qute-motionflow-panel .mf-buffer-view {padding:4px 16px 12px;font-size:11px;color:#aaa}
    #qute-motionflow-panel .mf-buffer-view[data-low=true] .mf-buffer-text {color:#ffbc70}
    #qute-motionflow-panel progress,#qute-motionflow-buffer progress {display:block;width:100%;height:4px;margin-top:7px;border:0;border-radius:2px;accent-color:#ff0033;background:#ffffff24}
    #qute-motionflow-panel progress::-webkit-progress-bar,#qute-motionflow-buffer progress::-webkit-progress-bar {background:#ffffff24;border-radius:2px}
    #qute-motionflow-panel progress::-webkit-progress-value,#qute-motionflow-buffer progress::-webkit-progress-value {background:#ff0033;border-radius:2px;transition:width .1s linear}
    #qute-motionflow-buffer {position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:220px;padding:14px 18px;background:#1c1c1ce6;border-radius:10px;color:#fff;font:13px/1.5 Roboto,Arial,sans-serif;z-index:60;pointer-events:none}
    #qute-motionflow-diagnostic-overlay {position:absolute;top:12px;left:12px;margin:0;padding:10px 12px;border-radius:6px;background:#000b;color:#fff;font:11px/1.6 monospace;white-space:pre;z-index:60;pointer-events:none;text-shadow:0 1px 1px #000}
    @media(prefers-reduced-motion:reduce){#qute-motionflow-options .mf-slider-knob{transition:none}#qute-motionflow-panel .mf-switch::after,#qute-motionflow-panel progress::-webkit-progress-value{transition:none}}
  `;
  (document.head || document.documentElement).append(style);
}

function uiText(className, value = '') {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  return span;
}
function makeButton(id, action, inPanel = false) {
  const control = document.createElement('button');
  control.id = id;
  control.type = 'button';
  control.className = inPanel ? 'mf-row' : 'ytp-button mf-control';
  control.addEventListener('click', event => {
    if (!acceptsInput(event)) return;
    event.preventDefault();
    event.stopPropagation();
    action(event);
  });
  return control;
}
function actionRow(id, iconName, label, action) {
  const control = makeButton(id, action, true);
  control.setAttribute('role', 'menuitem');
  control.append(motionIcon(iconName), uiText('mf-label', label));
  return control;
}
