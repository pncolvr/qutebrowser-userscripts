// Exercise the real presenter at several display cadences, without a GPU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/motionflow/presenter.js'), 'utf8');

async function simulate(refresh, target,extra={}) {
  let now = 0, callback = null;
  const delayMs = extra.delayMs??(target === 45 ? 320 : 220);
  const created = [], writes = [], reports = [];
  class Frame {
    constructor(input, options = {}) {
      this.time = input.time;this.codedWidth=input.codedWidth||extra.width||16;this.codedHeight=input.codedHeight||extra.height||16;this.format='I420';
      this.timestamp = options.timestamp;
      this.closed = false;
      created.push(this);
    }
    close() {
      assert.equal(this.closed, false, 'a frame must be closed once');
      this.closed = true;
    }
  }
  const port = {postMessage() {}, close() {}};
  const self = {
    postMessage(message) {
      if (message.type === 'comparison') {
        assert.equal(
            message.time, writes.at(-1)?.time,
            'divider changes only after the matching frame is written');
        assert.ok(
            message.time - message.originalTime >= -.001 &&
                message.time - message.originalTime < 1000 / 30 + .001,
            'original and smoothed timestamps differ by at most one native frame');
      }
      reports.push({...message,wall:now});
    },
    requestAnimationFrame(fn) {
      callback = fn;
      return 1;
    },
    cancelAnimationFrame() {
      callback = null;
    },
  };
  vm.runInNewContext(source + ';presentationWorker();', {
    self,
    VideoFrame: Frame,
    performance: {timeOrigin: 0, now: () => now},
  });
  const writer = {
    async write(frame) {
      writes.push({wall: now, time: frame.time});
    },
    async close() {}
  };
  await self.onmessage({
    data:
        {type: 'start', options: {maxFps: target, delayMs,...extra}, port, output: {getWriter: () => writer}}
  });
  const duration=Math.max(6000,delayMs+5000);
  let nextInput = 1000 / 30 + (extra.inputDelay || 0), nextFrame = 0, endSent = false;
  for (let tick = 0; tick <= refresh * duration/1000; tick++) {
    now = tick * 1000 / refresh;
    while (now >= nextInput && nextInput <= (extra.endAt ?? Infinity) + .001) {
      const frames = [];
      while (nextFrame < (extra.endAt ?? Infinity) - .001 && nextFrame <= nextInput - (extra.inputDelay || 0) + 0.001) {
        frames.push({
          frame: new Frame({time: nextFrame}),
          original: extra.originalWidth ? new Frame({time: nextFrame,codedWidth:extra.originalWidth,codedHeight:extra.originalHeight}) : null,
          time: nextFrame,
          generated: true,
          originalTime: Math.floor((nextFrame + .00001) / (1000 / 30)) * (1000 / 30),
          comparison: nextFrame >= 1500 && nextFrame < 4500,
          split: nextFrame < 3000 ? .5 : .7
        });
        nextFrame += 1000 / target;
      }
      port.onmessage({data: {type: 'batch', frames, clockOrigin: 0}});
      nextInput += 1000 / 30;
    }
    if (extra.endAt && now>=extra.endAt && !endSent) {endSent=true;port.onmessage({data:{type:'end',time:extra.endAt}});}
    const fn = callback;
    callback = null;
    if(!fn&&extra.endAt&&reports.some(r=>r.type==='drained'))continue;
    assert.ok(fn, 'presentation scheduling must remain active');
    await fn(now);
  }
  const errors = reports.filter(r => r.type === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const start=Math.max(1000,(extra.expectedDelay??delayMs)+500);
  const steady = writes.filter(w => w.wall >= start && w.wall < duration);
  if(extra.endAt){
    assert.equal(writes.length,Math.round(extra.endAt*target/1000),'Every final frame must be delivered');
    assert.ok(writes.at(-1).wall>extra.endAt,'Delayed video continues after the source ends');
    assert.ok(writes.every(w=>w.wall-w.time>=delayMs-1),'A short clip still respects the selected delay');
    assert.ok(reports.some(r=>r.type==='drained'&&r.wall>=extra.endAt+delayMs-1),'Drain waits through the final frame duration');
    assert.ok(!reports.some(r=>r.type==='starved'),'A normal ending is not starvation');
  }else{
  const expected = Math.min(refresh, target) * (duration-start)/1000;
  assert.ok(
      Math.abs(steady.length - expected) <= 1,
      `${refresh} Hz delivered ${steady.length}, expected ${expected}`);
  if (refresh >= target) {
    for (let i = 1; i < writes.length; i++) {
      assert.ok(
          Math.abs(writes[i].time - writes[i - 1].time - 1000 / target) < .01,
          `${refresh} Hz repeated or skipped prepared motion`);
    }
    assert.ok(
        steady.every(w => w.wall - w.time >= (extra.expectedDelay??delayMs) - (extra.inputDelay ? 35 : 1) && w.wall - w.time < (extra.expectedDelay??delayMs) + 30),
        'bounded audio/video delay');
    assert.ok(
        reports.filter(r => r.type === 'stats').every(r => r.heldFps === 0),
        'ready frames must not be held');
  }
  assert.ok(
      reports.some(r => r.type === 'comparison' && r.enabled && r.split === .7),
      'presenter acknowledges a dragged split in its queued frame');
  }
  await self.onmessage({data: {type: 'stop'}});
  assert.ok(reports.filter(r=>r.type==='buffer-progress').every(r=>r.bufferBytes<=(extra.maxBufferBytes||512*1024*1024)),'memory budget is enforced');
  assert.ok(created.every(frame => frame.closed), 'stop must close every queued/output frame');
  assert.equal(callback, null, 'stop must cancel presentation callbacks');
  console.log(
      `PASS: ${refresh} Hz display delivers ${steady.length*1000/(duration-start)} fps with bounded frame ownership`);
}
(async () => {
  for (const target of [24,30,45,60])
    for (const refresh of [50, 59.94, 60, 90, 120, 144, 165]) await simulate(refresh, target);
  await simulate(60,60,{delayMs:320,bufferMs:170,inputDelay:500,expectedDelay:670});
  await simulate(60,60,{delayMs:1650,bufferMs:1500,endAt:4000});
  await simulate(60,60,{delayMs:6150,bufferMs:6000,endAt:1000});
  await simulate(144,120);
  await simulate(144,119.88);
  await simulate(60,120);
  await simulate(60,30,{delayMs:1650,bufferMs:1500});
  await simulate(60,60,{delayMs:6150,bufferMs:6000,width:1280,height:720,originalWidth:1920,originalHeight:1080,maxBufferBytes:2*1024*1024*1024});
  await simulate(60,60,{delayMs:1650,bufferMs:1500,width:3840,height:2160,originalWidth:1920,originalHeight:1080,maxBufferBytes:2*1024*1024*1024});
  await simulate(60,60,{delayMs:6150,bufferMs:6000,width:3840,height:2160,originalWidth:1920,originalHeight:1080,maxBufferBytes:2*1024*1024*1024,expectedDelay:2200});
  await simulate(60,60,{delayMs:3150,bufferMs:3000,width:1920,height:1080,maxBufferBytes:1920*1080*1.5*60,expectedDelay:900});
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
