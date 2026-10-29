'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'),
      path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../lib/motionflow/main.js'), 'utf8');
let observerCallback = null, disconnected = 0;
const current = {
  textContent: '0:57'
};
const ctx = {
  BASE_OPTIONS: {},
  performance: {now: () => 0},
  MutationObserver: class {
    constructor(fn) {
      observerCallback = fn;
    }
    observe() {}
    disconnect() {
      disconnected++;
    }
  }
};
vm.runInNewContext(
    main.slice(
        main.indexOf('function videoTimeText('), main.indexOf('const audio = new AudioRoute')) +
        ';globalThis.Session=PlaybackSession;',
    ctx);
const s = new ctx.Session({currentTime: 57}, {querySelector: () => current}, {}, () => {}, {});
s.setPlayerClock(56);
assert.equal(current.textContent, '0:56');
current.textContent = '0:57';
observerCallback();
assert.equal(current.textContent, '0:56', 'Native writes are corrected in the same text span');
s.setPlayerClock(3723);
assert.equal(current.textContent, '1:02:03');
s.closed = true;
s.releasePlayerClock(57);
observerCallback();
assert.equal(current.textContent, '0:57');
assert.ok(disconnected);
const css = fs.readFileSync(path.join(__dirname, '../lib/motionflow/ui.js'), 'utf8');
assert.ok(
    !css.includes('.ytp-time-current::after') && !css.includes('data-mf-time'),
    'No pseudo timer or extra timer label');
console.log(
    'PASS: The native timer text is reused, tracks native updates, formats hours and restores on stop');
