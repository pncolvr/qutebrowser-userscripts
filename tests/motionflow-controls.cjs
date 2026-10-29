// Deterministic races: user controls remain authoritative across worker startup/writes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = process.env.MOTIONFLOW_SOURCE || path.join(__dirname, '../lib/motionflow');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
if (!process.argv.includes('--presenter-only')) {
  const sandbox = {BASE_OPTIONS: {}, performance: {now: () => 100}};
  vm.runInNewContext(
      main.slice(
          main.indexOf('class PlaybackSession'), main.indexOf('const audio = new AudioRoute')) +
          ';globalThis.Session = PlaybackSession;',
      sandbox);
  const session =
      new sandbox.Session({currentTime: 0}, {}, {}, () => {}, {comparisonInPresenter: true});
  const commands = [];
  session.position = () => {};
  session.presenter = {postMessage: data => commands.push(data)};
  session.compare(true);
  assert.equal(commands.length, 0, 'Do not send comparison to an uninitialized worker');
  session.rendererReady = true;
  session.syncComparison();
  assert.equal(commands.at(-1).enabled, true, 'Ready worker gets the latest user preference');
  session.acknowledgeComparison({enabled: false, revision: 0, split: .5});
  assert.equal(session.comparison, true, 'A stale acknowledgement cannot change the preference');
  assert.equal(session.displayedComparison, false);
  session.acknowledgeComparison({enabled: true, revision: 1, split: .5});
  assert.equal(session.displayedComparison, true);
  session.compare(true, .7);
  assert.equal(session.comparisonRevision, 1, 'Dragging does not invalidate every in-flight frame');
  session.acknowledgeComparison({enabled: true, revision: 1, split: .6});
  assert.equal(
      session.displayedSplit, .6, 'The divider tracks the actual written split during drag');
  session.compare(false);
  session.acknowledgeComparison({enabled: true, revision: 1, split: .7});
  assert.equal(session.displayedComparison, false, 'An older enabled frame cannot undo Off');
  session.compare(true);
  session.acknowledgeComparison({enabled: false, revision: 2, split: .7});
  assert.equal(session.comparison, true, 'Rapid Off/On preserves the last toggle');
  assert.equal(session.displayedComparison, false);
  session.acknowledgeComparison({enabled: true, revision: 3, split: .7});
  assert.equal(session.displayedComparison, true);
  console.log(
      'PASS: Latest comparison preference survives worker startup, stale acknowledgements and dragging');

  let freezes = 0;
  session.freezeFrame = () => {freezes++;return Promise.resolve();};
  assert.equal(session.freeze(), session.freeze(), 'Pause and handoff share a single snapshot operation');
  assert.equal(freezes, 1);
  const choices = {
    comparison: true,
    enabled: true,
    smoothingEnabled: false,
    upscaleEnabled: true,
    neuralEnabled: true,
    resolutionId: '720',
    audio: {unlock() {}},
    stopForSettings() {},
    halt() {},
    reconcile() {}
  };
  for (const [begin, end] of [
           ['function changeOutput(', 'function selectContent('],
           ['function toggleAI(', 'function panelIsBusy('],
           ['function toggleSmoothing(', 'function selectProfile(']])
    vm.runInNewContext(main.slice(main.indexOf(begin), main.indexOf(end)), choices);
  choices.changeOutput('upscale');
  assert.equal(choices.enabled, false);
  assert.equal(choices.comparison, true, 'Stopping processing retains the compare preference');
  choices.toggleSmoothing();
  choices.toggleSmoothing();
  assert.equal(choices.comparison, true);
  choices.toggleAI();
  assert.equal(choices.comparison, true, 'Engine changes cannot silently disable comparison');
  console.log('PASS: Processing and engine switches retain the comparison setting');

  const owner = {isConnected: true, classList: {contains: () => false}};
  const oldVideo = {isConnected: true, currentTime: 0, paused: true, readyState: 4},
        replacement = {...oldVideo};
  const selection = {
    performance: {now: () => 100},
    priorityButton: null,
    key: 'same',
    owner,
    element: oldVideo,
    enabled: true,
    smoothingEnabled: true,
    upscaleEnabled: false,
    comparison: true,
    optionsOpen: true,
    identity: () => 'same',
    videoSelection: () => ({player: owner, video: replacement}),
    audio: {monoEnabled: false, setMono() {}},
    warmRestart: null,
    nativeReturn: null,
    nativeReturnError: '',
    session: null,
    adWatcher: null,
    observedPlayer: owner,
    optionsButton: null,
    panel: null,
    badge: null,
    diagnosticOverlay: null,
    bufferOverlay: null,
    smoothingButton: null,
    compareButton: null,
    monoButton: null,
    diagnosticButton: null,
    aiButton: null,
    statusTimer: 0,
    browser: {clearTimeout() {}},
    document: {},
    controls() {},
    paint() {},
    halt() {
      selection.session = null;
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    }
  };
  const begin = main.indexOf('function reconcile()'),
        end = main.indexOf('\nfor (const event\n', begin);
  vm.runInNewContext(main.slice(begin, end), selection);
  selection.reconcile();
  assert.equal(selection.element, replacement);
  assert.equal(selection.comparison, true);
  assert.equal(selection.optionsOpen, true);
  assert.equal(selection.enabled, true);
  selection.videoSelection = () => ({});
  selection.reconcile();
  assert.equal(
      selection.element, replacement, 'Temporary selection gaps retain the connected source');
  selection.identity = () => 'different';
  selection.reconcile();
  assert.equal(selection.comparison, false);
  assert.equal(selection.enabled, false);
  assert.equal(selection.optionsOpen, false);
  console.log('PASS: Same-video replacements retain controls while a different video resets them');

  let hovered = false, now = 100, focus = null;
  const panel = {matches: () => hovered, contains: target => !!target?.inside};
  const ui = {
    panel,
    optionsOpen: true,
    panelInteractionUntil: 0,
    document: {
      get activeElement() {
        return focus;
      }
    },
    performance: {now: () => now}
  };
  vm.runInNewContext(
      main.slice(main.indexOf('function panelIsBusy()'), main.indexOf('function paint()')) +
          ';globalThis.busy = panelIsBusy;',
      ui);
  assert.equal(ui.busy(), false);
  hovered = true;
  assert.equal(ui.busy(), true, 'Keep panel open under the pointer');
  hovered = false;
  focus = {inside: true, matches: value => value === 'input,select,textarea'};
  assert.equal(ui.busy(), true, 'Typing/native selection keeps settings open');
  focus = {inside: true, matches: value => value === ':focus-visible'};
  assert.equal(ui.busy(), true, 'Keyboard menu navigation keeps settings open');
  focus = null;
  ui.panelInteractionUntil = 1600;
  assert.equal(ui.busy(), true, 'Changes get a short interaction grace period');
  now = 1700;
  assert.equal(ui.busy(), false, 'Idle settings still auto-dismiss with native controls');
  console.log('PASS: Panel interaction protects edits while idle auto-dismiss remains available');
}

async function checkPresenterRace() {
  const frames = [], writes = [], messages = [];
  let nextRaf = null, now = 0, unblock = null, firstWrite = true;
  class Frame {
    constructor(input, options = {}) {
      assert.ok(!input.closed);
      this.time = input.time ?? 0;
      this.codedWidth = this.displayWidth = 16;
      this.codedHeight = this.displayHeight = 16;
      this.format = 'RGBA';
      this.composed = !!input.composed;
      this.split = input.split;
      this.timestamp = options.timestamp;
      frames.push(this);
    }
    close() {
      assert.ok(!this.closed, 'Close a frame once');
      this.closed = true;
    }
  }
  class Canvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        drawImage: input => {
          this.time = input.time;
          this.composed = !!this.clipped;
        },
        save() {},
        beginPath() {},
        rect: (_x, _y, width) => {
          this.split = width / this.width;
        },
        clip: () => {
          this.clipped = true;
        },
        restore: () => {
          this.clipped = false;
        }
      };
    }
  }
  const port = {postMessage() {}, close() {}};
  const self = {
    postMessage: data => messages.push(data),
    requestAnimationFrame: fn => {
      nextRaf = fn;
      return 1;
    },
    cancelAnimationFrame() {
      nextRaf = null;
    }
  };
  const writer = {
    write: async frame => {
      writes.push({composed: frame.composed, split: frame.split, time: frame.time});
      if (firstWrite) {
        firstWrite = false;
        await new Promise(resolve => unblock = resolve);
      }
    },
    close: async () => {}
  };
  vm.runInNewContext(
      fs.readFileSync(path.join(root, 'presenter.js'), 'utf8') + ';presentationWorker();', {
        self,
        VideoFrame: Frame,
        OffscreenCanvas: Canvas,
        performance: {timeOrigin: 0, now: () => now}
      });
  await self.onmessage({
    data: {
      type: 'start',
      options: {
        maxFps: 60,
        delayMs: 0,
        bufferMs: 0,
        comparisonInPresenter: true,
        comparison: false,
        comparisonRevision: 0
      },
      port,
      output: {getWriter: () => writer}
    }
  });
  port.onmessage({
    data: {
      type: 'batch',
      clockOrigin: 0,
      frames:
          [{frame: new Frame({time: 0}), original: new Frame({time: 0}), time: 0, originalTime: 0}]
    }
  });
  const writing = nextRaf(now);
  assert.ok(unblock, 'First frame is in flight');
  await self.onmessage({data: {type: 'comparison', enabled: true, split: .7, revision: 1}});
  unblock();
  await writing;
  const firstAck = messages.find(m => m.type === 'comparison');
  assert.equal(
      firstAck.enabled, false,
      'An acknowledgement describes the frame actually composed before await');
  assert.equal(firstAck.revision, 0);
  now = 17;
  await nextRaf(now);
  assert.equal(
      writes.at(-1).composed, true, 'On redraws the cached pair without another source frame');
  assert.equal(messages.at(-1).type === 'error', false);
  assert.equal(messages.filter(m => m.type === 'comparison').at(-1).revision, 1);
  await self.onmessage({data: {type: 'comparison', enabled: false, split: .7, revision: 2}});
  now = 34;
  await nextRaf(now);
  assert.equal(writes.at(-1).composed, false, 'Off removes the composite while the source is held');
  assert.equal(messages.filter(m => m.type === 'comparison').at(-1).enabled, false);
  await self.onmessage({data: {type: 'stop'}});
  assert.ok(frames.every(f => f.closed), 'All output, cached and original frames are released');
  assert.ok(!messages.some(m => m.type === 'error'), JSON.stringify(messages));
  console.log(
      'PASS: In-flight composition snapshots and cached On/Off redraws preserve the latest control');
}
checkPresenterRace().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
