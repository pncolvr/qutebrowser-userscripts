// Test-only instrumentation runs in the same isolated world as the userscript.
(() => {
  const w = document.defaultView, RealAudio = w.AudioContext;
  if (w.location.search.includes('unsupported')) w.MediaStreamTrackGenerator = undefined;
  const counter = {workers: 0, workerURLsTrusted: true, audioSources: 0, closedCaptures: []};
  w.__motionFlowCounters = counter;
  w.AudioContext = class extends RealAudio {
    constructor(options) {
      super(options);
      Object.defineProperty(this, 'destination', {value: this.createMediaStreamDestination()});
    }
    createMediaElementSource(video) {
      counter.audioSources++;
      return super.createMediaElementSource(video);
    }
  };
  w.__motionFlowWrapWorker = RealWorker => class extends RealWorker {
    constructor(...args) {
      counter.workerURLsTrusted &&= !w.trustedTypes || w.trustedTypes.isScriptURL(args[0]);
      super(...args);
      this.__closed = false;
      counter.workers++;
    }
    postMessage(message, ...args) {
      if (w.location.search.includes('transfer-error') && message.type === 'start' &&
          message.stream)
        throw new Error('Simulated stream transfer failure');
      return super.postMessage(message, ...args);
    }
    terminate() {
      if (!this.__closed) {
        counter.workers--;
        this.__closed = true;
      }
      return super.terminate();
    }
  };
  w.Worker = w.__motionFlowWrapWorker(w.Worker);
})();
