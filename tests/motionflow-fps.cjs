'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'),
      path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exercise(
    {engine = 'neural', sourceFps = 60, target = 30, resize = true, interpolation = false}) {
  const created = [], reports = [], messages = [], requests = [];
  let copies = 0, controller;
  class Frame {
    constructor(input, options = {}) {
      assert.ok(!input.closed);
      this.pixels = input instanceof Frame ? input.pixels.slice() : new Uint8Array(input);
      this.timestamp = options.timestamp ?? input.timestamp ?? 0;
      this.displayWidth = this.codedWidth = options.codedWidth ?? input.displayWidth ?? 2;
      this.displayHeight = this.codedHeight = options.codedHeight ?? input.displayHeight ?? 2;
      this.format = 'RGBA';
      this.closed = false;
      created.push(this);
    }
    async copyTo(bytes) {
      copies++;
      bytes.set(this.pixels);
    }
    close() {
      assert.ok(!this.closed, 'Every frame must close once');
      this.closed = true;
    }
  }
  class Socket {
    constructor() {
      queueMicrotask(() => this.onopen());
    }
    send(value) {
      if (typeof value === 'string') {
        this.request = JSON.parse(value);
        if (this.request.protocol)
          queueMicrotask(
              () => this.onmessage(
                  {data: JSON.stringify({type: 'ready', protocol: 1, upscaleMethod: 'ai'})}));
        if (this.request.type === 'reset')
          queueMicrotask(() => this.onmessage({data: JSON.stringify({type: 'reset'})}));
        return;
      }
      const request = this.request;
      requests.push(request);
      assert.equal(
          request.passthrough, true, 'Dropping FPS or resizing alone must never run interpolation');
      const pixels = new Uint8Array((resize ? 4 : 2) ** 2 * 4).fill(value[0]);
      queueMicrotask(() => {
        this.onmessage({
          data: JSON.stringify({
            type: 'frames',
            frames: [{time: request.time, originalTime: request.time, generated: false}],
            workOutputFrames: 1,
            processingMs: 2
          })
        });
        this.onmessage({data: pixels.buffer});
      });
    }
    close() {
      this.onclose?.();
    }
  }
  const self = {postMessage: message => reports.push(message), close() {}};
  const port = {postMessage: message => messages.push(message), close() {}};
  let source = fs.readFileSync(
      path.join(
          __dirname, `../lib/motionflow/${engine === 'neural' ? 'neural-worker' : 'worker'}.js`),
      'utf8');
  if (engine === 'optical') {
    // Frame selection must bypass the real optical flow entry points completely.
    const a = source.indexOf('  class Interpolator {'), b = source.indexOf('  class Timeline {');
    source = source.slice(0, a) + `  class Interpolator {
      constructor(){this.width=this.height=2;}
      accept(){throw new Error('Unexpected optical flow upload');}
      render(){throw new Error('Unexpected optical flow rendering');}
      dispose(){}
    }\n` +
        source.slice(b);
  }
  vm.runInNewContext(source + `;${engine === 'neural' ? 'neuralWorker' : 'motionWorker'}();`, {
    self,
    VideoFrame: Frame,
    WebSocket: Socket,
    performance,
    setTimeout,
    clearTimeout,
    Uint8Array,
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
    }
  });
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    }
  });
  await self.onmessage({
    data: {
      type: 'start',
      stream,
      port,
      width: 2,
      height: 2,
      options: {
        maxFps: target,
        interpolation,
        resize,
        upscale: resize,
        upscaleMethod: 'ai',
        outputWidth: resize ? 4 : 2,
        outputHeight: resize ? 4 : 2,
        outputFormat: 'RGBA',
        comparisonInPresenter: true
      }
    }
  });
  await self.onmessage({data: {type: 'cadence', fps: sourceFps}});
  const count = Math.round(sourceFps * 2);
  for (let i = 0; i < count; i++) {
    controller.enqueue(new Frame(
        new Uint8Array(16).fill(i % 256), {timestamp: Math.round(i * 1000000 / sourceFps)}));
    await wait(1);
  }
  controller.close();
  for (let n = 0;
       n < 500 && !messages.some(m => m.type === 'end') && !reports.some(m => m.type === 'error');
       n++)
    await wait(2);
  assert.deepEqual(reports.filter(m => m.type === 'error'), []);
  assert.ok(messages.some(m => m.type === 'end'), 'End-of-stream must drain without hanging');
  if (engine === 'optical') await self.onmessage({data: {type: 'snapshot'}});
  const frames = messages.filter(m => m.type === 'batch').flatMap(m => m.frames);
  const expected = Math.min(count, Math.ceil((count / sourceFps) * target));
  assert.ok(
      Math.abs(frames.length - expected) <= 1,
      `FPS ${sourceFps}→${target}: got ${frames.length}, expected ${
          expected} (plus final endpoint)`);
  assert.equal(
      frames.at(-1).frame.pixels[0], (count - 1) % 256,
      'The exact final source frame survives the cap');
  assert.ok(
      Math.abs(messages.find(m => m.type === 'end').time - count * 1000 / sourceFps) < .01,
      'Duration and audio clock stay at original speed');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    assert.equal(f.generated, false);
    assert.equal(f.time, f.originalTime);
    assert.equal(
        f.original.pixels[0], f.frame.pixels[0], 'Compare uses the matching selected source');
    if (i) assert.ok(f.time > frames[i - 1].time, 'Source timestamps must increase');
    f.frame.close();
    f.original.close();
  }
  if (engine === 'neural') {
    assert.equal(
        requests.length, resize ? frames.length : 0,
        'Only selected frames are sent for resizing; a plain FPS cap makes no frame RPCs');
    assert.equal(
        copies, resize ? frames.length : 0, 'Discarded frames are never copied or converted');
  }
  assert.equal(messages.filter(m => m.type === 'cadence').at(-1).fps, Math.min(sourceFps, target));
  if (sourceFps > target) {
    const stats = reports.filter(m => m.type === 'producer-stats').at(-1);
    assert.equal(stats.rateLimited, true);
    assert.equal(stats.rateSkipped, count - frames.length);
  }
  await self.onmessage({data: {type: 'stop'}});
  assert.ok(
      created.every(f => f.closed),
      'Dropped, tail, comparison and delivery frames are all released');
  console.log(`PASS: ${engine} ${sourceFps}→${target} fps, resize=${resize}, smoothing=${
      interpolation}, ${frames.length}/${count} frames processed`);
}
(async () => {
  for (const [sourceFps, target] of [[60, 30], [60, 24], [60, 15], [59.94, 23.976], [120, 5]])
    for (const interpolation of [false, true]) await exercise({sourceFps, target, interpolation});
  await exercise({sourceFps: 24, target: 60});
  await exercise({resize: false, interpolation: true});
  await exercise({engine: 'optical', resize: false, interpolation: true});
  await exercise(
      {engine: 'optical', sourceFps: 60, target: 24, resize: false, interpolation: true});
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
