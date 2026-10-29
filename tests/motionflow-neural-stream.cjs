// Run the real capture/RPC worker with a silent, deterministic loopback substitute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(
    process.env.MOTIONFLOW_WORKER_SOURCE ||
        path.join(__dirname, '../lib/motionflow/neural-worker.js'),
    'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await wait(5);
  }
  throw new Error('Worker did not finish');
}
async function checkStream(explicitFinish, clockJump = false, slow = false) {
  const created = [], messages = [], errors = [], requests = [], stats = [], notices = [],
        setupStages = [];
  class Frame {
    constructor(input, options = {}) {
      if (input instanceof Frame) assert.ok(!input.closed);
      this.pixels = input instanceof Frame ? input.pixels.slice() : new Uint8Array(input);
      this.timestamp = options.timestamp ?? input.timestamp ?? 0;
      this.displayWidth = this.codedWidth = this.displayHeight = this.codedHeight = 2;
      this.format = 'RGBA';
      this.closed = false;
      created.push(this);
    }
    async copyTo(target) {
      target.set(this.pixels);
    }
    close() {
      assert.ok(!this.closed, 'Each frame closes once');
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
              () => this.onmessage({data: JSON.stringify({type: 'ready', protocol: 1})}));
        if (this.request.type === 'reset')
          queueMicrotask(() => this.onmessage({data: JSON.stringify({type: 'reset'})}));
        return;
      }
      const request = this.request;
      requests.push(request);
      // Simulate bounded animation lookahead awaiting a final restored source.
      const items = request.passthrough || request.time < 70 ?
          [{time: request.time, originalTime: request.time, generated: false}] :
          [];
      const respond = () => {
        this.onmessage({
          data: JSON.stringify({type: 'frames', frames: items, computeMs: 1, workOutputFrames: 1})
        });
        if (!this.noticedWarm && request.time > 0 && request.time < 70 && !request.passthrough) {
          this.noticedWarm = true;
          this.onmessage({data: JSON.stringify({type: 'warming', active: true})});
          this.onmessage({data: JSON.stringify({type: 'warming', active: false})});
        }
        if (items.length) this.onmessage({data: new Uint8Array(value).slice().buffer});
      };
      if (slow)
        setTimeout(respond, 25);
      else
        queueMicrotask(respond);
    }
    close() {
      this.onclose?.();
    }
  }
  const port = {
    postMessage(message) {
      messages.push(message);
    },
    close() {}
  };
  const self = {
    postMessage(message) {
      if (message.type === 'error') errors.push(message);
      if (message.type === 'producer-stats') stats.push(message);
      if (message.type === 'model-preparing') notices.push(message.active);
      if (message.type === 'setup-progress') setupStages.push(message.message);
    }
  };
  vm.runInNewContext(source + ';neuralWorker();', {
    self,
    VideoFrame: Frame,
    WebSocket: Socket,
    performance,
    setTimeout,
    clearTimeout,
    Uint8Array
  });
  let controller;
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
        maxFps: 60,
        outputWidth: 2,
        outputHeight: 2,
        outputFormat: 'RGBA',
        comparisonInPresenter: true
      }
    }
  });
  for (let n = 0; n < (slow ? 12 : 6); n++) {
    const pixels = new Uint8Array(16).fill(n >= 2 ? 99 : 20 + n);
    controller.enqueue(new Frame(pixels, {
      timestamp: Math.round(n * 1000000 / 30) +
          (clockJump === 'backwards' ? (n < 2 ? 90000000 : 0) :
                                       (clockJump && n >= 2 ? 90000000 : 0))
    }));
    await wait(2);
  }
  if (explicitFinish)
    await self.onmessage({data: {type: 'finish'}});
  else
    controller.close();
  await until(() => messages.some(m => m.type === 'end') || errors.length);
  assert.deepEqual(errors, []);
  assert.deepEqual(
      setupStages, ['Connecting to local GPU helper', 'Loading GPU pipeline'],
      'Connection and pipeline setup are reported before frame buffering');
  assert.deepEqual(
      notices, [true, false],
      'Warmup progress must not replace frame metadata or resolve the RPC early');
  if (slow) {
    assert.equal(
        stats.at(-1).skippedSources, 0,
        'The selected buffer absorbs a source burst without dropping adjacent inputs');
    assert.ok(stats.at(-1).captureQueueLimit > 4);
    assert.ok(
        stats.at(-1).maxCaptureGapMs < 34,
        'No interpolation pair skips an adjacent source during the burst');
    assert.ok(
        Math.abs(stats.at(-1).processingMsPerFrame - 1) < .001,
        'Work telemetry uses the matching output count, including empty current batches');
  }
  if (clockJump) {
    assert.ok(
        messages.at(-1).time < 1000,
        'Static/live clock switches must not strand frames in the future');
    assert.equal(stats.at(-1).captureClockResets, 1);
  }
  assert.ok(
      requests.at(-1).passthrough, 'Final held source is restored after outstanding inference');
  const batches = messages.filter(m => m.type === 'batch').flatMap(m => m.frames);
  assert.equal(batches.at(-1).frame.pixels[0], 99, 'The actual final source image survives');
  for (let i = 1; i < batches.length; i++)
    assert.ok(batches[i].time > batches[i - 1].time, 'Final timestamps stay increasing');
  assert.equal(messages.at(-1).type, 'end', 'EOF follows every output frame');
  assert.ok(messages.at(-1).time > batches.at(-1).time, 'Final source-frame duration is retained');
  for (const item of batches) {
    item.frame.close();
    item.original?.close();
  }
  await self.onmessage({data: {type: 'stop'}});
  assert.ok(
      created.every(frame => frame.closed), 'Capture, comparison and output frames are released');
  console.log(
      'PASS: Neural ' + (explicitFinish ? 'finish request' : 'stream EOF') +
      ' drains in-flight work and animation lookahead');
}
(async () => {
  await checkStream(false);
  await checkStream(false, false, true);
  await checkStream(true);
  await checkStream(true, true);
  await checkStream(true, 'backwards');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
