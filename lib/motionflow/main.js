const browser = document.defaultView;
if (browser.location.pathname === '/robots.txt') return;
const VERSION = '3.2.1';
const BASE_OPTIONS = Object.freeze({analysisWidth: 640, capacity: 3, delayMs: 220});
let customFps = 60;
const PROFILES = Object.freeze({
  smooth60: Object.freeze({label: '60 fps', maxFps: 60, outputWidth: 1280, outputHeight: 720}),
  detail45: Object.freeze(
      {label: '45 fps', maxFps: 45, outputWidth: 1920, outputHeight: 1080, delayMs: 320}),
  fps30: Object.freeze(
      {label: '30 fps', maxFps: 30, outputWidth: 1920, outputHeight: 1080, delayMs: 320}),
  fps24: Object.freeze(
      {label: '24 fps', maxFps: 24, outputWidth: 1920, outputHeight: 1080, delayMs: 320}),
  custom: Object.freeze({
    get label() {
      return customFps + ' fps'
    },
    get maxFps() {
      return customFps
    },
    outputWidth: 1280,
    outputHeight: 720
  }),
});

// Trust only Blob URLs minted here for our bundled worker functions. Do not
// install a default policy or change the page's Content Security Policy.
const workerAddresses = new Set();
let workerPolicy = null;
function workerScriptURL(address) {
  if (!workerAddresses.has(address)) throw new TypeError('Unknown MotionFlow worker URL.');
  if (!browser.trustedTypes) return address;
  workerPolicy ||= browser.trustedTypes.createPolicy('qute-motionflow-workers', {
    createScriptURL(value) {
      if (!workerAddresses.has(value)) throw new TypeError('Unknown MotionFlow worker URL.');
      return value;
    },
  });
  return workerPolicy.createScriptURL(address);
}
function revokeWorkerURL(address) {
  workerAddresses.delete(address);
  browser.URL.revokeObjectURL(address);
}
if (browser.__motionFlowInstalled) return;
browser.__motionFlowInstalled = true;

class AudioRoute {
  constructor() {
    this.context = null;
    this.sources = new WeakMap();
    this.current = null;
    this.delayMs = 0;
    this.note = '';
    this.monoEnabled = false;
    this.nativeHeld = false;
  }
  unlock() {
    this.note = '';
    try {
      this.context ||= new browser.AudioContext({latencyHint: 'interactive'});
      this.context.resume().catch(error => {
        this.note = error.message;
      });
    } catch (error) {
      this.note = error.message;
    }
  }
  fade(parameter, value, now = this.context.currentTime) {
    if (typeof parameter.cancelAndHoldAtTime === 'function') {
      parameter.cancelAndHoldAtTime(now);
      // Anchor the new ramp even when the previous automation already ended.
      parameter.setValueAtTime(parameter.value, now);
    } else {
      const current = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(current, now);
    }
    parameter.linearRampToValueAtTime(value, now + .015);
  }
  direct() {
    if (this.current?.active) {
      const r = this.current;
      this.fade(r.gate.gain, 0);
      this.fade(r.direct.gain, this.nativeHeld ? 0 : 1);
      r.active = false;
    }
    this.delayMs = 0;
  }
  holdNative() {
    this.nativeHeld = true;
    if (!this.current) return;
    this.fade(this.current.direct.gain, 0);
    if (this.current.gate) this.fade(this.current.gate.gain, 0);
  }
  releaseNative() {
    this.nativeHeld = false;
    if (this.current && !this.current.active) this.fade(this.current.direct.gain, 1);
  }
  mix(route, mono) {
    // Linear fades keep the two coherent paths at unity and avoid a hard switch.
    const now = this.context.currentTime;
    this.fade(route.stereo.gain, mono ? 0 : 1, now);
    this.fade(route.mono.gain, mono ? 1 : 0, now);
  }
  route(video) {
    let route = this.sources.get(video);
    if (!route) {
      if (video.mediaKeys) throw new Error('Protected audio cannot be processed.');
      const check = document.createElement('canvas');
      check.width = check.height = 1;
      const painter = check.getContext('2d');
      painter.drawImage(video, 0, 0, 1, 1);
      painter.getImageData(0, 0, 1, 1);
      const direct = this.context.createGain(), stereo = this.context.createGain(),
            mono = this.context.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      mono.gain.setValueAtTime(0, this.context.currentTime);
      const input = this.context.createMediaElementSource(video);
      input.connect(direct);
      direct.connect(stereo);
      direct.connect(mono);
      stereo.connect(this.context.destination);
      mono.connect(this.context.destination);
      route = {input, direct, stereo, mono, active: false, held: true};
      this.sources.set(video, route);
    }
    if (this.current !== route) {
      this.direct();
      if (this.current) this.mix(this.current, false);
      this.current = route;
      this.mix(route, this.monoEnabled);
    }
    return route;
  }
  setMono(video, enabled) {
    if (enabled) this.unlock();
    try {
      if (enabled && !this.context) throw new Error(this.note || 'Web Audio is unavailable.');
      const route = enabled ? this.route(video) : this.current;
      if (route) this.mix(route, enabled);
      this.monoEnabled = enabled;
      return true;
    } catch (error) {
      this.note = error.message;
      return false;
    }
  }
  follow(video, milliseconds, hold = false) {
    if (!this.context || this.context.state !== 'running' || this.note) return;
    try {
      const route = this.route(video);
      const now = this.context.currentTime;
      const seconds =
          Math.max(0, Math.min(10, milliseconds / 1000 - (this.context.baseLatency || 0)));
      if (!route.active) {
        const oldDelay = route.delay, oldGate = route.gate;
        route.delay = this.context.createDelay(10);
        route.gate = this.context.createGain();
        route.gate.gain.setValueAtTime(0, now);
        route.delay.delayTime.setValueAtTime(seconds, now);
        route.input.connect(route.delay);
        route.delay.connect(route.gate);
        route.gate.connect(route.stereo);
        route.gate.connect(route.mono);
        if (oldDelay)
          browser.setTimeout(() => {
            try {
              route.input.disconnect(oldDelay);
              oldDelay.disconnect();
              oldGate.disconnect();
            } catch {
            }
          }, 35);
        route.active = true;
        route.held = true;
        this.delayMs = seconds * 1000;
      }
      this.fade(route.direct.gain, 0);
      // Small clock estimates must not continuously bend the audio's pitch.
      if (hold || route.held) {
        route.delay.delayTime.setValueAtTime(seconds, now);
        this.delayMs = seconds * 1000;
        this.fade(route.gate.gain, hold ? 0 : 1);
      } else if (Math.abs(this.delayMs - seconds * 1000) > 80) {
        this.fade(route.gate.gain, 0);
        route.delay.delayTime.setValueAtTime(seconds, now + .02);
        route.gate.gain.linearRampToValueAtTime(1, now + .04);
        this.delayMs = seconds * 1000;
      }
      route.held = hold;
    } catch (error) {
      this.direct();
      this.note = error.message;
    }
  }
}

function videoTimeText(time) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(time) ? time : 0));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') +
          ':' + String(seconds % 60).padStart(2, '0') :
                         minutes + ':' + String(seconds % 60).padStart(2, '0');
}
class PlaybackSession {
  constructor(video, player, audio, notify, options) {
    this.video = video;
    this.player = player;
    this.audio = audio;
    this.notify = notify;
    this.options = Object.freeze({...BASE_OPTIONS, ...options});
    this.closed = false;
    this.showing = false;
    this.comparison = false;
    this.displayedComparison = false;
    this.comparisonRevision = 0;
    this.rendererReady = false;
    this.outputPlayRevision = 0;
    this.split = this.displayedSplit = .5;
    this.stats = {sourceFps: 0};
    this.sourceMediaStart = video.currentTime;
    this.lastProgressAt = performance.now();
    this.lastProgressSourceTime = video.currentTime;
    this.handlers = [];
  }
  listen(target, name, handler) {
    target.addEventListener(name, handler);
    this.handlers.push(() => target.removeEventListener(name, handler));
  }
  createWorkerHost() {
    // The watch page can forbid Blob workers even with TrustedScriptURL.
    // Use the realm of YouTube's plain, same-origin static document instead.
    // Keep a 1 px frame inside the player so its worker RAF stays active in
    // fullscreen. display:none would suspend presentation on some browsers.
    return new Promise((resolve, reject) => {
      const frame = this.workerHost = document.createElement('iframe');
      const address = SITE === 'youtube' ? new URL('/robots.txt', browser.location.origin) :
                                           new URL('about:blank');
      frame.id = 'qute-motionflow-worker-host';
      frame.title = 'MotionFlow worker context';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;' +
          'opacity:0;pointer-events:none;border:0;';
      const finish = (error, Constructor) => {
        browser.clearTimeout(this.hostTimer);
        frame.onload = frame.onerror = null;
        this.hostReject = null;
        if (error)
          reject(error);
        else
          resolve(Constructor);
      };
      this.hostReject = error => finish(error);
      this.hostTimer =
          browser.setTimeout(() => finish(new Error('Static worker context timed out.')), 8000);
      frame.onerror = () => finish(new Error('Could not load the static worker context.'));
      frame.onload = () => {
        try {
          const context = frame.contentWindow, location = context.location;
          if (location.href === 'about:blank' && SITE === 'youtube') return;
          if (SITE === 'youtube' &&
              (location.origin !== address.origin || location.pathname !== address.pathname ||
               frame.contentDocument.contentType !== 'text/plain'))
            throw new Error('Expected YouTube’s same-origin plain-text worker context.');
          if (typeof context.Worker !== 'function')
            throw new Error('Static context has no Worker constructor.');
          finish(null, context.Worker);
        } catch (error) {
          finish(new Error('Static worker context unavailable: ' + error.message));
        }
      };
      frame.src = address.href;
      this.player.append(frame);
    });
  }
  async start() {
    if (typeof this.video.captureStream !== 'function' ||
        typeof browser.MediaStreamTrackProcessor !== 'function' ||
        typeof browser.MediaStreamTrackGenerator !== 'function')
      throw new Error('This browser lacks video track processing.');
    if (this.video.mediaKeys)
      throw new Error('This protected video cannot be captured for enhancement.');
    this.preparing = true;
    this.setupMessage = 'Starting video workers';
    this.notify({state: 'buffering', message: this.setupMessage});
    this.resumeSource = !this.video.paused;
    this.video.pause();
    this.updateTimeline();
    this.audio.follow(this.video, this.options.delayMs, true);
    const WorkerConstructor = await this.createWorkerHost();
    if (this.closed) throw new Error('Session closed.');
    this.layer = document.createElement('video');
    this.layer.id = 'qute-motionflow-output';
    this.layer.muted = true;
    this.layer.autoplay = true;
    this.layer.playsInline = true;
    this.layer.disablePictureInPicture = true;
    if (typeof this.layer.requestVideoFrameCallback === 'function') {
      const output = this.outputClockVideo = this.layer;
      const displayed = () => {
        if (this.closed || this.frozen || this.freezing) return;
        this.lastDisplayAt = performance.now();
        this.lastDisplaySourceTime = this.video.currentTime;
        this.outputCallback = output.requestVideoFrameCallback(displayed);
      };
      this.outputCallback = output.requestVideoFrameCallback(displayed);
    }
    this.generator = new browser.MediaStreamTrackGenerator({kind: 'video'});
    this.layer.srcObject = new browser.MediaStream([this.generator]);
    this.layer.style.cssText =
        'position:absolute;pointer-events:none;display:none;object-fit:contain;z-index:11;background:#000';
    this.line = document.createElement('div');
    this.line.id = 'qute-motionflow-divider';
    this.line.setAttribute('role', 'slider');
    this.line.setAttribute(
        'aria-label', 'Comparison divider: delayed original left, smoothed right');
    this.line.setAttribute('aria-orientation', 'horizontal');
    this.line.setAttribute('aria-valuemin', '2');
    this.line.setAttribute('aria-valuemax', '98');
    this.line.tabIndex = 0;
    let dragging = null;
    const move = event => {
      const bounds = this.pictureBounds();
      comparisonSplit = Math.max(.02, Math.min(.98, (event.clientX - bounds.left) / bounds.width));
      this.compare(this.comparison, comparisonSplit);
    };
    this.listen(this.line, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = event.pointerId;
      this.line.setPointerCapture(dragging);
      this.line.focus({preventScroll: true});
      move(event);
    });
    this.listen(this.line, 'pointermove', event => {
      if (event.pointerId !== dragging) return;
      event.preventDefault();
      event.stopPropagation();
      move(event);
    });
    for (const name of ['pointerup', 'pointercancel'])
      this.listen(this.line, name, event => {
        if (event.pointerId !== dragging) return;
        event.preventDefault();
        event.stopPropagation();
        dragging = null;
        if (this.line.hasPointerCapture(event.pointerId))
          this.line.releasePointerCapture(event.pointerId);
      });
    this.listen(this.line, 'lostpointercapture', () => {
      dragging = null;
    });
    this.listen(this.line, 'click', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.listen(this.line, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      comparisonSplit = event.key === 'Home' ?
          .02 :
          event.key === 'End' ?
          .98 :
          Math.max(
              .02,
              Math.min(
                  .98,
                  this.split + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .1 : .02)));
      this.compare(this.comparison, comparisonSplit);
    });
    this.layerHost = SITE === 'youtube' ? this.player : this.video.parentElement;
    if (SITE !== 'youtube') {
      if (browser.getComputedStyle(this.layerHost).position === 'static')
        this.layerHost.style.position = 'relative';
      this.layer.style.zIndex =
          String((parseInt(browser.getComputedStyle(this.video).zIndex) || 0) + 1);
    }
    this.layerHost.append(this.layer, this.line);
    this.playOutput();
    this.resize = new ResizeObserver(() => this.position());
    this.resize.observe(this.video);
    this.resize.observe(this.player);
    this.attributes = new MutationObserver(() => this.position());
    for (let node = this.video; node && node !== this.player; node = node.parentElement)
      this.attributes.observe(node, {attributes: true, attributeFilter: ['style', 'class']});
    this.listen(browser, 'resize', () => this.position());
    this.listen(document, 'fullscreenchange', () => this.position());
    this.position();
    this.capture = this.video.captureStream();
    this.capture.getAudioTracks().forEach(track => track.stop());
    const track = this.capture.getVideoTracks()[0];
    if (!track) throw new Error('The video has no capturable picture track.');
    this.captureTrack = track;
    this.watchSourceCadence();
    const processor = new browser.MediaStreamTrackProcessor({track, maxBufferSize: 4});
    const channel = this.channel = new browser.MessageChannel();
    this.workers = [];
    this.addresses = [];
    const ready = new Promise((resolve, reject) => {
      this.startupReject = reject;
      let count = 0;
      this.startupTimer = browser.setTimeout(
          () => reject(new Error('Worker startup timed out.')),
          this.options.engine === 'neural' ? 180000 : 15000);
      const fail = message => {
        browser.clearTimeout(this.startupTimer);
        reject(new Error(message));
        this.notify({state: 'error', message});
      };
      const producerFactory = this.options.engine === 'neural' ? neuralWorker : motionWorker;
      for (const [factory, name] of [
               [producerFactory, 'MotionFlow GPU producer'],
               [presentationWorker, 'MotionFlow presenter']]) {
        const address = browser.URL.createObjectURL(
            new Blob(['(' + factory.toString() + ')()'], {type: 'text/javascript'}));
        this.addresses.push(address);
        workerAddresses.add(address);
        const worker = new WorkerConstructor(workerScriptURL(address), {name});
        this.workers.push(worker);
        if (factory === presentationWorker)
          this.presenter = worker;
        else
          this.producer = worker;
        worker.onerror = event => fail(event.message || 'Worker failed.');
        worker.onmessage = ({data}) => {
          if (this.closed) {
            data.frame?.close();
            data.original?.close();
            return;
          }
          if (data.type === 'paused-frame') {
            if (this.freezeResolve)
              this.freezeResolve(data);
            else {
              data.frame?.close();
              data.original?.close();
            }
            return;
          }
          if (this.freezing || this.frozen) return;
          if (data.type === 'setup-progress') {
            this.setupMessage = data.message;
            this.notify({state: 'buffering', message: data.message});
            return;
          }
          if (data.type === 'model-preparing') {
            if (data.active) {
              this.modelPreparing = true;
              this.modelResumeSource = !this.video.paused;
              this.warmupRestartTime = this.displayedMediaTime ?? this.sourceMediaStart;
              this.video.pause();
              this.pauseOutput();
              this.showing = false;
              this.audio.direct();
              this.notify({state: 'buffering', message: 'Preparing GPU model'});
            } else
              this.notify({state: 'model-ready'});
            return;
          }
          if (data.type === 'boot') {
            revokeWorkerURL(address);
            try {
              if (factory === producerFactory)
                worker.postMessage(
                    {
                      type: 'start',
                      stream: processor.readable,
                      port: channel.port1,
                      options: {
                        ...this.options,
                        comparison: this.comparison,
                        split: this.split,
                        comparisonRevision: this.comparisonRevision
                      },
                      width: this.options.processingWidth,
                      height: this.options.processingHeight
                    },
                    [processor.readable, channel.port1]);
              else if (!data.workerRaf)
                fail('Worker display scheduling is unavailable.');
              else
                worker.postMessage(
                    {
                      type: 'start',
                      output: this.generator.writable,
                      port: channel.port2,
                      options: {
                        ...this.options,
                        comparison: this.comparison,
                        split: this.split,
                        comparisonRevision: this.comparisonRevision
                      }
                    },
                    [this.generator.writable, channel.port2]);
            } catch (error) {
              fail(error.message);
            }
          } else if (data.type === 'ready') {
            if (factory ===
                (this.options.comparisonInPresenter ? presentationWorker : producerFactory)) {
              this.rendererReady = true;
              this.syncComparison();
            }
            if (++count === 2) {
              browser.clearTimeout(this.startupTimer);
              this.startupReject = null;
              resolve();
            }
          } else if (data.type === 'error')
            fail(data.message);
          else if (data.type === 'producer-stats')
            this.stats = {...this.stats, ...data};
          else if (data.type === 'buffer-progress') {
            if (this.hasPresented && data.presentedTimeMs !== this.stats.presentedTimeMs) {
              this.lastProgressAt = performance.now();
              this.lastProgressSourceTime = this.video.currentTime;
              if (this.lastProgressAt - this.firstPresentationAt > 10000) this.recoveryAttempt = 0;
            }
            if (data.native) {
              this.audio.direct();
              this.cover?.remove();
              this.cover = null;
            }
            this.stats = {...this.stats, ...data};
            this.notify({
              ...this.stats,
              state: data.native ? 'native' :
                  this.showing   ? 'running' :
                                   'buffering'
            });
          } else if (data.type === 'comparison') {
            this.acknowledgeComparison(data);
          } else if (data.type === 'preview') {
            this.layer.style.display = 'block';
            this.position();
          } else if (data.type === 'presenting') {
            this.cover?.remove();
            this.cover = null;
            this.showing = this.hasPresented = true;
            this.firstPresentationAt ??= performance.now();
            this.lastProgressAt = this.lastDisplayAt = performance.now();
            this.lastDisplaySourceTime = this.lastProgressSourceTime = this.video.currentTime;
            this.layer.style.display = 'block';
            this.position();
            this.audio.follow(this.video, data.delayMs);
            this.notify({...this.stats, state: 'running'});
          } else if (data.type === 'starved' || data.type === 'native') {
            if (this.ending && data.type === 'starved') return;
            this.showing = false;
            this.stats.native = data.type === 'native';
            if (data.type === 'native') this.layer.style.display = 'none';
            this.line.style.display = 'none';
            if (data.type === 'native') {
              this.audio.direct();
              this.cover?.remove();
              this.cover = null;
            } else
              this.audio.follow(this.video, this.options.delayMs, true);
            this.notify({
              state: data.type === 'native' ? 'native' : 'buffering',
              message: data.type === 'native' ? 'Original frame rate needs no conversion' :
                                                'Waiting for video frames'
            });
          } else if (data.type === 'stats') {
            this.stats = {...this.stats, ...data};
            if (this.showing) this.audio.follow(this.video, data.actualDelayMs || data.delayMs);
            this.notify({
              ...this.stats,
              state: data.native ? 'native' :
                  this.showing   ? 'running' :
                                   'buffering'
            });
          } else if (data.type === 'drained') {
            this.videoDrained = true;
            this.finishWhenDrained();
          }
          this.updateTimeline();
        };
      }
    });
    await ready;
    if (this.closed) return;
    // Keep the visible picture still while real-time capture fills the buffer.
    this.cover = document.createElement('canvas');
    this.cover.width = this.video.videoWidth;
    this.cover.height = this.video.videoHeight;
    this.cover.style.cssText = this.layer.style.cssText;
    this.cover.style.display = 'block';
    this.cover.getContext('2d').drawImage(this.video, 0, 0);
    this.layer.after(this.cover);
    if (!this.stats.native) this.audio.follow(this.video, this.options.delayMs, true);
    this.lastProgressAt = performance.now();
    const resume = this.resumeSource;
    this.resumeSource = this.preparing = false;
    this.setupMessage = '';
    this.readyAt = performance.now();
    if (resume) await this.video.play();
  }
  playOutput() {
    const output = this.layer, revision = ++this.outputPlayRevision;
    return output.play().catch(error => {
      // A deliberate pause, replacement, or newer play request cancels this one.
      if (this.closed || output !== this.layer || revision !== this.outputPlayRevision) return;
      this.notify({state: 'error', message: 'Processed video playback failed: ' + error.message});
    });
  }
  pauseOutput() {
    this.outputPlayRevision++;
    this.layer?.pause?.();
  }
  watchSourceCadence() {
    if (typeof this.video.requestVideoFrameCallback !== 'function') return;
    const periods = [];
    let lastTime = null;
    const inspect = (_now, metadata) => {
      if (this.closed) return;
      if (lastTime !== null && metadata.mediaTime > lastTime) {
        const period = (metadata.mediaTime - lastTime) * 1000;
        if (period > 4 && period < 250) {
          periods.push(period);
          if (periods.length > 17) periods.shift();
        }
      }
      if (lastTime === null || metadata.mediaTime > lastTime) lastTime = metadata.mediaTime;
      if (periods.length >= 5) {
        const ordered = [...periods].sort((a, b) => a - b);
        // UI stalls can skip callbacks. Retain the best cadence until this session
        // ends; source, seek and playback-rate changes create a fresh session.
        const fps = Math.max(
            this.sourceCadence || 0,
            1000 / ordered[Math.floor(ordered.length / 5)] * this.video.playbackRate);
        if (!this.sourceCadence || Math.abs(fps - this.sourceCadence) > this.sourceCadence * .02) {
          this.sourceCadence = fps;
          this.producer?.postMessage({type: 'cadence', fps});
          // Some Chromium capture sources retain a higher capture cadence after
          // a speed change. Limit that track to the decoded source's cadence.
          this.captureTrack.applyConstraints({frameRate: {max: fps + .5}}).catch(error => {
            this.captureConstraintNote = error.message;
          });
        }
      }
      this.sourceCallback = this.video.requestVideoFrameCallback(inspect);
    };
    this.sourceCallback = this.video.requestVideoFrameCallback(inspect);
  }
  stalled() {
    if (this.closed || this.preparing || this.modelPreparing || this.ending || this.frozen ||
        this.stats.native || this.video.paused || this.video.seeking || this.video.readyState < 3)
      return false;
    const timeout = this.hasPresented ? 5000 : Math.max(5000, this.options.delayMs + 2000);
    const bounds = this.video.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= browser.innerHeight) return false;
    const progressAt = this.hasPresented && this.outputClockVideo ?
        Math.min(this.lastProgressAt, this.lastDisplayAt || this.lastProgressAt) :
        this.lastProgressAt;
    const sourceTime = this.outputClockVideo && this.lastDisplayAt < this.lastProgressAt ?
        this.lastDisplaySourceTime :
        this.lastProgressSourceTime;
    return performance.now() - progressAt > timeout && this.video.currentTime - sourceTime > 1;
  }
  updateTimeline() {
    if (this.modelPreparing) return;
    if (this.closed || this.stats.native) {
      this.releasePlayerClock();
      this.player.classList.remove('mf-clock-active');
      return;
    }
    const mediaTime = this.sourceMediaStart +
        (this.hasPresented ? (this.stats.presentedTimeMs || 0) * this.video.playbackRate / 1000 :
                             0);
    const duration = this.video.duration;
    this.displayedMediaTime = this.completed && Number.isFinite(duration) ? duration :
        Math.max(0, Number.isFinite(duration) ? Math.min(duration, mediaTime) : mediaTime);
    if (SITE !== 'youtube' || !Number.isFinite(duration) || duration <= 0) return;
    if (!this.player.classList.contains('mf-clock-active')) this.player.classList.add('mf-clock-active');
    const ratio = this.displayedMediaTime / duration;
    this.player.style.setProperty('--mf-progress', ratio);
    this.player.style.setProperty('--mf-progress-px', ratio * (this.timelineWidth || 0) + 'px');
    this.setPlayerClock(this.displayedMediaTime);
  }
  setPlayerClock(seconds) {
    const current = this.player.querySelector('.ytp-time-current');
    if (!current) return;
    if (this.clockNode !== current) {
      this.clockObserver?.disconnect();
      this.clockNode = current;
      this.clockObserver = new MutationObserver(() => {
        if (!this.closed && !this.stats.native && this.clockText &&
            current.textContent !== this.clockText)
          current.textContent = this.clockText;
      });
      this.clockObserver.observe(current, {childList: true, characterData: true, subtree: true});
    }
    this.clockText = videoTimeText(seconds);
    if (current.textContent !== this.clockText) current.textContent = this.clockText;
  }
  releasePlayerClock(seconds = this.video.currentTime) {
    this.clockObserver?.disconnect();
    this.clockObserver = null;
    this.clockNode = null;
    const current = this.player.querySelector('.ytp-time-current');
    if (current) current.textContent = videoTimeText(seconds);
  }

  pictureBounds() {
    const box = this.video.getBoundingClientRect();
    const aspect = this.video.videoWidth / this.video.videoHeight || box.width / box.height;
    const width = Math.min(box.width, box.height * aspect);
    const height = Math.min(box.height, box.width / aspect);
    return {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width,
      height
    };
  }
  position() {
    if (this.closed || !this.layer) return;
    this.timelineWidth =
        this.player.querySelector('.ytp-progress-bar')?.clientWidth || this.video.clientWidth;
    const frame = this.video.getBoundingClientRect(),
          host = (this.layerHost || this.player).getBoundingClientRect();
    const sx = host.width / (this.player.offsetWidth || host.width) || 1,
          sy = host.height / (this.player.offsetHeight || host.height) || 1;
    const x = (frame.left - host.left) / sx - this.player.clientLeft + this.player.scrollLeft;
    const y = (frame.top - host.top) / sy - this.player.clientTop + this.player.scrollTop;
    const width = frame.width / sx, height = frame.height / sy;
    Object.assign(
        this.layer.style,
        {left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px', clipPath: ''});
    if (this.cover) {
      this.cover.style.cssText = this.layer.style.cssText;
      this.cover.style.display = 'block';
    }
    const picture = this.pictureBounds();
    Object.assign(this.line.style, {
      left: (x + (picture.left - frame.left + picture.width * this.displayedSplit) / sx) + 'px',
      top: (y + (picture.top - frame.top) / sy) + 'px',
      height: picture.height / sy + 'px',
      display: this.showing && this.displayedComparison ? 'block' : 'none'
    });
    this.line.setAttribute('aria-valuenow', String(Math.round(this.displayedSplit * 100)));
    this.line.setAttribute('aria-valuetext', Math.round(this.displayedSplit * 100) + '% original');
  }
  syncComparison() {
    if (!this.rendererReady || this.closed || this.frozen || this.freezing) return;
    const renderer = this.options.comparisonInPresenter ? this.presenter : this.producer;
    renderer?.postMessage({
      type: 'comparison',
      enabled: this.comparison,
      split: this.split,
      revision: this.comparisonRevision
    });
  }
  acknowledgeComparison(data) {
    // An asynchronous write can finish after a newer checkbox/divider command.
    if (data.revision !== this.comparisonRevision) return;
    this.displayedComparison = this.comparison && !!data.enabled;
    this.displayedSplit = data.split ?? this.split;
    this.position();
  }
  compare(enabled = !this.comparison, split = this.split) {
    const nextSplit = Math.max(.02, Math.min(.98, split));
    if (this.comparison !== !!enabled) this.comparisonRevision++;
    this.comparison = !!enabled;
    this.split = nextSplit;
    if (!this.comparison) {
      this.displayedComparison = false;
      this.position();
    }
    if (this.frozen) {
      this.drawFrozen();
    } else {
      this.syncComparison();
    }
  }
  drawFrozen() {
    if (!this.pausedPair) return;
    const {frame, original} = this.pausedPair;
    const context = this.layer.getContext('2d', {alpha: false});
    const width = this.layer.width, height = this.layer.height;
    context.drawImage(frame, 0, 0, width, height);
    if (this.comparison && original) {
      context.save();
      context.beginPath();
      context.rect(0, 0, Math.round(width * this.split), height);
      context.clip();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'low';
      context.drawImage(original, 0, 0, width, height);
      context.restore();
    }
    this.displayedComparison = this.comparison && !!original;
    this.displayedSplit = this.split;
    this.position();
  }
  finishSource() {
    if (this.ending || this.closed) return;
    this.ending = true;
    this.sourceEndedAt = this.audio.context?.currentTime || 0;
    this.player.classList.add('mf-finishing');
    this.presenter?.postMessage({type: 'finishing'});
    this.producer?.postMessage({type: 'finish'});
    this.finishWhenDrained();
  }
  finishWhenDrained() {
    if (!this.ending || !this.videoDrained || this.closed || this.completed) return;
    browser.clearTimeout(this.endTimer);
    const remaining = this.audio.current?.active ?
        this.sourceEndedAt + this.audio.delayMs / 1000 - this.audio.context.currentTime :
        0;
    if (remaining > .01) {
      this.endTimer =
          browser.setTimeout(() => this.finishWhenDrained(), Math.min(100, remaining * 1000));
      return;
    }
    this.completed = true;
    this.player.classList.remove('mf-finishing');
    this.freeze().then(() => {
      if (!this.closed) {
        this.updateTimeline();
        this.notify({...this.stats, state: 'ended', message: 'Playback finished'});
      }
    });
  }
  freeze() {
    if (this.closed || this.frozen) return Promise.resolve();
    return this.freezeTask ||= this.freezeFrame();
  }
  async freezeFrame() {
    this.freezing = true;
    this.audio.direct();
    this.pauseOutput();
    const data = await new Promise(resolve => {
      this.freezeResolve = resolve;
      this.freezeTimer = browser.setTimeout(() => resolve(null), 800);
      this.presenter?.postMessage({type: 'pause'});
    });
    browser.clearTimeout(this.freezeTimer);
    this.freezeResolve = null;
    if (this.closed || !data?.frame) {
      data?.frame?.close();
      data?.original?.close();
      if (!this.closed) this.stop();
      return;
    }
    this.stopProcessing();
    const oldLayer = this.layer;
    this.layer = document.createElement('canvas');
    this.layer.id = oldLayer.id;
    this.layer.style.cssText = oldLayer.style.cssText;
    this.layer.width = data.frame.displayWidth;
    this.layer.height = data.frame.displayHeight;
    oldLayer.srcObject = null;
    oldLayer.replaceWith(this.layer);
    this.pausedPair = data;
    this.stats = {
      ...this.stats,
      presentedTimeMs: data.time,
      buffered: 0,
      bufferedMs: 0,
      bufferBytes: 0,
      drawFps: 0,
      generatedFps: 0,
      heldFps: 0,
      droppedFps: 0
    };
    this.frozen = this.showing = true;
    this.freezing = false;
    this.drawFrozen();
    this.updateTimeline();
    this.notify(
        {...this.stats, state: 'paused', message: 'Paused · compare the same displayed frame'});
  }
  stopProcessing() {
    this.rendererReady = false;
    browser.clearTimeout(this.startupTimer);
    this.startupReject?.(new Error('Session closed.'));
    this.hostReject?.(new Error('Session closed.'));
    browser.clearTimeout(this.hostTimer);
    if (this.sourceCallback != null) this.video.cancelVideoFrameCallback(this.sourceCallback);
    this.sourceCallback = null;
    if (this.outputCallback != null)
      this.outputClockVideo?.cancelVideoFrameCallback(this.outputCallback);
    this.outputCallback = null;
    this.outputClockVideo = null;
    this.capture?.getTracks().forEach(track => track.stop());
    this.generator?.stop();
    this.workers?.forEach(worker => {
      worker.postMessage({type: 'stop'});
      worker.terminate();
    });
    this.workers = [];
    this.producer = this.presenter = null;
    this.addresses?.forEach(revokeWorkerURL);
    this.addresses = [];
    this.workerHost?.remove();
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.audio.direct();
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.releasePlayerClock();
    this.player.classList.remove('mf-clock-active');
    this.showing = false;
    browser.clearTimeout(this.endTimer);
    this.player.classList.remove('mf-finishing');
    this.cover?.remove();
    if ((this.preparing && this.resumeSource || this.modelPreparing && this.modelResumeSource) &&
        this.video.paused && !this.video.ended)
      this.video.play().catch(() => {});
    this.resumeSource = this.preparing = this.modelPreparing = false;
    browser.clearTimeout(this.freezeTimer);
    this.freezeResolve?.(null);
    this.stopProcessing();
    this.resize?.disconnect();
    this.attributes?.disconnect();
    this.handlers.forEach(remove => remove());
    this.pausedPair?.frame.close();
    this.pausedPair?.original?.close();
    this.pausedPair = null;
    if (this.layer) {
      this.pauseOutput();
      this.layer.srcObject = null;
      this.layer.remove();
    }
    this.line?.remove();
  }
}

const audio = new AudioRoute();
let owner = null, element = null, key = '', enabled = false, session = null;
let smoothingEnabled = false;
let optionsButton = null, panel = null, badge = null, diagnosticOverlay = null,
    bufferOverlay = null;
let resolutionId = 'auto', bufferId = 'auto', bufferMemoryId = '512',
    upscaleMethod = 'lanczos', upscaleEnabled = false, diagnosticsVisible = false;
let statusTimer = 0, statusUntil = 0, statusKey = '';
let monoError = '';
let monoButton = null, priorityButton = null;
let prioritizeSmoothness = true;
const adaptiveQuality = new AdaptiveQuality();
let smoothingButton = null, compareButton = null, diagnosticButton = null,
    aiButton = null, profileButtons = new Map(), contentButtons = new Map();
let neuralEnabled = true, contentId = 'general';
let profileId = 'smooth60', optionsOpen = false, comparison = false, comparisonSplit = .5;
let panelInteractionUntil = 0, pointerStartedInMenu = false;
let state = {state: 'off'}, generation = 0, observedPlayer = null, adWatcher = null;
let warmRestart = null, warmRestartTimer = 0;
let nativeReturn = null, nativeReturnError = '';

function identity() {
  const url = new URL(browser.location.href);
  if (SITE !== 'youtube') return url.origin + url.pathname + url.search;
  return url.pathname === '/watch' ?
      url.searchParams.get('v') || '' :
      url.pathname.startsWith('/embed/') ?
      url.pathname :
      (document.querySelector('video:not(#qute-motionflow-output)') ? url.pathname + url.search :
                                                                      '');
}
function labelButton(control, label, title) {
  control.setAttribute('aria-label', label);
  control.title = title;
}
function playbackOptions() {
  const profile = PROFILES[profileId];
  const requested = outputSizing(element, profile, resolutionId, neuralEnabled && upscaleEnabled);
  adaptiveQuality.configure({
    key: [key, profileId, customFps, contentId, resolutionId, smoothingEnabled].join('|'),
    enabled: prioritizeSmoothness && neuralEnabled && upscaleEnabled && requested.upscaling,
    height: requested.outputHeight,
    sourceHeight: element?.videoHeight || requested.outputHeight,
    method: upscaleMethod
  });
  const effective = adaptiveQuality.effective;
  const sizing = adaptiveSizing(element, requested, effective.height);
  const automatic = neuralEnabled ? (profile.maxFps <= 45 ? 650 : 400) +
          (contentId === 'animation' || contentId === 'general' ? 50 :
               contentId === 'gameplay'                         ? -100 :
                                                                  0) :
                                    (profile.maxFps <= 45 ? 450 : 320);
  return {
    ...profile,
    ...sizing,
    resize: sizing.resize && (resolutionId !== 'auto' || upscaleEnabled && sizing.upscaling),
    interpolation: smoothingEnabled,
    comparisonInPresenter: true,
    upscale: neuralEnabled && upscaleEnabled && sizing.upscaling,
    upscaleMethod: effective.method,
    requestedUpscaleMethod: upscaleMethod,
    requestedOutputHeight: requested.outputHeight,
    smoothnessPriority: prioritizeSmoothness,
    smoothnessPriorityActive: adaptiveQuality.level > 0,
    engine: neuralEnabled ? 'neural' : 'optical',
    content: contentId,
    ...bufferingOptions(bufferId, bufferMemoryId, automatic),
    previewBuffer: true,
    authToken: browser.__motionFlowAuth?.token || '',
    resolutionId,
    bufferId,
    bufferMemoryId
  };
}
function changeOutput(kind, value) {
  if (kind === 'resolution')
    resolutionId = value;
  else if (kind === 'buffer')
    bufferId = value;
  else if (kind === 'memory')
    bufferMemoryId = value;
  else if (kind === 'method')
    upscaleMethod = value;
  else {
    upscaleEnabled = !upscaleEnabled;
    enabled = smoothingEnabled || upscaleEnabled;
    if (enabled) audio.unlock();
  }
  stopForSettings();
  reconcile();
}
function selectContent(id) {
  if (id === contentId) return;
  contentId = id;
  if (enabled) stopForSettings();
  reconcile();
}
function toggleAI() {
  neuralEnabled = !neuralEnabled;
  if (!neuralEnabled) {
    if (Number(resolutionId) > 1080) resolutionId = 'source';
    upscaleEnabled = false;
    enabled = smoothingEnabled;
  }
  stopForSettings();
  reconcile();
}
function panelIsBusy() {
  if (!panel || !optionsOpen) return false;
  const focused = document.activeElement;
  return panel.matches(':hover') || performance.now() < panelInteractionUntil ||
      panel.contains(focused) &&
      (focused.matches('input,select,textarea') || focused.matches(':focus-visible'));
}
function paint() {
  if (!optionsButton) return;
  if (SITE === 'youtube' && owner?.matches('.ytp-autohide,.ytp-hide-controls') && !panelIsBusy())
    optionsOpen = false;
  const mode = !enabled ? 'off' : state.state;
  const current = ({
                    off: 'Off',
                    running: 'On',
                    error: 'Error',
                    native: 'Native',
                    paused: 'Paused',
                    finishing: 'Finishing',
                    ended: 'Finished',
                    buffering: 'Buffering'
                  })[mode] ||
      'Waiting';
  labelButton(
      optionsButton, 'MotionFlow settings: ' + current,
      'MotionFlow · ' + current +
          (enabled ? ' · ' + PROFILES[profileId].label : '') +
          (state.message ? ' · ' + state.message : '') +
          (enabled && audio.note ? ' · Audio: ' + audio.note : ''));
  optionsButton.dataset.state = mode;
  optionsButton.dataset.enabled = String(enabled);
  optionsButton.setAttribute('aria-expanded', String(optionsOpen));
  const info = panel.querySelector('#qute-motionflow-profile-info');
  const selectedOptions = playbackOptions(), stats = session?.stats || {};
  info.querySelector('.mf-delay').textContent = session?.completed ?
      '0 ms (finished)' :
      element?.paused && !session?.ending ?
      '0 ms (paused)' :
      state.state === 'native' ?
      'Bypassed' :
      Math.round(
          session?.showing && audio.current?.active ? audio.delayMs : selectedOptions.delayMs) +
          ' ms';
  panel.querySelector('#qute-motionflow-resolution').value = resolutionId;
  panel.querySelector('#qute-motionflow-buffer-choice').value = bufferId;
  panel.querySelector('#qute-motionflow-buffer-memory').value = bufferMemoryId;
  const methodControl = panel.querySelector('#qute-motionflow-upscale-method');
  methodControl.value = upscaleMethod;
  methodControl.disabled = !neuralEnabled;
  const customControl = panel.querySelector('#qute-motionflow-custom-fps');
  if (document.activeElement !== customControl) customControl.value = customFps;
  profileButtons.get('custom').querySelector('.mf-label').textContent = 'Custom';
  panel.querySelector('.mf-performance-note').hidden =
      !(selectedOptions.upscale && selectedOptions.upscaleMethod === 'ai' ||
        selectedOptions.outputHeight > 1080 || selectedOptions.maxFps > 60);
  panel.querySelector('.mf-performance-note').textContent =
      (selectedOptions.upscale && selectedOptions.upscaleMethod === 'ai' ?
           'AI infers detail and may alter textures. ' :
           '') +
      'High settings may stutter or drop frames. Your selection stays active.';
  panel.querySelector('#qute-motionflow-buffer-choice').title =
      'Prepared frames use at most ' + selectedOptions.maxBufferBytes / 1048576 +
      ' MiB. Raise Frame memory if large outputs shorten the requested buffer.';
  for (const option of panel.querySelector('#qute-motionflow-resolution').options)
    option.disabled = !neuralEnabled && Number(option.value) > 1080;
  const upscaleButton = panel.querySelector('#qute-motionflow-upscale');
  upscaleButton.disabled = !neuralEnabled;
  upscaleButton.setAttribute('aria-checked', String(upscaleEnabled));
  upscaleButton.title = selectedOptions.upscaleMethod === 'ai' ?
      'AI detail reconstruction; select an output larger than the source. Details are inferred, not recovered facts.' :
      'Lanczos-3 resizing on the GPU when available; no invented detail. Select an output larger than the source.';
  const detail = panel.querySelector('.mf-upscale-description');
  detail.hidden = !upscaleEnabled;
  detail.textContent = !selectedOptions.upscaling ?
      (selectedOptions.smoothnessPriorityActive ?
           'Enhancement limited for smoothness; your requested resolution is retained.' :
           'Choose a resolution larger than the source to upscale.') :
      (selectedOptions.upscaleMethod === 'ai' ? UPSCALE_DETAILS[contentId] :
                                                (stats.upscaler || 'Lanczos 3 · GPU preferred')) +
          ' · ' + (element?.videoWidth || 0) + '×' + (element?.videoHeight || 0) + ' → ' +
          selectedOptions.outputWidth + '×' + selectedOptions.outputHeight;
  priorityButton.setAttribute('aria-checked', String(prioritizeSmoothness));
  labelButton(
      priorityButton, 'Prefer smoothness: ' + (prioritizeSmoothness ? 'On' : 'Off'),
      'Keep AI detail while it sustains playback; reduce effective resolution if overloaded, then fall back to Lanczos. Off always uses your requested quality. Target FPS stays selected.');
  const priorityNote = panel.querySelector('.mf-priority-note');
  priorityNote.hidden = !selectedOptions.smoothnessPriorityActive;
  priorityNote.textContent = (selectedOptions.upscaleMethod === 'ai' ? 'AI' :
                                  upscaleMethod === 'ai'             ? 'Lanczos fallback' :
                                                                       'Lanczos') +
      ' · ' + selectedOptions.outputHeight + 'p effective · ' + RESOLUTIONS[resolutionId] +
      ' requested. Your selection is retained.';
  smoothingButton.setAttribute('aria-checked', String(smoothingEnabled));
  labelButton(
      smoothingButton, 'Motion smoothing: ' + (smoothingEnabled ? 'On' : 'Off'),
      'Interpolate slower video or limit faster video to the selected FPS. Upscaling also honors a lower FPS target when this switch is off.');
  const smoothing = !smoothingEnabled      ? 'Off' :
      session?.completed                   ? 'Finished' :
      session?.frozen || session?.freezing ? 'Paused' :
      stats.rateLimited                    ? 'Limited to ' + selectedOptions.maxFps + ' fps' :
      state.state === 'native' || stats.passthrough ? 'Native FPS' :
      session?.showing                              ? 'Running' :
                                                      current;
  const scaling = !enabled || !upscaleEnabled ?
      'Off' :
      !selectedOptions.upscaling ?
      (selectedOptions.smoothnessPriorityActive ? 'Limited for smoothness' : 'Not needed') :
      session?.completed                   ? 'Finished' :
      session?.frozen || session?.freezing ? 'Paused' :
      session?.showing                     ? 'Running' :
                                             current;
  panel.querySelector('.mf-smoothing-state').textContent = smoothing;
  panel.querySelector('.mf-upscale-state').textContent = scaling;
  const buffered = Math.round(stats.bufferedMs || 0),
        target = Math.round(stats.targetBufferMs || selectedOptions.delayMs),
        fraction = Math.max(0, Math.min(1, buffered / Math.max(1, target)));
  const setup = !!session?.preparing || !!session?.modelPreparing;
  const setupMessage = session?.modelPreparing ? 'Preparing GPU model' :
                                                 session?.setupMessage || 'Starting video workers';
  const progress = panel.querySelector('progress');
  if (setup)
    progress.removeAttribute('value');
  else
    progress.value = fraction;
  const low =
      !!session?.showing && (stats.heldFps || 0) > 2 && buffered < Math.min(100, target * .25);
  panel.querySelector('.mf-buffer-view').dataset.low = String(low);
  panel.querySelector('.mf-buffer-text').textContent = setup ? setupMessage + ' · video paused' :
      session?.frozen          ? 'Paused · matching frame pair saved' :
      state.state === 'native' ? 'Native playback · buffer bypassed' :
                                 buffered + ' / ' + target + ' ms · ' + (stats.buffered || 0) +
          ' frames' + (stats.rateLimited ? ' · ' + selectedOptions.maxFps + ' fps cap' : '') +
          (stats.captureLimited ? ' · Capture below source FPS; settings retained' :
               low              ? ' · Performance low; settings retained' :
                                  '');
  bufferOverlay.hidden = !enabled || !session?.presenter || session.showing ||
      state.state === 'native' || state.state === 'error';
  const waitingProgress = bufferOverlay.querySelector('progress');
  if (setup)
    waitingProgress.removeAttribute('value');
  else
    waitingProgress.value = fraction;
  bufferOverlay.querySelector('span').textContent =
      setup ? setupMessage : 'Buffering video · ' + Math.round(fraction * 100) + '%';
  diagnosticOverlay.hidden = !diagnosticsVisible || !enabled;
  diagnosticOverlay.textContent = [
    CONTENTS[contentId] + ' · ' + (neuralEnabled ? 'Local AI' : 'Browser'),
    'Motion smoothing: ' + smoothing, 'Upscaling: ' + scaling,
    'Priority: ' + (prioritizeSmoothness ? 'Smoothness' : 'Selected detail') +
        (selectedOptions.smoothnessPriorityActive ?
             ' · ' + selectedOptions.upscaleMethod + ' ' + selectedOptions.outputHeight + 'p' :
             ''),
    ...(stats.upscaler ?
            ['Upscaler ' + stats.upscaler +
             (Number.isFinite(stats.upscaleStrength) ?
                  ' · ' + Math.round(stats.upscaleStrength * 100) + '%' :
                  '')] :
            []),
    'FPS ' + (stats.sourceFps || 0).toFixed(1) + ' → ' + (stats.drawFps || 0).toFixed(1),
    'Output ' + (state.state === 'native' ? element.videoWidth : selectedOptions.outputWidth) +
        ' × ' + (state.state === 'native' ? element.videoHeight : selectedOptions.outputHeight),
    'Buffer ' + buffered + ' / ' + target + ' ms · ' + (stats.buffered || 0) + ' frames',
    'Frame memory ' + ((stats.bufferBytes || 0) / 1048576).toFixed(1) + ' / ' +
        selectedOptions.maxBufferBytes / 1048576 + ' MiB',
    'Held ' + (stats.heldFps || 0).toFixed(0) + '/s · dropped ' +
        (stats.droppedFps || 0).toFixed(0) + '/s',
    ...(stats.pixelBackend ?
            ['Pixel pipeline ' + stats.pixelBackend + ' · ' + (stats.conversionMs || 0).toFixed(1) +
             ' ms'] :
            []),
    ...(stats.captureClockResets ? ['Capture clock resets ' + stats.captureClockResets] : []),
    ...(stats.captureQueueLimit ?
            ['Capture queue ' + (stats.captureQueued || 0) + ' / ' + stats.captureQueueLimit +
             ' · skipped ' + (stats.skippedSources || 0) + ' · max gap ' +
             (stats.maxCaptureGapMs || 0).toFixed(0) + ' ms'] :
            []),
    ...(stats.rateLimited ?
            ['FPS cap ' + selectedOptions.maxFps + ' · skipped before processing ' +
             (stats.rateSkipped || 0)] :
            []),
    ...(stats.restorationCacheHits ? ['Restoration cache hits ' + stats.restorationCacheHits] : []),
    'Audio +' + audio.delayMs.toFixed(0) + ' ms'
  ].join('\n');
  info.title = 'Audio follows actual video latency. Prepared frame duration is shown separately.';
  panel.querySelector('#qute-motionflow-resolution').title =
      'Choose Lanczos for faithful resizing or AI for inferred detail. Large outputs may shorten the buffer.';
  panel.hidden = !optionsOpen;
  panel.style.display = optionsOpen ? 'block' : 'none';
  if (typeof panel.showPopover === 'function') {
    if (optionsOpen && panel.isConnected && !panel.matches(':popover-open'))
      panel.showPopover();
    else if (!optionsOpen && panel.matches(':popover-open'))
      panel.hidePopover();
  }
  for (const [id, control] of profileButtons) {
    const selected = id === profileId;
    labelButton(
        control, PROFILES[id].maxFps + ' fps' + (selected ? ': Selected' : ': Select target'),
        'Interpolate lower frame rates up to ' + PROFILES[id].maxFps +
            ' fps; faster video is capped before processing. Upscaling also honors this cap with smoothing off. Resolution is selected separately.');
    control.setAttribute('aria-checked', String(selected));
  }
  aiButton.setAttribute('aria-checked', String(neuralEnabled));
  labelButton(
      aiButton, 'AI engine: ' + (neuralEnabled ? 'On' : 'Off'),
      neuralEnabled ? 'RIFE 4.25 on the local RTX GPU' :
                      'Enable the local AI helper for cleaner interpolation');
  for (const [id, control] of contentButtons) {
    control.setAttribute('aria-checked', String(id === contentId));
    control.disabled = !neuralEnabled;
    labelButton(
        control, CONTENTS[id],
        id === 'animation'    ? 'Bridge repeated drawings' :
            id === 'gameplay' ? 'Shorter buffer and conservative scene changes' :
            id === 'general'  ? 'Adapt to repeated drawings in mixed footage' :
                                'Interpolate lower-rate footage; leave higher FPS unchanged');
  }
  const comparing = comparison;
  labelButton(
      compareButton, 'Compare original and smoothed video: ' + (comparing ? 'On' : 'Off'),
      enabled ?
          'Original left, enhanced right at matching playback time; also works on a frozen paused frame' :
          'Comparison starts when motion smoothing or upscaling is enabled');
  compareButton.setAttribute('aria-checked', String(comparing));
  compareButton.disabled = false;
  compareButton.setAttribute('aria-disabled', 'false');
  const compareNote = panel.querySelector('.mf-compare-note');
  compareNote.hidden = !comparison || !!session?.showing && !!session?.displayedComparison;
  compareNote.textContent = !enabled ? 'Comparison will start with motion smoothing or upscaling.' :
      state.state === 'error'        ? 'Processing failed: ' + (state.message || 'Unknown error') +
          ' Turn Compare off and on to retry.' :
      state.state === 'native' ? 'Native playback; comparison resumes when enhancement is needed.' :
                                 'Preparing matching comparison frames.';
  if (session?.frozen && session.displayedComparison) compareNote.hidden = true;
  monoButton.setAttribute('aria-checked', String(audio.monoEnabled));
  labelButton(
      monoButton, 'Mono audio: ' + (audio.monoEnabled ? 'On' : 'Off'),
      audio.monoEnabled ? 'Restore the original audio channels' :
                          'Mix the video audio to mono and play it through both speakers');
  const monoNote = panel.querySelector('.mf-mono-note');
  monoNote.hidden = !monoError;
  monoNote.textContent = monoError;
  const returnNote = panel.querySelector('.mf-return-note');
  returnNote.hidden = !nativeReturnError;
  returnNote.textContent = nativeReturnError;
  diagnosticButton.setAttribute('role', 'menuitemcheckbox');
  diagnosticButton.setAttribute('aria-checked', String(diagnosticsVisible));
  diagnosticButton.dataset.status = diagnosticsVisible ? 'on' : 'off';
  labelButton(
      diagnosticButton, 'Playback statistics: ' + (diagnosticsVisible ? 'On' : 'Off'),
      'Toggle live statistics on the video');
  let text = state.message || 'MotionFlow · ' + mode;
  if (mode === 'running' && state.drawFps !== undefined)
    text = `${neuralEnabled ? 'RIFE 4.25' : 'MotionFlow'} · ${state.sourceFps.toFixed(0)}→${
        state.drawFps.toFixed(
            0)} fps · ${state.heldFps.toFixed(0)} held/s · audio +${audio.delayMs.toFixed(0)} ms`;
  if (comparison && session?.displayedComparison)
    text += ' · delayed original left | smoothed right';
  if (audio.note && enabled) text += ' · audio: ' + audio.note;
  const nextStatusKey = [
    mode, state.message || '', comparison, profileId, diagnosticsVisible, audio.note || '',
    neuralEnabled, contentId
  ].join('|');
  if (nextStatusKey !== statusKey) {
    statusUntil = statusKey ? performance.now() + 4000 : 0;
    statusKey = nextStatusKey;
    browser.clearTimeout(statusTimer);
    statusTimer = browser.setTimeout(() => {
      if (badge) badge.hidden = true;
    }, 4000);
  }
  badge.hidden = optionsOpen || performance.now() >= statusUntil;
  if (badge.textContent !== text) badge.textContent = text;
}
function halt({keepNativeReturn = false} = {}) {
  if (!keepNativeReturn) nativeReturn?.cancel();
  browser.clearTimeout(warmRestartTimer);
  warmRestart?.cancel?.();
  warmRestart?.player.classList.remove('mf-clock-active');
  warmRestart = null;
  generation++;
  session?.stop();
  session = null;
  audio.direct();
}
function nativeSeekTarget(video, time) {
  if (!Number.isFinite(time)) return null;
  const target =
      Math.max(0, Number.isFinite(video.duration) ? Math.min(video.duration, time) : time);
  const ranges = video.seekable;
  if (ranges?.length) {
    for (let i = 0; i < ranges.length; i++)
      if (target >= ranges.start(i) && target <= ranges.end(i)) return target;
    return null;
  }
  return Number.isFinite(video.duration) && video.duration > 0 ? target : null;
}
function stopForSettings() {
  nativeReturnError = '';
  // Pending handoff uses the latest switches/options when it completes.
  if (nativeReturn) return;
  if (session && !session.closed && !session.stats.native && (!enabled || session.hasPresented))
    returnToNative(session);
  else
    halt();
}
async function returnToNative(previous) {
  nativeReturn?.cancel();
  nativeReturnError = '';
  const video = previous.video;
  const resume = !video.paused || previous.preparing && previous.resumeSource ||
      previous.modelPreparing && previous.modelResumeSource ||
      previous.ending && !previous.completed && !previous.frozen;
  let cover = null;
  try {
    const frame = previous.cover ||
        (previous.layer?.tagName === 'CANVAS' || previous.layer?.readyState >= 2 ? previous.layer :
                                                                                   null);
    if (frame) {
      cover = document.createElement('canvas');
      cover.id = 'qute-motionflow-return';
      cover.width = frame.videoWidth || frame.width;
      cover.height = frame.videoHeight || frame.height;
      cover.style.cssText = frame.style.cssText;
      cover.style.display = 'block';
      cover.style.zIndex = '13';
      cover.style.pointerEvents = 'none';
      cover.getContext('2d', {alpha: false}).drawImage(frame, 0, 0);
      (previous.layerHost || previous.player).append(cover);
    }
  } catch {
    cover?.remove();
    cover = null;
  }
  let timer = 0, frameCallback = null;
  const pending = nativeReturn = {
    video,
    target: null,
    ignoreSeek: true,
    cancel() {
      if (nativeReturn !== pending) return;
      finish(true);
      if (resume && video.paused && !video.ended && video.isConnected) video.play().catch(() => {});
    }
  };
  const finish = (cancelled = false) => {
    if (nativeReturn !== pending) return;
    nativeReturn = null;
    browser.clearTimeout(timer);
    video.removeEventListener('seeked', ready);
    if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    cover?.remove();
    audio.releaseNative();
    if (!enabled) state = {state: 'off'};
    if (enabled && !cancelled)
      reconcile();
    else
      paint();
  };
  const fail = message => {
    nativeReturnError = message;
    pending.cancel();
    if (!enabled) state = {state: 'off', message};
    paint();
  };
  const ready = () => {
    if (nativeReturn !== pending) return;
    browser.clearTimeout(timer);
    if (typeof video.requestVideoFrameCallback === 'function')
      frameCallback = video.requestVideoFrameCallback(() => finish());
    // Some paused/occluded sources do not submit another compositor callback.
    timer = browser.setTimeout(() => finish(), 250);
    if (resume && video.paused && !video.ended) video.play().catch(error => fail(error.message));
  };
  audio.holdNative();
  previous.resumeSource = previous.modelResumeSource = false;
  video.pause();
  try {
    if (previous.hasPresented) await previous.freeze();
    if (nativeReturn !== pending) return;
    const target =
        nativeSeekTarget(video, previous.displayedMediaTime ?? previous.sourceMediaStart);
    halt({keepNativeReturn: true});
    if (enabled)
      state = {state: 'buffering', message: 'Preparing playback from the displayed frame'};
    if (target === null) {
      fail('This stream has no seekable buffer for the displayed frame.');
      return;
    }
    pending.target = target;
    previous.releasePlayerClock(target);
    video.addEventListener('seeked', ready, {once: true});
    timer = browser.setTimeout(() => fail('Returning to the original video took too long.'), 3000);
    if (Math.abs(video.currentTime - target) > .001)
      video.currentTime = target;
    else
      ready();
  } catch (error) {
    if (nativeReturn === pending) {
      halt({keepNativeReturn: true});
      fail(error.message);
    }
  }
}
function toggleComparison() {
  comparison = !comparison;
  if (comparison && enabled && state.state === 'error' && session?.closed) {
    halt();
    reconcile();
    return;
  }
  if (session) session.compare(comparison);
  paint();
}
function toggleSmoothnessPriority() {
  const before = playbackOptions();
  prioritizeSmoothness = !prioritizeSmoothness;
  const after = playbackOptions();
  if (enabled &&
      (before.upscaleMethod !== after.upscaleMethod || before.outputHeight !== after.outputHeight))
    stopForSettings();
  reconcile();
}
function toggleMono() {
  monoError =
      audio.setMono(element, !audio.monoEnabled) ? '' : 'Mono audio unavailable: ' + audio.note;
  paint();
}
function toggleDiagnostics() {
  diagnosticsVisible = !diagnosticsVisible;
  paint();
}
function toggleSmoothing() {
  smoothingEnabled = !smoothingEnabled;
  enabled = smoothingEnabled || upscaleEnabled;
  if (enabled) audio.unlock();
  stopForSettings();
  state = {state: enabled ? 'buffering' : 'off'};
  reconcile();
}
function selectProfile(id) {
  if (profileId === id) return;
  profileId = id;
  if (enabled) stopForSettings();
  reconcile();
}
function focusMenu(last = false) {
  const items = [...panel.querySelectorAll('button:not(:disabled)')];
  const selected = profileButtons.get(profileId);
  (last ? items.at(-1) : selected || items[0])?.focus();
}
function controls() {
  const bar = playerBar(owner);
  if (!bar) return;
  if (!optionsButton) {
    installControlStyle();
    optionsButton = makeButton('qute-motionflow-options', event => {
      if (!optionsOpen) owner.querySelector('.ytp-settings-button[aria-expanded="true"]')?.click();
      optionsOpen = !optionsOpen;
      paint();
      if (optionsOpen && event.detail === 0) focusMenu();
    });
    optionsButton.append(motionIcon('settings'));
    optionsButton.setAttribute('aria-haspopup', 'menu');
    optionsButton.setAttribute('aria-controls', 'qute-motionflow-panel');
    panel = document.createElement('div');
    panel.id = 'qute-motionflow-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'MotionFlow smoothing options');
    if (typeof panel.showPopover === 'function')
      panel.setAttribute('popover', 'manual');
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'input', 'change'])
      panel.addEventListener(type, () => {
        panelInteractionUntil = performance.now() + 1500;
      }, true);
    // Let editable controls keep native typing, selection and arrow behavior,
    // while preventing player keyboard shortcuts and click-to-pause handlers.
    for (const type of
             ['keydown', 'keypress', 'keyup', 'click', 'dblclick',
              'pointerdown'])
      panel.addEventListener(type, event => event.stopPropagation());
    const heading = document.createElement('div');
    heading.className = 'mf-heading';
    heading.textContent = 'MotionFlow';
    const profiles = document.createElement('div');
    profiles.className = 'mf-group mf-fps';
    profiles.setAttribute('role', 'group');
    profiles.setAttribute('aria-label', 'Playback profile');
    for (const id of Object.keys(PROFILES)) {
      const control = makeButton('qute-motionflow-profile-' + id, () => selectProfile(id), true);
      control.setAttribute('role', 'menuitemradio');
      const check = motionIcon('check');
      check.classList.add('mf-check');
      control.append(check,uiText('mf-label',id==='custom'?'Custom':PROFILES[id].maxFps+' fps'));
      profileButtons.set(id, control);
      profiles.append(control);
    }
    const customRow = document.createElement('label');
    customRow.className = 'mf-select-row';
    const customInput = document.createElement('input');
    customInput.id = 'qute-motionflow-custom-fps';
    customInput.type = 'number';
    customInput.min = '1';
    customInput.max = '240';
    customInput.step = 'any';
    customInput.value = customFps;
    customInput.setAttribute('aria-label', 'Custom target FPS, 1 to 240');
    customInput.title = 'Enter applies the target FPS. In qutebrowser normal mode, press i first to type.';
    customInput.addEventListener(
        'input', () => customInput.setCustomValidity(''));
    function commitCustomFps(event) {
      if (!acceptsInput(event)) return;
      const value = Number(customInput.value);
      if (!Number.isFinite(value) || value < 1 || value > 240) {
        customInput.setCustomValidity('Choose an FPS from 1 to 240');
        customInput.reportValidity();
        return;
      }
      customInput.setCustomValidity('');
      const changed = customFps !== value || profileId !== 'custom';
      customFps = value;
      profileId = 'custom';
      if (enabled && changed) stopForSettings();
      reconcile();
    }
    customInput.addEventListener('change', commitCustomFps);
    customInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitCustomFps(event);
      }
    });
    customRow.append(uiText('mf-label', 'Custom FPS'), customInput);
    smoothingButton = actionRow(
        'qute-motionflow-smoothing', 'motion', 'Motion smoothing',
        toggleSmoothing);
    smoothingButton.setAttribute('role', 'menuitemcheckbox');
    smoothingButton.append(uiText('mf-switch'));
    const performanceNote = document.createElement('div');
    performanceNote.className = 'mf-performance-note';
    performanceNote.hidden = true;
    aiButton = actionRow('qute-motionflow-ai', 'motion', 'AI engine', toggleAI);
    aiButton.setAttribute('role', 'menuitemcheckbox');
    aiButton.append(uiText('mf-switch'));
    const contentGroup = document.createElement('div');
    contentGroup.className = 'mf-content';
    contentGroup.setAttribute('role', 'group');
    contentGroup.setAttribute('aria-label', 'Video content');
    for (const [id, label] of Object.entries(CONTENTS)) {
      const control = makeButton('qute-motionflow-content-' + id, () => selectContent(id), true);
      control.setAttribute('role', 'menuitemradio');
      const check = motionIcon('check');
      check.classList.add('mf-check');
      control.append(check, uiText('', label));
      contentButtons.set(id, control);
      contentGroup.append(control);
    }
    const separator = document.createElement('div');
    separator.className = 'mf-separator';
    separator.setAttribute('role', 'separator');
    compareButton = actionRow('qute-motionflow-compare', 'compare', 'Compare', toggleComparison);
    compareButton.setAttribute('role', 'menuitemcheckbox');
    const toggle = uiText('mf-switch');
    toggle.setAttribute('aria-hidden', 'true');
    compareButton.append(toggle);
    const compareNote = uiText('mf-upscale-detail mf-compare-note');
    compareNote.setAttribute('role', 'status');
    compareNote.hidden = true;
    monoButton = actionRow('qute-motionflow-mono', 'audio', 'Mono audio', toggleMono);
    monoButton.setAttribute('role', 'menuitemcheckbox');
    const monoSwitch = uiText('mf-switch');
    monoSwitch.setAttribute('aria-hidden', 'true');
    monoButton.append(monoSwitch);
    const monoNote = uiText('mf-upscale-detail mf-mono-note');
    monoNote.setAttribute('role', 'status');
    monoNote.hidden = true;
    const returnNote = uiText('mf-upscale-detail mf-return-note');
    returnNote.setAttribute('role', 'status');
    returnNote.hidden = true;
    diagnosticButton =
        actionRow('qute-motionflow-diagnostics', 'diagnostics', 'Statistics', toggleDiagnostics);
    diagnosticButton.append(uiText('mf-switch'));
    const description = document.createElement('div');
    description.id = 'qute-motionflow-profile-info';
    description.className = 'mf-note';
    description.append(uiText('', 'Audio sync'), uiText('mf-delay'));
    const summary = document.createElement('div');
    summary.className = 'mf-summary';
    for (const [label, cls] of [
             ['Motion smoothing', 'mf-smoothing-state'], ['Upscaling', 'mf-upscale-state']]) {
      const row = document.createElement('div');
      row.append(uiText('', label), uiText(cls, 'Off'));
      summary.append(row);
    }
    const resolution = settingsSelect(
        'qute-motionflow-resolution', 'Resolution', RESOLUTIONS,
        value => changeOutput('resolution', value));
    const bufferChoice = settingsSelect(
        'qute-motionflow-buffer-choice', 'Buffer', BUFFER_CHOICES,
        value => changeOutput('buffer', value));
    const bufferMemory = settingsSelect(
        'qute-motionflow-buffer-memory', 'Frame memory', BUFFER_MEMORY_CHOICES,
        value => changeOutput('memory', value));
    bufferMemory.title =
        'Limit for queued video frames, allocated as needed. Higher values use more RAM; ' +
        'this does not reserve GPU VRAM. Total memory use can exceed this frame budget.';
    const upscale =
        actionRow('qute-motionflow-upscale', 'motion', 'Upscaling', () => changeOutput('upscale'));
    upscale.setAttribute('role', 'menuitemcheckbox');
    upscale.append(uiText('mf-switch'));
    const method = settingsSelect(
        'qute-motionflow-upscale-method', 'Upscaler', UPSCALE_METHODS,
        value => changeOutput('method', value));
    priorityButton = actionRow(
        'qute-motionflow-priority', 'motion', 'Prefer smoothness', toggleSmoothnessPriority);
    priorityButton.setAttribute('role', 'menuitemcheckbox');
    const prioritySwitch = uiText('mf-switch');
    prioritySwitch.setAttribute('aria-hidden', 'true');
    priorityButton.append(prioritySwitch);
    const priorityNote = uiText('mf-upscale-detail mf-priority-note');
    priorityNote.setAttribute('role', 'status');
    priorityNote.hidden = true;
    const upscaleDetail = document.createElement('div');
    upscaleDetail.className = 'mf-upscale-detail mf-upscale-description';
    const bufferView = document.createElement('div');
    bufferView.className = 'mf-buffer-view';
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = 0;
    progress.setAttribute('aria-label', 'Prepared video buffer');
    bufferView.append(uiText('mf-buffer-text'), progress);
    panel.append(
        heading, summary, bufferView, smoothingButton, profiles, customRow, performanceNote,
        resolution, upscale, method, upscaleDetail, priorityButton, priorityNote, bufferChoice,
        bufferMemory, separator, aiButton, contentGroup, compareButton, compareNote, monoButton,
        monoNote, diagnosticButton, description, returnNote);
    diagnosticOverlay = document.createElement('pre');
    diagnosticOverlay.id = 'qute-motionflow-diagnostic-overlay';
    diagnosticOverlay.hidden = true;
    diagnosticOverlay.setAttribute('aria-label', 'MotionFlow live statistics');
    bufferOverlay = document.createElement('div');
    bufferOverlay.id = 'qute-motionflow-buffer';
    bufferOverlay.hidden = true;
    const waiting = document.createElement('progress');
    waiting.max = 1;
    waiting.value = 0;
    waiting.setAttribute('aria-label', 'Preparing processed video');
    bufferOverlay.append(uiText(''), waiting);
    badge = document.createElement('div');
    badge.id = 'qute-motionflow-status';
  }
  if (optionsButton.parentElement !== bar) bar.prepend(optionsButton);
  if (panel.parentElement !== owner) owner.append(panel);
  if (badge.parentElement !== owner) owner.append(badge);
  if (diagnosticOverlay.parentElement !== owner) owner.append(diagnosticOverlay);
  if (bufferOverlay.parentElement !== owner) owner.append(bufferOverlay);
  const nativeMenu = owner.querySelector('.ytp-settings-menu');
  if (SITE === 'youtube' && nativeMenu) {
    const style = browser.getComputedStyle(nativeMenu);
    panel.style.backdropFilter = 'none';
    panel.style.borderRadius = style.borderRadius;
  }
  const v = element.getBoundingClientRect(), o = owner.getBoundingClientRect();
  const viewportWidth = browser.innerWidth,
        viewportHeight = browser.innerHeight;
  const panelWidth =
      Math.max(1, Math.min(326, o.width - 24, viewportWidth - 24));
  const panelLeft = Math.max(
      12, Math.min(o.right - panelWidth - 12, viewportWidth - panelWidth - 12));
  const panelTop = Math.max(12, o.top + 12);
  const panelBottom = Math.min(viewportHeight - 12, o.bottom - 58);
  Object.assign(panel.style, {
    width: panelWidth + 'px',
    left: panelLeft + 'px',
    right: 'auto',
    top: 'auto',
    bottom: Math.max(12, viewportHeight - panelBottom) + 'px',
    maxHeight: Math.max(48, panelBottom - panelTop) + 'px'
  });
  if (SITE !== 'youtube') {
    const left = v.left - o.left, top = v.top - o.top;
    Object.assign(bar.style, {
      left: (left + v.width - 60) + 'px',
      top: (top + 12) + 'px',
      right: 'auto',
      bottom: 'auto'
    });
    Object.assign(panel.style, {
      left:
          Math.max(
              12,
              Math.min(
                  v.right - panelWidth - 12, viewportWidth - panelWidth - 12)) +
          'px',
      top: Math.max(12, v.top + 58) + 'px',
      bottom: 'auto',
      maxHeight: Math.max(
                     48,
                     Math.min(v.bottom - 12, viewportHeight - 12) -
                         Math.max(12, v.top + 58)) +
          'px'
    });
    Object.assign(diagnosticOverlay.style, {left: (left + 12) + 'px', top: (top + 12) + 'px'});
    Object.assign(
        bufferOverlay.style,
        {left: (left + v.width / 2) + 'px', top: (top + v.height / 2) + 'px'});
  }
  paint();
}
function restartAfterWarmup(next) {
  const video = next.video, player = next.player;
  const time = Math.max(0, next.warmupRestartTime ?? next.sourceMediaStart);
  halt();
  video.pause();
  const pending = warmRestart = {video, player, time, ignoreSeek: true};
  if (SITE === 'youtube') player.classList.add('mf-clock-active');
  state = {state: 'buffering', message: 'GPU model ready · preparing playback'};
  paint();
  const resume = () => {
    if (warmRestart !== pending || !enabled || element !== video) return;
    browser.clearTimeout(warmRestartTimer);
    video.removeEventListener('seeked', resume);
    warmRestart = null;
    video.play().catch(error => {
      player.classList.remove('mf-clock-active');
      state = {state: 'error', message: error.message};
      paint();
    });
  };
  pending.cancel = () => video.removeEventListener('seeked', resume);
  if (Math.abs(video.currentTime - time) < .01 || (!Number.isFinite(video.duration) && !video.seekable.length))
    resume();
  else {
    video.addEventListener('seeked', resume, {once: true});
    warmRestartTimer = browser.setTimeout(resume, 2500);
    try {video.currentTime = time;} catch {resume();}
  }
}
async function launch(recoveryAttempt = 0) {
  nativeReturnError = '';
  const token = ++generation;
  const next = new PlaybackSession(element, owner, audio, update => {
    if (token !== generation) return;
    if (update.state === 'model-ready') {
      restartAfterWarmup(next);
      return;
    }
    state = next.ending && !next.completed && update.state !== 'error' ?
        {...update, state: 'finishing'} :
        update;
    if (update.state === 'error') {
      next.stop();
      state = update;
    }
    paint();
    const options = next.options;
    if (session === next && !nativeReturn && !next.closed && !next.preparing &&
        !next.modelPreparing && !next.frozen && !next.ending && !element.paused &&
        element.readyState >= 3 && !document.hidden && options.smoothnessPriority &&
        adaptiveQuality.sample({
          now: performance.now(),
          readyAt: next.readyAt ?? Infinity,
          fps: next.stats.passthrough ? Math.min(next.stats.sourceFps, options.maxFps) :
                                        options.maxFps,
          workMs: next.stats.native && adaptiveQuality.level > 0 ? .001 :
                                                                   next.stats.processingMsPerFrame,
          showing: next.showing,
          held: next.stats.heldFps,
          buffered: next.stats.bufferedMs,
          targetBuffer: next.stats.targetBufferMs,
          skipped: next.stats.skippedSources,
          deliveredFps: next.stats.deliveredFps,
          queued: next.stats.captureQueued
        })) {
      stopForSettings();
      reconcile();
    }
  }, playbackOptions());
  next.recoveryAttempt = recoveryAttempt;
  next.comparison = comparison;
  next.split = comparisonSplit;
  session = next;
  state = {state: 'buffering', message: 'MotionFlow · preparing renderer'};
  paint();
  try {
    await next.start();
  } catch (error) {
    if (token === generation) {
      next.stop();
      state = {state: 'error', message: error.message};
      paint();
    }
  }
}
function reconcile() {
  const nextKey = identity(), selection = nextKey ? videoSelection() : {};
  // Player quality/layout changes can temporarily hide or replace the source element.
  const retainSelection = key === nextKey && element?.isConnected && owner?.isConnected;
  const nextOwner = selection.player || (retainSelection ? owner : null),
        nextVideo = selection.video || (retainSelection ? element : null);
  if (key !== nextKey || element !== nextVideo || owner !== nextOwner) {
    const sameVideo = !!nextKey && key === nextKey;
    const wasOpen = optionsOpen;
    const wasMono = audio.monoEnabled;
    halt();
    if (key !== nextKey || element !== nextVideo) {
      audio.setMono(element, false);
      monoError = '';
    }
    adWatcher?.disconnect();
    observedPlayer = null;
    enabled = enabled && sameVideo;
    if (!enabled) smoothingEnabled = upscaleEnabled = false;
    optionsButton?.remove();
    panel?.remove();
    badge?.remove();
    diagnosticOverlay?.remove();
    bufferOverlay?.remove();
    diagnosticOverlay = bufferOverlay = null;
    optionsButton = panel = badge = null;
    browser.clearTimeout(statusTimer);
    statusKey = '';
    statusUntil = 0;
    smoothingButton = compareButton = monoButton = priorityButton = diagnosticButton = aiButton =
        null;
    contentButtons = new Map();
    profileButtons = new Map();
    optionsOpen = sameVideo && wasOpen;
    if (!sameVideo) {
      comparison = false;
      nativeReturnError = '';
    }
    panelInteractionUntil = sameVideo && wasOpen ? performance.now() + 1500 : 0;
    key = nextKey;
    element = nextVideo;
    owner = nextOwner;
    if (sameVideo && wasMono && nextVideo && !audio.monoEnabled)
      monoError = audio.setMono(nextVideo, true) ? '' : 'Mono audio unavailable: ' + audio.note;
    state = {state: 'off'};
  }
  if (!owner || !element) return;
  if (observedPlayer !== owner) {
    adWatcher?.disconnect();
    adWatcher = new MutationObserver(reconcile);
    adWatcher.observe(owner, {attributes: true, attributeFilter: ['class']});
    observedPlayer = owner;
  }
  controls();
  if (nativeReturn?.video === element) {
    if (document.hidden || document.pictureInPictureElement === element ||
        owner.classList.contains('ad-showing') || owner.classList.contains('ad-interrupting'))
      nativeReturn.cancel();
    else {
      paint();
      return;
    }
  }
  const blocked = document.hidden || document.pictureInPictureElement === element ||
      element.seeking || owner.classList.contains('ad-showing') ||
      owner.classList.contains('ad-interrupting');
  if (warmRestart?.video === element && !blocked) {
    paint();
    return;
  }
  if (enabled && session && !session.closed && !blocked) {
    if (session.modelPreparing) {
      paint();
      return;
    }
    if (element.ended && !session.stats.native) {
      session.finishSource();
      state = {...state, state: session.completed ? 'ended' : 'finishing'};
      paint();
      return;
    }
    if (session.stalled()) {
      const attempt = (session.recoveryAttempt || 0) + 1, previous = session;
      halt();
      if (attempt <= 2)
        launch(attempt);
      else {
        session = previous;
        state = {
          state: 'error',
          message: 'Frame delivery stalled repeatedly; toggle processing to retry.'
        };
      }
      paint();
      return;
    }
    if (session.preparing || (!element.paused && element.readyState < 3)) {
      paint();
      return;
    }
  }
  const reason = document.hidden                   ? 'Tab hidden' :
      document.pictureInPictureElement === element ? 'Picture-in-Picture' :
      element.paused                               ? 'Paused' :
      element.seeking                              ? 'Seeking' :
      element.ended                                ? 'Ended' :
      element.readyState < 3                       ? 'Buffering' :
      owner.classList.contains('ad-showing') || owner.classList.contains('ad-interrupting') ?
                               'Advertisement' :
                               '';
  if (enabled && reason === 'Paused' && session?.hasPresented && !session.closed &&
      !element.seeking && !element.ended && !owner.classList.contains('ad-showing') &&
      !owner.classList.contains('ad-interrupting')) {
    session.freeze();
    state = {...state, state: 'paused', message: 'Paused'};
    paint();
    return;
  }
  if (!enabled || reason) {
    if (session) halt();
    state = {state: enabled ? 'paused' : 'off', message: enabled ? reason : ''};
    paint();
    return;
  }
  if (session?.frozen || session?.freezing) halt();
  if (!session) launch();
}
for (const event
         of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'resize', 'loadeddata', 'canplay',
             'waiting', 'ended', 'emptied'])
  document.addEventListener(event, eventObject => {
    if (element && eventObject.target !== element) return;
    if (event === 'seeking' && nativeReturn?.video === element) {
      if (nativeReturn.ignoreSeek) {
        nativeReturn.ignoreSeek = false;
        return;
      }
      nativeReturn.cancel();
    }
    if (event === 'seeking' && warmRestart?.video === element && warmRestart.ignoreSeek) {
      warmRestart.ignoreSeek = false;
      reconcile();
      return;
    }
    if (event === 'resize' && nativeReturn?.video === element) {
      reconcile();
      return;
    }
    if (event === 'emptied' || event === 'seeking' || event === 'ratechange' || (event === 'resize' && neuralEnabled))
      halt();
    reconcile();
  }, true);
for (const event
         of ['yt-navigate-finish', 'visibilitychange', 'enterpictureinpicture',
             'leavepictureinpicture'])
  document.addEventListener(event, reconcile, true);
document.addEventListener('yt-navigate-start', () => {
  enabled = smoothingEnabled = upscaleEnabled = false;
  halt();
  paint();
});
browser.addEventListener('pagehide', () => {
  enabled = smoothingEnabled = upscaleEnabled = false;
  halt();
});
browser.addEventListener('popstate', reconcile);
for (const dismissEvent of ['pointerdown', 'click'])
  document.addEventListener(dismissEvent, event => {
    const path = event.composedPath();
    const inside = path.includes(panel) || path.includes(optionsButton);
    if (dismissEvent === 'pointerdown') pointerStartedInMenu = inside;
    if (dismissEvent === 'click' && event.detail > 0 && pointerStartedInMenu) return;
    if (optionsOpen && !inside) {
      optionsOpen = false;
      paint();
    }
  }, true);
document.addEventListener('keydown', event => {
  if (!optionsButton) return;
  if (optionsOpen && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    optionsOpen = false;
    paint();
    optionsButton.focus();
    return;
  }
  if (!optionsOpen && document.activeElement === optionsButton &&
      ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    optionsOpen = true;
    paint();
    focusMenu(event.key === 'ArrowUp');
    return;
  }
  if (!optionsOpen || !panel.contains(document.activeElement) ||
      ['SELECT', 'INPUT'].includes(document.activeElement?.tagName))
    return;
  const items = [...panel.querySelectorAll('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  const target = event.key === 'ArrowDown' ? items[(index + 1) % items.length] :
      event.key === 'ArrowUp'              ? items[(index - 1 + items.length) % items.length] :
      event.key === 'Home'                 ? items[0] :
      event.key === 'End'                  ? items.at(-1) :
                                             null;
  if (target) {
    event.preventDefault();
    event.stopPropagation();
    target.focus();
  }
}, true);
browser.addEventListener('resize', controlsIfPresent);
browser.addEventListener(
    'scroll', controlsIfPresent, {capture: true, passive: true});
document.addEventListener('fullscreenchange', controlsIfPresent);
function controlsIfPresent() {
  if (owner?.isConnected && element?.isConnected) controls();
}
browser.setInterval(reconcile, 750);
reconcile();
