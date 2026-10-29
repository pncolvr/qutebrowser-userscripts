'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'),
      path = require('node:path');
const source = fs.readFileSync(
    process.env.MOTIONFLOW_PRESENTER_SOURCE ||
        path.join(__dirname, '../lib/motionflow/presenter.js'),
    'utf8');
async function simulate(fps, gap = false) {
  let now = 0, raf = null;
  const frames = [], reports = [], writes = [];
  class Frame {
    constructor(input) {
      assert.ok(!input.closed);
      this.time = input.time;
      this.codedWidth = this.codedHeight = 16;
      this.format = 'I420';
      this.closed = false;
      frames.push(this);
    }
    close() {
      assert.equal(this.closed, false);
      this.closed = true;
    }
  }
  const self = {
    postMessage: m => reports.push({...m, wall: now}),
    requestAnimationFrame(fn) {
      raf = fn;
      return 1;
    },
    cancelAnimationFrame() {
      raf = null;
    }
  };
  const port = {postMessage() {}, close() {}};
  vm.runInNewContext(
      source + ';presentationWorker();',
      {self, VideoFrame: Frame, performance: {timeOrigin: 0, now: () => now}});
  await self.onmessage({
    data: {
      type: 'start',
      options: {maxFps: fps, delayMs: 250, bufferMs: 100},
      port,
      output: {
        getWriter: () => ({
          write: async frame => writes.push({time: frame.time, wall: now}),
          close: async () => {}
        })
      }
    }
  });
  const input = [];
  for (let n = 0; n < Math.ceil(10 * fps); n++) {
    // Selected native frames may land slightly after the nominal cap deadline.
    const time = n * 1000 / fps + (fps === 15 && n % 3 === 1 ? 12 : 0);
    if (!gap || time < 3000 || time >= 4300) input.push(time);
  }
  let next = 0;
  for (let tick = 0; tick < 60 * 8; tick++) {
    now = tick * 1000 / 60;
    while (next < input.length && input[next] + 20 <= now) {
      const time = input[next++];
      port.onmessage({
        data: {
          type: 'batch',
          clockOrigin: 0,
          frames: [{frame: new Frame({time}), time, originalTime: time, generated: false}]
        }
      });
    }
    const paint = raf;
    raf = null;
    assert.ok(paint, 'Display scheduling must stay active');
    await paint(now);
  }
  assert.deepEqual(reports.filter(r => r.type === 'error'), []);
  const steady = writes.filter(w => w.wall >= 2000 && w.wall < 8000);
  if (gap) {
    assert.ok(
        reports.some(r => r.type === 'stats' && r.heldFps > 0),
        'A real empty-queue underrun must still count missed frames');
    assert.ok(
        reports.some(r => r.type === 'starved'),
        'A genuine delivery gap still triggers starvation');
  } else {
    assert.ok(
        reports.filter(r => r.type === 'stats').every(r => r.heldFps === 0),
        'Planned low-FPS holds and future queued timestamps are not missed frames');
    assert.ok(
        !reports.some(r => r.type === 'starved'),
        'Expected low-FPS input intervals must not trigger starvation');
    assert.ok(
        Math.abs(steady.length - fps * 6) <= 1,
        `Selected ${fps} fps delivered ${steady.length}/6 fps`);
  }
  await self.onmessage({data: {type: 'stop'}});
  assert.ok(frames.every(f => f.closed), 'All frames are released');
  console.log(`PASS: ${fps} fps, genuine gap=${gap}, ${
      steady.length} steady frames, holds reflect missed frames only`);
}
(async () => {
  await simulate(15);
  await simulate(1);
  await simulate(15, true);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
