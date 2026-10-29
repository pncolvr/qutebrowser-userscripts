'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main =
    fs.readFileSync(require('node:path').join(__dirname, '../lib/motionflow/main.js'), 'utf8');
let sources = 0;
const parameter = (value = 1) => ({
  value,
  ramps: [],
  cancelScheduledValues() {},
  setValueAtTime(value) {
    this.value = value;
  },
  linearRampToValueAtTime(value, at) {
    this.value = value;
    this.ramps.push(at);
  }
});
const node = () => ({
  connections: [],
  connect(target) {
    this.connections.push(target);
  },
  disconnect() {}
});
class Context {
  constructor() {
    this.state = 'running';
    this.currentTime = 1;
    this.baseLatency = 0;
    this.destination = {};
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return {...node(), gain: parameter()};
  }
  createDelay() {
    return {...node(), delayTime: parameter(0)};
  }
  createMediaElementSource() {
    sources++;
    return node();
  }
}
const sandbox = {
  browser: {AudioContext: Context, setTimeout: fn => fn()},
  document: {createElement: () => ({getContext: () => ({drawImage() {}, getImageData() {}})})}
};
vm.runInNewContext(
    main.slice(main.indexOf('class AudioRoute'), main.indexOf('class PlaybackSession')) +
        ';globalThis.audio = new AudioRoute();',
    sandbox);
const audio = sandbox.audio, video = {};
assert.ok(audio.setMono(video, true));
const route = audio.current;
assert.equal(sources, 1);
assert.equal(audio.monoEnabled, true);
assert.equal(route.active, false, 'Mono alone must not add video/audio delay');
assert.equal(route.mono.channelCount, 1);
assert.equal(route.mono.channelCountMode, 'explicit');
assert.equal(route.mono.channelInterpretation, 'speakers');
assert.equal(route.mono.gain.value, 1);
assert.equal(route.stereo.gain.value, 0);
assert.ok(route.direct.connections.includes(route.mono));
assert.ok(route.direct.connections.includes(route.stereo));
assert.equal(route.mono.gain.ramps.at(-1), 1.015, 'Channel changes crossfade for 15ms');
let heldAt = null;
route.mono.gain.cancelAndHoldAtTime = at => {
  heldAt = at;
};
audio.setMono(video, false);
assert.equal(heldAt, 1, 'Rapid toggles must hold the current ramp value');
audio.setMono(video, true);
assert.equal(
    route.stereo.gain.ramps.at(-1), route.mono.gain.ramps.at(-1),
    'Both paths must use the same crossfade clock');
audio.follow(video, 550, false);
const delay = route.delay, delayMs = audio.delayMs;
assert.ok(route.gate.connections.includes(route.mono), 'Delayed playback shares the same mono mix');
assert.ok(audio.setMono(video, false));
assert.equal(route.stereo.gain.value, 1);
assert.equal(route.mono.gain.value, 0);
assert.equal(audio.delayMs, delayMs, 'Changing channels must not change synchronization');
assert.equal(route.delay, delay, 'Changing channels must not restart preparation');
assert.equal(route.active, true);
audio.setMono(video, true);
audio.direct();
assert.equal(audio.monoEnabled, true, 'Stopping video processing must retain mono');
assert.equal(route.mono.gain.value, 1);
assert.equal(sources, 1, 'Toggles must reuse the media source');
audio.setMono(video, false);
assert.equal(route.stereo.gain.value, 1);
audio.holdNative();audio.direct();
assert.equal(route.direct.gain.value, 0, 'Native handoff remains silent while the source seeks');
assert.equal(audio.nativeHeld, true);
audio.releaseNative();
assert.equal(route.direct.gain.value, 1, 'Native audio fades in only after the matching frame is ready');
assert.equal(audio.nativeHeld, false);
const protectedVideo = {
  mediaKeys: {}
};
assert.equal(audio.setMono(protectedVideo, true), false);
assert.equal(sources, 1, 'Protected media must not be rerouted');
assert.equal(audio.monoEnabled, false);
sandbox.document.createElement = () => ({
  getContext: () => ({
    drawImage() {},
    getImageData() {
      throw new Error('Cross-origin video');
    }
  })
});
assert.equal(audio.setMono({}, true), false);
assert.equal(sources, 1, 'Cross-origin errors must leave native audio untouched');
console.log(
    'PASS: Mono/default routing, smooth switching, delay preservation and protected/CORS guards');
