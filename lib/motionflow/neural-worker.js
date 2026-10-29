// Native inference stays off the page and presenter threads. Frames travel only
// over loopback; the standalone helper runs RIFE on the local RTX GPU.
function neuralWorker() {
  'use strict';
  let active = false, reader = null, socket = null, port = null, options = null;
  let width = 0, height = 0, firstTimestamp = null, lastTime = null, offset = null, started = false;
  let decodedFps = 0, periods = [], offsets = [], native = false, lastReport = 0, sequence = 0;
  let captureMs = 0, roundTripMs = 0, frameMs = 0;
  let deliveredWindow = 0, deliveryReportAt = performance.now(), deliveredFps = 0;
  let processingMsPerFrame = 0, restorationCacheHits = 0, captureQueueLimit = 4, captureQueued = 0,
      maxCaptureGapMs = 0;
  let sourceFormat = '', sourceOnly = false, captureLimited = false, captureClockResets = 0,
      pixelBackend = '', conversionMs = 0;
  let upscalerName = null, upscaleStrength = 0, lastOutputTime = null;
  const originals = [];
  function clearOriginals() {
    while (originals.length) originals.shift().frame.close();
  }
  let processedPeriods = [], processedFrames = 0, skippedSources = 0;
  let rateLimited = false, rateSkipped = 0, outputFps = 0, deliveredWidth = 0, deliveredHeight = 0;
  let framesReceived = 0, computeMs = 0, drawingFps = 0, pending = [], canvas = null,
      context = null;
  const failure =
      'Local helper unavailable, busy, or browser not paired. Run >gr after starting motionflow-helper, or turn AI off.';
  function report() {
    const elapsed = performance.now() - deliveryReportAt;
    deliveredFps = elapsed > 0 ? deliveredWindow * 1000 / elapsed : 0;
    deliveredWindow = 0;
    deliveryReportAt = performance.now();
    const sorted = [...periods].sort((a, b) => a - b);
    const captureFps = sorted.length ? 1000 / sorted[Math.floor(sorted.length / 2)] : 0;
    self.postMessage({
      type: 'producer-stats',
      sourceFps: decodedFps || captureFps,
      captureFps,
      sourceFormat,
      framesReceived,
      processedFrames,
      skippedSources,
      inferenceFps: processedPeriods.length ?
          1000 * processedPeriods.length / processedPeriods.reduce((a, b) => a + b, 0) :
          0,
      computeMs,
      conversionMs,
      pixelBackend,
      captureMs,
      rateLimited,
      rateSkipped,
      outputFps,
      processingMsPerFrame,
      deliveredFps,
      restorationCacheHits,
      captureQueueLimit,
      captureQueued,
      maxCaptureGapMs,
      roundTripMs,
      frameMs,
      generationMs: computeMs,
      drawingFps,
      width: deliveredWidth || options.outputWidth,
      height: deliveredHeight || options.outputHeight,
      processingWidth: sourceOnly && !options.resize ? deliveredWidth || width : width,
      processingHeight: sourceOnly && !options.resize ? deliveredHeight || height : height,
      passthrough: !!sourceOnly,
      captureLimited,
      captureClockResets,
      upscaler: upscalerName,
      upscaleStrength,
      renderer: 'RIFE 4.25 · TensorRT-RTX · local GPU',
      engine: 'neural',
      content: options.content
    });
    lastReport = performance.now();
  }
  function rejectRequests(error) {
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending = [];
  }
  function rpc(message, pixels, onFrame) {
    return new Promise((resolve, reject) => {
      const request = {resolve, reject, metadata: null, received: 0, onFrame};
      request.timer = setTimeout(() => {
        rejectRequests(new Error('AI helper timed out'));
        socket?.close();
      }, message.protocol === 1 ? 180000 : 10000);
      pending.push(request);
      try {
        socket.send(JSON.stringify(message));
        if (pixels) socket.send(pixels);
      } catch (error) {
        rejectRequests(error);
      }
    });
  }
  async function connect() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const address = options.helperUrl || 'ws://127.0.0.1:8768/v1';
      self.postMessage({type: 'setup-progress', message: 'Connecting to local GPU helper'});
      socket = new WebSocket(
          address + (address.includes('?') ? '&' : '?') + 'wait=1',
          options.authToken ? ['motionflow-v1', 'auth.' + options.authToken] : []);
      socket.binaryType = 'arraybuffer';
      try {
        const connecting = socket;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            connecting.close();
            reject(new Error(failure));
          }, 180000);
          connecting.onopen = () => {
            clearTimeout(timer);
            self.postMessage({type: 'setup-progress', message: 'Loading GPU pipeline'});
            resolve();
          };
          connecting.onerror = () => {
            clearTimeout(timer);
            reject(new Error(failure));
          };
        });
        break;
      } catch (error) {
        socket.close();
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    socket.onmessage = ({data}) => {
      const request = pending[0];
      if (!request) return;
      try {
        if (typeof data === 'string') {
          const metadata = JSON.parse(data);
          if (metadata.type === 'warming') {
            clearTimeout(request.timer);
            request.timer = setTimeout(() => {
              rejectRequests(new Error('GPU model preparation timed out'));
              socket?.close();
            }, metadata.active ? 180000 : 10000);
            self.postMessage({type: 'model-preparing', active: !!metadata.active});
            return;
          }
          if (metadata.type === 'error') throw new Error(metadata.message);
          request.metadata = metadata;
        } else {
          if (!request.metadata || data.byteLength !== outputSize())
            throw new Error('Invalid AI frame');
          const index = request.received++;
          if (index >= request.metadata.frames.length) throw new Error('Unexpected AI frame');
          request.onFrame?.(data, request.metadata.frames[index], request.metadata);
        }
        if (request.metadata && request.received === (request.metadata.frames?.length || 0)) {
          pending.shift();
          clearTimeout(request.timer);
          request.resolve({metadata: request.metadata});
        }
      } catch (error) {
        rejectRequests(error);
        socket?.close();
      }
    };
    socket.onclose = () => {
      if (pending.length)
        rejectRequests(new Error(failure));
      else if (active)
        self.postMessage(
            {type: 'error', message: 'AI helper disconnected; original playback restored.'});
    };
    const ready = await rpc({
      protocol: 1,
      progress: true,
      width,
      height,
      fps: options.maxFps,
      content: options.content,

      upscale: !!options.upscale,
      upscaleMethod: options.upscaleMethod || 'lanczos',
      outputWidth: options.outputWidth,
      outputHeight: options.outputHeight,
      outputFormat: options.outputFormat || 'I420'
    });
    pixelBackend = ready.metadata.pixelBackend || 'CPU';
    upscalerName = ready.metadata.upscaler;
    upscaleStrength = ready.metadata.upscaleStrength;
    if (ready.metadata.type !== 'ready' || ready.metadata.protocol !== 1)
      throw new Error('Incompatible AI helper');
    if (options.upscale && ready.metadata.upscaleMethod !== (options.upscaleMethod || 'lanczos'))
      throw new Error('Helper needs an update for this upscaler; run >gr to restart it.');
  }
  const outputSize = () => options.outputFormat === 'RGBA' ?
      options.outputWidth * options.outputHeight * 4 :
      options.outputWidth * options.outputHeight +
          2 * Math.ceil(options.outputWidth / 2) * Math.ceil(options.outputHeight / 2);
  async function rgba(frame) {
    const bytes = new Uint8Array(width * height * 4);
    if (frame.displayWidth === width && frame.displayHeight === height) {
      try {
        await frame.copyTo(bytes, {format: 'RGBA'});
        return bytes;
      } catch {
      }
    }
    canvas ||= new OffscreenCanvas(width, height);
    context ||= canvas.getContext('2d', {alpha: false, willReadFrequently: false});
    context.drawImage(frame, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  }
  async function inputFrame(frame) {
    const matrix = frame.colorSpace?.matrix, format = frame.format;
    if (frame.displayWidth === width && frame.displayHeight === height &&
        frame.visibleRect?.width === width && frame.visibleRect?.height === height &&
        ['I420', 'NV12'].includes(format) && ['bt709', 'smpte170m', 'bt470bg'].includes(matrix)) {
      const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
      const pixels = new Uint8Array(width * height + 2 * cw * ch);
      const layout = format === 'I420' ?
          [
            {offset: 0, stride: width}, {offset: width * height, stride: cw},
            {offset: width * height + cw * ch, stride: cw}
          ] :
          [{offset: 0, stride: width}, {offset: width * height, stride: 2 * cw}];
      await frame.copyTo(pixels, {layout});
      return {pixels, format, matrix, full: !!frame.colorSpace.fullRange};
    }
    return {pixels: await rgba(frame), format: 'RGBA'};
  }
  function deliver(bytes, item, clockOrigin, comparison = false, split = .5) {
    if (!active) return;
    const uploadBegan = performance.now();
    const output = new VideoFrame(bytes, {
      format: options.outputFormat,
      colorSpace: options.outputFormat === 'I420' ?
          {matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false} :
          undefined,
      codedWidth: options.outputWidth,
      codedHeight: options.outputHeight,
      timestamp: Math.round(item.time * 1000)
    });
    frameMs += performance.now() - uploadBegan;
    deliverFrame(output, item, clockOrigin, comparison, split);
  }
  function deliverFrame(output, item, clockOrigin, comparison = false, split = .5) {
    deliveredWidth = output.displayWidth;
    deliveredHeight = output.displayHeight;
    const source =
        [...originals].reverse().find(source => source.time <= item.originalTime + .001) ||
        originals[0];
    const original = source ? new VideoFrame(source.frame) : null;
    lastOutputTime = item.time;
    deliveredWindow++;
    const frame = {
      original,
      frame: output,
      time: item.time,
      originalTime: source?.time ?? item.originalTime,
      generated: item.generated,
      comparison,
      split
    };
    try {
      port.postMessage(
          {type: 'batch', clockOrigin, frames: [frame]}, [output, original].filter(Boolean));
    } catch (error) {
      output.close();
      original?.close();
      throw error;
    }
  }
  async function consume(stream) {
    reader = stream.getReader();
    const queue = [];
    let queuedBytes = 0;
    const queueBudget = Math.max(
        8 * 1048576, Math.min(256 * 1048576, (options.maxBufferBytes || 512 * 1048576) / 8));
    function pendingSize(frame, input, bypass) {
      const w = frame.codedWidth || frame.displayWidth,
            h = frame.codedHeight || frame.displayHeight;
      const originalBytes = options.comparisonInPresenter && !bypass ?
          (['I420', 'NV12'].includes(frame.format) ?
               w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2) :
               w * h * 4) :
          0;
      return (input.pixels?.byteLength || (input.direct ? originalBytes || w * h * 4 : 0)) +
          originalBytes;
    }
    let wake = null, ended = false, captureError = null, lastArrival = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    let nextCaptureTime = null, tail = null;
    async function enqueueFrame(frame, time, arrival, enough, bypass, source) {
      const scale = Math.min(
          1, options.outputWidth / frame.displayWidth, options.outputHeight / frame.displayHeight,
          1920 / frame.displayWidth, 1080 / frame.displayHeight);
      if ((options.resize || !enough) &&
          (Math.max(2, Math.round(frame.displayWidth * scale)) !== width ||
           Math.max(2, Math.round(frame.displayHeight * scale)) !== height))
        throw new Error('Source dimensions changed; toggle smoothing to reconnect the AI helper.');
      const began = performance.now();
      const direct = enough && !options.resize && !bypass;
      const input = bypass ? {} :
          direct           ? {direct: new VideoFrame(frame)} :
                             await inputFrame(frame);
      sourceFormat = input.format || sourceFormat;
      captureMs = performance.now() - began;
      if (!active) {
        input.direct?.close();
        return;
      }
      const bytes = pendingSize(frame, input, bypass);
      const goal =
          Math.ceil(
              Math.max(400, options.bufferMs ?? (options.delayMs ?? 220) - 150) *
              (enough ? Math.min(source || options.maxFps, options.maxFps) : source || 30) / 1000) +
          2;
      captureQueueLimit =
          Math.max(1, Math.min(180, goal, Math.floor(queueBudget / Math.max(1, bytes))));
      while (queue.length &&
             (queue.length >= captureQueueLimit || queuedBytes + bytes > queueBudget)) {
        const dropped = queue.shift();
        queuedBytes -= dropped.bytes;
        dropped.original?.close();
        dropped.direct?.close();
        skippedSources++;
      }
      const original = options.comparisonInPresenter && !bypass ? new VideoFrame(frame) : null;
      queue.push({time, arrival, ...input, enough, bypass, source, original, bytes});
      queuedBytes += bytes;
      captureQueued = queue.length;
      notify();
    }
    // Capture ahead while inference/delivery is awaiting I/O. Bounded prepared
    // inputs bound memory and latency; stale queued inputs yield to fresh ones.
    const capture = (async () => {
      try {
        while (active) {
          const {value: frame, done} = await reader.read();
          if (done) break;
          try {
            const arrival = performance.now();
            if (firstTimestamp === null) firstTimestamp = frame.timestamp;
            let time = (frame.timestamp - firstTimestamp) / 1000;
            const elapsed = lastArrival === null ? 0 : arrival - lastArrival;
            if (lastTime !== null &&
                (time - lastTime < -50 || time - lastTime > Math.max(1000, elapsed + 500))) {
              // Paused capture may switch from a static timestamp to a live clock.
              time = lastTime + Math.max(1, elapsed);
              firstTimestamp = frame.timestamp - time * 1000;
              captureClockResets++;
            }
            if (lastTime !== null && time <= lastTime) continue;
            lastArrival = arrival;
            if (lastTime !== null) {
              periods.push(time - lastTime);
              if (periods.length > 45) periods.shift();
            }
            lastTime = time;
            framesReceived++;
            const sorted = [...periods].sort((a, b) => a - b);
            const source =
                decodedFps || (sorted.length ? 1000 / sorted[Math.floor(sorted.length / 2)] : 0);
            const enough = options.interpolation === false ||
                source >= options.maxFps * .98;
            const captured = sorted.length ? 1000 / sorted[Math.floor(sorted.length / 2)] : source;
            captureLimited = enough && periods.length >= 12 && captured < source * .85;
            rateLimited = source > options.maxFps / .98;
            const bypass = enough && !options.resize && !rateLimited;
            if (enough && !bypass) {
              const step = 1000 / options.maxFps;
              if (nextCaptureTime !== null && time < nextCaptureTime - .001) {
                rateSkipped++;
                tail?.frame.close();
                tail = {frame: new VideoFrame(frame), time, arrival, enough, bypass, source};
                continue;
              }
              nextCaptureTime = (Math.floor((time + .001) / step) + 1) * step;
            } else
              nextCaptureTime = null;
            tail?.frame.close();
            tail = null;
            await enqueueFrame(frame, time, arrival, enough, bypass, source);
          } finally {
            frame.close();
          }
        }
      } catch (error) {
        captureError = error;
      } finally {
        if (tail) {
          try {
            if (active && !captureError) {
              await enqueueFrame(
                  tail.frame, tail.time, tail.arrival, tail.enough, tail.bypass, tail.source);
              rateSkipped--;
            }
          } catch (error) {
            captureError = error;
          } finally {
            tail.frame.close();
            tail = null;
          }
        }
        ended = true;
        notify();
      }
    })();
    try {
      let lastSent = null, inferenceError = null, outputCadence = 0, lastInput = null;
      const inflight = new Set();
      const drain = () => Promise.all(inflight);
      while (active) {
        if (inferenceError) throw inferenceError;
        if (!queue.length) {
          if (ended) break;
          await new Promise(resolve => wake = resolve);
          continue;
        }
        if (inferenceError) throw inferenceError;
        const {
          time,
          arrival,
          pixels,
          direct,
          format,
          matrix,
          full,
          enough,
          bypass,
          source,
          original,
          bytes
        } = queue.shift();
        queuedBytes -= bytes;
        captureQueued = queue.length;
        if (original) {
          originals.push({time, frame: original});
          if (originals.length > 24) originals.shift().frame.close();
        }
        if (captureError) throw captureError;
        if (bypass !== native || enough !== sourceOnly) {
          native = bypass;
          sourceOnly = enough;
          await drain();
          await rpc({type: 'reset'});
          port.postMessage({type: native ? 'native' : 'reset'});
        }
        // Resizing without interpolation keeps slower sources and caps faster ones.
        const cadence = enough && source > 0 ? Math.min(source, options.maxFps) : options.maxFps;
        outputFps = cadence;
        if (Math.abs(cadence - outputCadence) > .5) {
          outputCadence = cadence;
          port.postMessage({type: 'cadence', fps: cadence});
        }
        if (native) {
          if (arrival - lastReport > 1000) report();
          continue;
        }
        if (direct) {
          if (offset === null) offset = arrival - time;
          deliverFrame(
              direct, {time, originalTime: time, generated: false},
              performance.timeOrigin + offset);
          if (performance.now() - lastReport >= 1000) report();
          continue;
        }
        lastInput = {time, pixels, format, matrix, full};
        const gap = lastSent === null ? 0 : time - lastSent;
        maxCaptureGapMs = Math.max(maxCaptureGapMs, gap);
        if (lastSent !== null) {
          processedPeriods.push(gap);
          if (processedPeriods.length > 45) processedPeriods.shift();
        }
        lastSent = time;
        processedFrames++;
        if (gap > 350 && !enough) {
          await drain();
          await rpc({type: 'reset'});
          // A slow AI interval gets one restored source frame, rather than
          // repeatedly draining presentation or warping across a huge gap.
        }
        offsets.push(arrival - time);
        if (offsets.length > 60) offsets.shift();
        const best = Math.min(...offsets);
        if (offset === null || !started)
          offset = best;
        else
          offset += Math.max(-.05, Math.min(.05, best - offset));
        const rpcStart = performance.now();
        const comparison = !options.comparisonInPresenter && !!options.comparison,
              split = options.split;
        frameMs = 0;
        const clockOrigin = performance.timeOrigin + offset;
        const task = rpc({
                       type: 'frame',
                       id: ++sequence,
                       time,
                       comparison,
                       split,
                       pixelFormat: format,
                       matrix,
                       full,
                       passthrough: enough || gap > 350
                     },
                         pixels,
                         (bytes, item) => {
                           deliver(bytes, item, clockOrigin, comparison, split);
                         })
                         .then(result => {
                           roundTripMs = performance.now() - rpcStart;
                           computeMs = result.metadata.computeMs;
                           conversionMs = result.metadata.conversionMs || 0;
                           restorationCacheHits = result.metadata.restorationCacheHits || 0;
                           const count = result.metadata.workOutputFrames;
                           if (count > 0) {
                             const measured =
                                 (result.metadata.processingMs ?? computeMs + conversionMs) / count;
                             processingMsPerFrame = processingMsPerFrame ?
                                 processingMsPerFrame * .7 + measured * .3 :
                                 measured;
                           }
                           drawingFps = result.metadata.drawingFps;
                         })
                         .catch(error => {
                           inferenceError = error;
                           notify();
                         })
                         .finally(() => inflight.delete(task));
        inflight.add(task);
        if (inflight.size >= 2) await Promise.race(inflight);
        if (performance.now() - lastReport >= 1000) report();
      }
      await drain();
      if (inferenceError) throw inferenceError;
      if (captureError) throw captureError;
      if (active && !native && lastInput &&
          (lastOutputTime === null || lastOutputTime < lastInput.time - .001)) {
        // Finish animation lookahead and preserve the exact final source image.
        const clockOrigin = performance.timeOrigin + offset;
        await rpc(
            {
              type: 'frame',
              id: ++sequence,
              time: lastInput.time,
              passthrough: true,
              pixelFormat: lastInput.format,
              matrix: lastInput.matrix,
              full: lastInput.full
            },
            lastInput.pixels, (bytes, item) => {
              const step = 1000 / options.maxFps;
              for (let t = lastOutputTime === null ?
                       item.time :
                       Math.max(lastOutputTime + step, item.time - 24 * step);
                   t < item.time - .001; t += step)
                deliver(bytes, {...item, time: t, originalTime: t}, clockOrigin);
              deliver(bytes, item, clockOrigin);
            });
      }
      if (active) {
        const rate = decodedFps || (periods.length ? 1000 / periods.at(-1) : options.maxFps);
        report();
        port.postMessage({type: 'end', time: (lastTime || 0) + 1000 / rate});
      }
    } catch (error) {
      if (active) self.postMessage({type: 'error', message: String(error), stack: error.stack});
    } finally {
      await reader.cancel().catch(() => {});
      await capture;
      for (const item of queue) {
        item.original?.close();
        item.direct?.close();
      }
      clearOriginals();
    }
  }
  self.onmessage = async ({data}) => {
    try {
      if (data.type === 'start') {
        options = {
          outputFormat: 'I420',
          content: 'general',
          comparison: false,
          split: .5,
          ...data.options
        };
        width = data.width;
        height = data.height;
        port = data.port;
        active = true;
        port.onmessage = ({data: message}) => {
          if (message.type === 'playout-started') started = true;
        };
        await connect();
        if (!active) return;
        self.postMessage({type: 'ready'});
        lastReport = performance.now();
        report();
        consume(data.stream);
      } else if (data.type === 'comparison') {
        if (options) {
          options.comparison = !!data.enabled;
          if (Number.isFinite(data.split)) options.split = Math.max(.02, Math.min(.98, data.split));
        }
      } else if (data.type === 'cadence') {
        if (Number.isFinite(data.fps) && data.fps > 0) decodedFps = data.fps;
      } else if (data.type === 'finish') {
        await reader?.cancel();
      } else if (data.type === 'stop') {
        active = false;
        socket?.close();
        clearOriginals();
        await reader?.cancel();
        port?.close();
        rejectRequests(new Error('Session closed'));
      }
    } catch (error) {
      if (active) self.postMessage({type: 'error', message: String(error), stack: error.stack});
    }
  };
  self.postMessage({type: 'boot'});
}
