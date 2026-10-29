// Presentation is deliberately isolated from GPU uploads and motion estimation.
function presentationWorker() {
  let active = false, writer = null, port = null, raf = 0, options = null, clockOrigin = null,
      native = false;
  let queue = [], showing = false, nextWrite = null, offset = null, lastInput = 0;
  let draws = 0, generated = 0, held = 0, dropped = 0, lastReport = 0, drawTimes = [],
      actualDelayMs = 0, lastStats = {}, lastComparison = null, lastSplit = .5, presentedTime = 0,
      originalTime = 0, writerMs = 0;
  let bufferBytes = 0, effectiveDelayMs = 0, targetFps = 60, frameBytes = 4, lastProgress = 0,
      previewed = false;
  let cached = null, canvas = null, context = null, paused = false, playoutOffset = 0;
  let comparisonDirty = false, lastComparisonRevision = null;
  let finishing = false, inputEnded = false, drained = false, endTime = 0, lastWriteWall = 0;
  const memoryLimit = () => options.maxBufferBytes || 512 * 1024 * 1024;
  const bufferGoal = () => Math.min(
      options.bufferMs ?? Math.max(50, options.delayMs - 150),
      Math.max(50, effectiveDelayMs - 100));
  const prepared = () => queue.length ? queue.at(-1).time - queue[0].time + 1000 / targetFps : 0;
  const release = item => {
    bufferBytes -= item.bytes;
    item.frame.close();
    item.original?.close();
  };
  function forgetCached() {
    cached?.frame.close();
    cached?.original?.close();
    cached = null;
  }
  function comparisonState(item) {
    return {
      enabled: options.comparisonInPresenter ? !!options.comparison && !!item.original :
                                               !!item.comparison,
      split: options.comparisonInPresenter ? options.split ?? .5 : item.split ?? .5,
      revision: options.comparisonRevision ?? 0
    };
  }
  function acknowledge(item, state) {
    if (lastComparison !== state.enabled || lastSplit !== state.split ||
        lastComparisonRevision !== state.revision) {
      lastComparison = state.enabled;
      lastSplit = state.split;
      lastComparisonRevision = state.revision;
      self.postMessage({
        type: 'comparison',
        ...state,
        time: item.time,
        originalTime: item.originalTime ?? item.time
      });
    }
  }
  function compose(item, wall, state = comparisonState(item)) {
    if (!options.comparisonInPresenter || !state.enabled)
      return new VideoFrame(item.frame, {timestamp: Math.round(wall * 1000)});
    const width = item.frame.displayWidth || item.frame.codedWidth;
    const height = item.frame.displayHeight || item.frame.codedHeight;
    canvas ||= new OffscreenCanvas(width, height);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context ||= canvas.getContext('2d', {alpha: false});
    context.drawImage(item.frame, 0, 0, width, height);
    context.save();
    context.beginPath();
    context.rect(0, 0, Math.round(width * state.split), height);
    context.clip();
    // Native browser scaling is the baseline; no AI or shared upscale filter.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'low';
    context.drawImage(item.original, 0, 0, width, height);
    context.restore();
    return new VideoFrame(canvas, {timestamp: Math.round(wall * 1000)});
  }
  function progress() {
    const bufferedMs = prepared();
    self.postMessage({
      type: 'buffer-progress',
      buffered: queue.length,
      bufferedMs,
      presentedTimeMs: presentedTime,
      targetBufferMs: bufferGoal(),
      bufferBytes,
      native,
      delayMs: effectiveDelayMs
    });
    lastProgress = performance.now();
  }
  const drain = () => {
    for (const item of queue) release(item);
    queue = [];
    previewed = false;
  };
  function report(id) {
    const now = performance.now();
    if (!id) {
      const span = Math.max(1, now - lastReport),
            steps = drawTimes.slice(1).map((t, i) => t - drawTimes[i]).sort((a, b) => a - b);
      lastStats = {
        state: native ? 'native' :
            showing   ? 'running' :
                        'buffering',
        native,
        drawFps: draws * 1000 / span,
        generatedFps: generated * 1000 / span,
        heldFps: held * 1000 / span,
        droppedFps: dropped * 1000 / span,
        frameStepP95: steps.length ? steps[Math.floor((steps.length - 1) * .95)] : 0,
        buffered: queue.length,
        delayMs: effectiveDelayMs,
        bufferedMs: prepared(),
        targetBufferMs: bufferGoal(),
        bufferBytes,
        actualDelayMs,
        worker: true,
        output: 'native video track',
        writerMs,
        comparison: !!lastComparison,
        comparisonSplit: lastSplit,
        presentedTimeMs: presentedTime,
        comparisonSourceTimeMs: originalTime,
        comparisonOriginalAgeMs: presentedTime - originalTime
      };
      draws = generated = held = dropped = 0;
      drawTimes = [];
      lastReport = now;
    }
    self.postMessage({type: 'stats', ...lastStats, ...(id ? {requestId: id} : {})});
  }
  async function paint(timestamp) {
    if (!active || paused) return;
    try {
      const now = performance.now(), observed = now - timestamp;
      if (offset === null || !showing)
        offset = offset === null ? observed : Math.min(offset, observed);
      const wall = timestamp + offset, absolute = performance.timeOrigin + wall;
      let wroteFrame = false;
      if (!native && clockOrigin !== null && (nextWrite === null || wall >= nextWrite - 1)) {
        let target = absolute - clockOrigin - effectiveDelayMs - playoutOffset;
        if (!showing && queue.length && (inputEnded || prepared() >= bufferGoal() - 1) &&
            target > queue[0].time) {
          // Inference latency may exceed the chosen buffer. Schedule the ready
          // frames without changing their capture clock or hiding audio delay.
          playoutOffset += target - queue[0].time;
          target = queue[0].time;
        }
        // Consume one prepared frame per display tick. Correct only material drift;
        // reselecting by a rounded clock every tick introduces cadence judder.
        while (showing && queue.length > 1 && queue[1].time < target - 65) {
          release(queue.shift());
          dropped++;
        }
        if (!showing && !previewed && queue.length && options.previewBuffer) {
          const preview = compose(queue[0], wall);
          try {
            await writer.write(preview);
          } finally {
            preview.close();
          }
          previewed = true;
          self.postMessage({type: 'preview'});
        }
        if (queue.length && queue[0].time <= target + 1 &&
            (showing || inputEnded || prepared() >= bufferGoal() - 1)) {
          const item = queue.shift();
          const renderedComparison = comparisonState(item);
          const frame = compose(item, wall, renderedComparison);
          comparisonDirty = false;
          wroteFrame = true;
          if (options.comparisonInPresenter) {
            forgetCached();
            cached = {
              frame: new VideoFrame(item.frame),
              original: item.original ? new VideoFrame(item.original) : null,
              time: item.time,
              originalTime: item.originalTime
            };
          }
          release(item);
          try {
            const writeBegan = performance.now();
            await writer.write(frame);
            writerMs = performance.now() - writeBegan;
          } finally {
            frame.close();
          }
          if (!active) return;
          const interval = 1000 / targetFps;
          nextWrite = nextWrite === null || wall - nextWrite > interval * 2 ? wall + interval :
                                                                              nextWrite + interval;
          lastWriteWall = wall;
          presentedTime = item.time;
          originalTime = item.originalTime ?? item.time;
          acknowledge(item, renderedComparison);
          draws++;
          if (item.generated) generated++;
          drawTimes.push(wall);
          const delay = absolute - clockOrigin - item.time;
          actualDelayMs = actualDelayMs ? actualDelayMs * .95 + delay * .05 : delay;
          if (!showing) {
            showing = true;
            port.postMessage({type: 'playout-started'});
            self.postMessage({type: 'presenting', delayMs: actualDelayMs});
          }
        } else if (showing && !inputEnded && !queue.length) {
          const interval = 1000 / targetFps;
          // A queued future timestamp, or a normal low-FPS interval, is not a miss.
          if (target - presentedTime > interval + Math.min(25, interval / 2)) {
            held++;
            nextWrite = wall + interval;
          }
        }
      }
      // A toggle also redraws a held/last frame; it does not wait for fresh inference.
      if (comparisonDirty && cached && showing && !wroteFrame && !paused) {
        const item = cached;
        const renderedComparison = comparisonState(item);
        const frame = compose(item, wall, renderedComparison);
        comparisonDirty = false;
        try {
          await writer.write(frame);
        } finally {
          frame.close();
        }
        if (!active) return;
        acknowledge(item, renderedComparison);
      }
      if (showing && !finishing && !queue.length &&
          now - lastInput > Math.max(700, 2 * 1000 / targetFps)) {
        showing = false;
        self.postMessage({type: 'starved'});
      }
      const endWall = clockOrigin === null ?
          0 :
          clockOrigin - performance.timeOrigin + endTime + effectiveDelayMs + playoutOffset;
      if (inputEnded && !queue.length && !drained &&
          wall >= Math.max(lastWriteWall + 1000 / targetFps, endWall)) {
        drained = true;
        self.postMessage({type: 'drained', time: presentedTime});
      }
      if (now - lastProgress >= 100) progress();
      if (now - lastReport >= 1000) report();
    } catch (error) {
      if (active) self.postMessage({type: 'error', message: String(error), stack: error.stack});
    } finally {
      if (active && !paused && !drained) raf = self.requestAnimationFrame(paint);
    }
  }
  self.onmessage = async ({data}) => {
    try {
      if (data.type === 'start') {
        options = data.options;
        targetFps = options.maxFps;
        effectiveDelayMs = options.delayMs;
        writer = data.output.getWriter();
        port = data.port;
        active = true;
        lastReport = performance.now();
        lastInput = lastReport;
        port.onmessage = ({data: message}) => {
          if (!active) {
            for (const item of message.frames || []) {
              item.frame.close();
              item.original?.close();
            }
            return;
          }
          if (message.type === 'batch') {
            lastInput = performance.now();
            native = false;
            if (clockOrigin === null || !showing) clockOrigin = message.clockOrigin;
            for (const item of message.frames) {
              const f = item.frame, w = f.codedWidth || 1, h = f.codedHeight || 1;
              item.bytes =
                  (f.format === 'I420' || f.format === 'NV12' ?
                       w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2) :
                       w * h * 4);
              if (item.original) {
                const o = item.original, ow = o.codedWidth, oh = o.codedHeight;
                item.bytes += o.format === 'I420' || o.format === 'NV12' ?
                    ow * oh + 2 * Math.ceil(ow / 2) * Math.ceil(oh / 2) :
                    ow * oh * 4;
              }
              frameBytes = Math.max(frameBytes, item.bytes);
              bufferBytes += item.bytes;
              queue.push(item);
            }
            const slots = Math.max(2, Math.floor(memoryLimit() / frameBytes));
            effectiveDelayMs =
                Math.min(options.delayMs, Math.max(100, (slots - 6) * 1000 / targetFps));
            const maximum = Math.max(2, Math.ceil((effectiveDelayMs + 150) * targetFps / 1000) + 2);
            while (queue.length > maximum || bufferBytes > memoryLimit()) {
              release(queue.shift());
              dropped++;
            }

          } else if (message.type === 'end') {
            finishing = inputEnded = true;
            endTime = message.time || 0;
          } else if (message.type === 'cadence') {
            targetFps = Math.max(1, Math.min(240, message.fps));
          } else if (message.type === 'native' || message.type === 'reset') {
            drain();
            forgetCached();
            clockOrigin = null;
            playoutOffset = 0;
            finishing = inputEnded = drained = false;
            showing = false;
            nextWrite = null;
            lastComparison = null;
            native = message.type === 'native';
            self.postMessage({type: native ? 'native' : 'starved'});
          }
        };
        self.postMessage({type: 'ready'});
        raf = self.requestAnimationFrame(paint);
      } else if (data.type === 'comparison') {
        options.comparison = !!data.enabled;
        options.split = data.split;
        options.comparisonRevision = data.revision ?? options.comparisonRevision ?? 0;
        comparisonDirty = true;
        if (drained && cached && !paused) {
          self.cancelAnimationFrame(raf);
          raf = self.requestAnimationFrame(paint);
        }
      } else if (data.type === 'finishing') {
        finishing = true;
      } else if (data.type === 'pause') {
        paused = true;
        self.cancelAnimationFrame(raf);
        const frame = cached ? new VideoFrame(cached.frame) : null;
        const original = cached?.original ? new VideoFrame(cached.original) : null;
        self.postMessage(
            {
              type: 'paused-frame',
              frame,
              original,
              time: cached?.time,
              originalTime: cached?.originalTime
            },
            [frame, original].filter(Boolean));
        drain();
        forgetCached();
      } else if (data.type === 'snapshot')
        report(data.id);
      else if (data.type === 'stop') {
        active = false;
        self.cancelAnimationFrame(raf);
        drain();
        forgetCached();
        port?.close();
        try {
          await writer?.close();
        } catch {
        }
      }
    } catch (error) {
      self.postMessage({type: 'error', message: String(error), stack: error.stack});
    }
  };
  self.postMessage({type: 'boot', workerRaf: typeof self.requestAnimationFrame === 'function'});
}
