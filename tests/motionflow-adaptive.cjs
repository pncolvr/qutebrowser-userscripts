'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'),
      path = require('node:path');
const context = {};
vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../lib/motionflow/settings.js'), 'utf8') +
        ';globalThis.Quality=AdaptiveQuality;globalThis.fit=adaptiveSizing;',
    context);
const q = new context.Quality();
const requested = {
  key: 'video|60|general',
  enabled: true,
  height: 1440,
  sourceHeight: 480,
  method: 'ai'
};
q.configure(requested);
assert.equal(q.effective.method, 'ai');
assert.equal(q.effective.height, 1440, 'Smoothness starts at full requested AI quality');
let now = 2000;
const sample = (work, extra = {}) => q.sample({
  now: now += 1000,
  readyAt: 0,
  fps: 60,
  workMs: work,
  showing: true,
  held: 0,
  buffered: 800,
  targetBuffer: 900,
  ...extra
});
assert.equal(sample(24), false);
assert.equal(sample(24), true);
assert.equal(q.effective.method, 'ai');
assert.equal(q.effective.height, 1080, 'Lower AI resolution precedes a filter fallback');
for (let i = 0; i < 10 && q.effective.height > 720; i++) sample(24);
assert.equal(q.effective.method, 'ai');
assert.equal(q.effective.height, 720);
for (let i = 0; i < 10 && q.effective.method === 'ai'; i++) sample(24);
assert.equal(
    q.effective.method, 'lanczos', 'Lanczos is a fallback only after lower AI levels fail');
const level = q.level;
for (let i = 0; i < 18; i++) sample(4);
assert.equal(q.level, level, 'Failed higher quality does not immediately oscillate back');
now += 61000;
for (let i = 0; i < 20 && q.level === level; i++) sample(4);
assert.ok(q.level < level, 'Sustained spare capacity retries higher quality');
q.configure({...requested, enabled: false});
for (let i = 0; i < 8; i++) sample(50, {held: 40, buffered: 0});
assert.equal(q.effective.height, 1440);
assert.equal(q.effective.method, 'ai', 'Off preserves full quality despite overload');
q.configure({...requested, key: 'new-settings'});
sample(30, {readyAt: now});
sample(30, {readyAt: now});
assert.equal(q.level, 0, 'Preparation/warmup is not treated as sustained overload');
q.configure(requested);
for (let i = 0; i < 8; i++) sample(0);
assert.equal(q.level, 0, 'Missing telemetry cannot force a downgrade');
const sized = context.fit(
    {videoWidth: 854, videoHeight: 480}, {outputWidth: 2560, outputHeight: 1439, maxFps: 60}, 720);
assert.equal(sized.outputHeight, 720);
assert.equal(sized.maxFps, 60);
assert.ok(Math.abs(sized.outputWidth / sized.outputHeight - 854 / 480) < .003);
console.log(
    'PASS: AI-first adaptation, resolution-before-fallback, warmup guards, recovery hysteresis, Off and aspect/FPS preservation');

q.configure({...requested, key: 'transport-backlog'});
sample(4, {showing: false, deliveredFps: 20, queued: 8});
sample(4, {showing: false, deliveredFps: 20, queued: 8});
assert.equal(q.level, 1, 'A growing delivery backlog can adapt before the presenter ever fills');
q.configure({...requested, key: 'lanczos', method: 'lanczos'});
sample(24);
sample(24);
assert.equal(q.effective.method, 'lanczos');
assert.equal(q.effective.height, 1080);
console.log(
    'PASS: Delivery/CPU backlog and Lanczos-only overload lower resolution without changing FPS');

// Exercise the controller through actual option building and the panel switch.
const main = fs.readFileSync(path.join(__dirname, '../lib/motionflow/main.js'), 'utf8');
const optionsContext = {
  PROFILES: {smooth60: {maxFps: 60}},
  profileId: 'smooth60',
  customFps: 60,
  key: 'video',
  contentId: 'animation',
  resolutionId: '1440',
  smoothingEnabled: true,
  neuralEnabled: true,
  upscaleEnabled: true,
  upscaleMethod: 'ai',
  prioritizeSmoothness: true,
  element: {videoWidth: 854, videoHeight: 480},
  bufferId: 'auto',
  bufferMemoryId: '512',
  browser: {},
  enabled: true,
  stops: 0,
  stopForSettings() {
    optionsContext.stops++;
  },
  reconcile() {}
};
vm.createContext(optionsContext);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../lib/motionflow/settings.js'), 'utf8') +
        ';globalThis.adaptiveQuality=new AdaptiveQuality();',
    optionsContext);
vm.runInContext(
    main.slice(main.indexOf('function playbackOptions('), main.indexOf('function changeOutput(')) +
        main.slice(
            main.indexOf('function toggleSmoothnessPriority('),
            main.indexOf('function toggleMono(')),
    optionsContext);
let opts = optionsContext.playbackOptions();
assert.equal(opts.upscaleMethod, 'ai');
assert.equal(opts.outputHeight, 1439);
for (let i = 0; i < 2; i++)
  optionsContext.adaptiveQuality.sample({now: 3000 + i * 1000, readyAt: 0, fps: 60, workMs: 25});
opts = optionsContext.playbackOptions();
assert.equal(opts.upscaleMethod, 'ai');
assert.equal(opts.outputHeight, 1080);
assert.equal(optionsContext.resolutionId, '1440');
assert.equal(opts.maxFps, 60);
optionsContext.toggleSmoothnessPriority();
opts = optionsContext.playbackOptions();
assert.equal(opts.outputHeight, 1439);
assert.equal(opts.upscaleMethod, 'ai');
assert.equal(opts.smoothnessPriority, false);
assert.equal(optionsContext.stops, 1);
optionsContext.toggleSmoothnessPriority();
assert.equal(optionsContext.playbackOptions().upscaleMethod, 'ai');
assert.equal(
    optionsContext.stops, 1,
    'Turning adaptive monitoring on alone does not restart full-quality playback');
console.log(
    'PASS: Actual playback options retain AI-first behavior, requested controls and FPS, and Off restores full quality');

q.configure({...requested, key: 'fps15'});
for (let i = 0; i < 8; i++)
  sample(20, {fps: 15, held: 12, buffered: 80, targetBuffer: 550, deliveredFps: 15, queued: 0});
assert.equal(
    q.level, 0,
    'Meeting a selected 15 FPS must not lower AI quality because of normal frame holds');
sample(80, {fps: 15, held: 0, deliveredFps: 10, queued: 5});
sample(80, {fps: 15, held: 0, deliveredFps: 10, queued: 5});
assert.equal(q.level, 1, 'Real processing overload at 15 FPS still reduces quality');
now += 61000;
for (let i = 0; i < 20 && q.level > 0; i++)
  sample(20, {fps: 15, held: 12, buffered: 500, targetBuffer: 550, deliveredFps: 15, queued: 0});
assert.equal(
    q.level, 0, 'Healthy capped delivery can recover AI quality despite intentional display holds');
q.configure({...requested, key: 'fps15-deficit'});
sample(20, {fps: 15, held: 8, buffered: 60, targetBuffer: 550, deliveredFps: 8, queued: 0});
sample(20, {fps: 15, held: 8, buffered: 60, targetBuffer: 550, deliveredFps: 8, queued: 0});
assert.equal(q.level, 1, 'Confirmed delivery shortfall plus starvation can still reduce quality');
console.log(
    'PASS: Intentional 15 FPS holds retain/recover AI; actual low-FPS overload and starvation remain actionable');
