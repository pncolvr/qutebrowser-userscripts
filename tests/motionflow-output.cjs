'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../lib/motionflow/main.js'), 'utf8');
const context = {
  BASE_OPTIONS: {},
  performance: {now: () => 0}
};
vm.runInNewContext(
    main.slice(
        main.indexOf('class PlaybackSession'), main.indexOf('const audio = new AudioRoute')) +
        ';globalThis.Session=PlaybackSession;',
    context);
function setup() {
  const errors = [];
  const session = new context.Session({currentTime: 0}, {}, {}, e => errors.push(e), {});
  let reject;
  const output = {
    play() {
      return new Promise((_, r) => reject = r)
    },
    pause() {
      reject(Object.assign(
          new Error('The play() request was interrupted by a call to pause().'),
          {name: 'AbortError'}))
    }
  };
  session.layer = output;
  return {session, errors, output, reject: error => reject(error)};
}
(async () => {
  const owned = setup();
  const pending = owned.session.playOutput();
  owned.session.pauseOutput();
  await pending;
  assert.deepEqual(
      owned.errors, [], 'An intentional pause cancels pending play without failing the session');
  assert.equal(owned.session.closed, false);
  let t = setup(), play = t.session.playOutput();
  t.session.layer = {};
  t.reject(new Error('obsolete decoder'));
  await play;
  assert.equal(t.errors.length, 0, 'An obsolete output cannot fail its replacement');
  t = setup();
  play = t.session.playOutput();
  t.session.closed = true;
  t.reject(new Error('closed'));
  await play;
  assert.equal(t.errors.length, 0);
  t = setup();
  play = t.session.playOutput();
  t.reject(Object.assign(new Error('Decoder unavailable'), {name: 'NotSupportedError'}));
  await play;
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0].message, /Decoder unavailable/);
  // Use a separate scenario to check a delayed rejection from an older play request.
  const errors = [], rejectors = [];
  const session = new context.Session({currentTime: 0}, {}, {}, e => errors.push(e), {});
  session.layer = {play: () => new Promise((_, reject) => rejectors.push(reject))};
  const first = session.playOutput(), second = session.playOutput();
  rejectors[0](new Error('obsolete request'));
  await first;
  assert.equal(errors.length, 0);
  rejectors[1](Object.assign(new Error('Unexpected abort'), {name: 'AbortError'}));
  await second;
  assert.equal(errors.length, 1, 'Unexpected playback errors are not blanket-ignored');
  console.log(
      'PASS: Owned pauses cancel pending output play; stale/closed requests are ignored and current genuine errors remain visible');
  let retries = 0, paints = 0;
  const controls = {
    comparison: true,
    enabled: true,
    state: {state: 'error'},
    session: {closed: true, compare() {}},
    halt() {
      controls.session = null;
    },
    reconcile() {
      retries++;
    },
    paint() {
      paints++;
    }
  };
  vm.runInNewContext(
      main.slice(
          main.indexOf('function toggleComparison('),
          main.indexOf('function toggleSmoothnessPriority(')),
      controls);
  controls.toggleComparison();
  assert.equal(controls.comparison, false);
  assert.equal(retries, 0);
  controls.toggleComparison();
  assert.equal(controls.comparison, true);
  assert.equal(retries, 1);
  assert.equal(controls.enabled, true);
  controls.enabled = false;
  controls.comparison = false;
  controls.session = {closed: true, compare() {}};
  controls.toggleComparison();
  assert.equal(retries, 1, 'Arming comparison while processing is off does not start processing');
  console.log(
      'PASS: Compare preference remains authoritative; explicit On retries a failed session without enabling disabled processing');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
