// Native handoff must seek to the held processed frame and keep audio quiet until ready.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../lib/motionflow/main.js'), 'utf8');
async function scenario({
  paused = false,
  live = false,
  dvr = false,
  preparing = false,
  reconfigure = false,
  finalEnabled = reconfigure
} = {}) {
  let clockTime = null;
  let time = 20, seeks = 0, plays = 0, restarted = 0, nextId = 1;
  const listeners = new Map(), callbacks = new Map(), timers = new Map(), covers = [];
  const video = {
    paused,
    muted: true,
    volume: .35,
    ended: false,
    isConnected: true,
    duration: live ? Infinity : 100,
    seekable: {length: dvr ? 1 : 0, start: () => 10, end: () => 25},
    get currentTime() {
      return time;
    },
    set currentTime(value) {
      time = value;
      seeks++;
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      plays++;
      return Promise.resolve();
    },
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
    requestVideoFrameCallback(fn) {
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    },
    cancelVideoFrameCallback(id) {
      callbacks.delete(id);
    }
  };
  const audio = {
    nativeHeld: false,
    monoEnabled: true,
    holdNative() {
      this.nativeHeld = true;
    },
    releaseNative() {
      this.nativeHeld = false;
    },
    direct() {}
  };
  const old = {
    video,
    stats: {},
    player: {append: item => covers.push(item)},
    layer: {tagName: 'CANVAS', width: 16, height: 16, style: {cssText: ''}},
    hasPresented: !preparing,
    preparing,
    resumeSource: preparing,
    sourceMediaStart: 14.25,
    displayedMediaTime: preparing ? undefined :
        paused                    ? 14.25 :
                                    14,
    frozen: paused,
    releasePlayerClock(value) {
      clockTime = value;
    },
    async freeze() {
      if (this.frozen) return;
      this.frozen = true;
      this.displayedMediaTime = 14.25;
    },
    stop() {
      this.closed = true;
    }
  };
  const context = {
    nativeReturn: null,
    nativeReturnError: '',
    session: old,
    enabled: reconfigure,
    generation: 0,
    warmRestart: null,
    warmRestartTimer: 0,
    state: {},
    audio,
    paint() {},
    reconcile() {
      restarted++;
    },
    browser: {
      setTimeout(fn) {
        const id = nextId++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      }
    },
    document: {
      createElement: () => ({
        style: {},
        getContext: () => ({drawImage() {}}),
        remove() {
          this.removed = true;
        }
      })
    }
  };
  vm.runInNewContext(
      main.slice(main.indexOf('function halt('), main.indexOf('function toggleComparison(')),
      context);
  await context.returnToNative(old);
  if (live && !dvr) {
    assert.equal(seeks, 0, 'Unseekable live sources must not receive an invalid seek');
    assert.equal(context.nativeReturn, null);
    assert.equal(audio.nativeHeld, false);
    assert.match(context.state.message, /seekable buffer/);
    assert.equal(video.paused, false);
  } else {
    assert.equal(
        time, 14.25,
        'Restore the precise cached frame time rather than the capture position or stale progress');
    assert.equal(seeks, 1);
    assert.equal(
        clockTime, 14.25, 'The existing native timer follows the sought frame immediately');
    assert.equal(context.session, null);
    assert.equal(old.closed, true);
    assert.equal(audio.nativeHeld, true);
    assert.equal(video.paused, true);
    const pending = context.nativeReturn;
    context.enabled = finalEnabled;
    context.stopForSettings();
    assert.equal(
        context.nativeReturn, pending,
        'Rapid settings changes retain the same cover/seek and use the latest choices');
    assert.equal(seeks, 1);
    assert.equal(
        covers[0].removed, undefined,
        'Keep the old picture until the sought frame can be displayed');
    const ready = listeners.get('seeked');
    listeners.delete('seeked');
    ready();
    assert.equal(
        video.paused, paused && !preparing, 'Preserve whether playback was playing or paused');
    assert.equal(
        audio.nativeHeld, true, 'Do not reveal ahead-of-position audio at seek completion');
    const [id, decoded] = callbacks.entries().next().value;
    callbacks.delete(id);
    decoded(1234, {mediaTime: 14.25});
    assert.equal(context.nativeReturn, null);
    assert.equal(audio.nativeHeld, false);
    assert.equal(covers[0].removed, true);
    assert.equal(timers.size, 0);
    assert.equal(plays, paused && !preparing ? 0 : 1);
    assert.equal(
        restarted, finalEnabled ? 1 : 0,
        'Enabled processing restarts after the matching native frame is ready');
  }
  assert.equal(video.muted, true);
  assert.equal(video.volume, .35);
  assert.equal(audio.monoEnabled, true);
}
(async () => {
  await scenario();
  await scenario({paused: true});
  await scenario({live: true, dvr: true});
  await scenario({live: true});
  await scenario({paused: true, preparing: true});
  await scenario({reconfigure: true});
  await scenario({reconfigure: true, finalEnabled: false});
  await scenario({finalEnabled: true});
  console.log(
      'PASS: Native handoff restores matching frame time, holds picture/audio, preserves pause/mute/volume/mono, and handles DVR limits');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
