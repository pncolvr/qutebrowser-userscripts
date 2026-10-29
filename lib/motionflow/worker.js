function motionWorker() {
  'use strict';
  const shaders = {
    vertex: `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
        uv = p * 0.5 + 0.5;
        gl_Position = vec4(p, 0.0, 1.0);
      }`,
    luma: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D image; out vec4 color;
      void main() {
        vec2 d = 0.5 / vec2(textureSize(image, 0));
        vec3 rgb = (texture(image, uv+d).rgb + texture(image, uv-d).rgb
          + texture(image, uv+vec2(d.x,-d.y)).rgb + texture(image, uv+vec2(-d.x,d.y)).rgb)*0.25;
        color = vec4(dot(rgb, vec3(0.2126,0.7152,0.0722)),0.0,0.0,1.0);
      }`,
    reduce: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D image; out vec4 color;
      void main() {
        vec2 d = 1.0 / vec2(textureSize(image,0)); float value = 0.0;
        for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
          float w = float((x==0?2:1)*(y==0?2:1));
          value += w*texture(image,uv+vec2(x,y)*d).r;
        }
        color = vec4(value/16.0,0.0,0.0,1.0);
      }`,
    solve: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D reference, following, estimate;
      uniform vec2 pixel; uniform float seedScale; uniform int hasSeed;
      out vec4 color;
      void main() {
        vec2 flow = hasSeed==1 ? texture(estimate,uv).xy*seedScale : vec2(0.0);
        float center=texture(reference,uv).r;
        float xx=0.0,xy=0.0,yy=0.0,bx=0.0,by=0.0,residual=0.0,weight=0.0;
        for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++) {
          vec2 a=uv+vec2(x,y)*pixel, b=a+flow*pixel;
          float r=texture(reference,a).r, s=texture(following,b).r;
          float gx=(texture(following,b+vec2(pixel.x,0.0)).r-texture(following,b-vec2(pixel.x,0.0)).r)*0.5;
          float gy=(texture(following,b+vec2(0.0,pixel.y)).r-texture(following,b-vec2(0.0,pixel.y)).r)*0.5;
          float e=s-r;
          // Robust residual and edge weights keep unrelated motion out of this window.
          float w=exp(-float(x*x+y*y)/4.5)*max(0.15,exp(-abs(r-center)*8.0))/sqrt(1.0+e*e/0.0064);
          xx+=w*gx*gx; xy+=w*gx*gy; yy+=w*gy*gy;
          bx+=w*gx*e; by+=w*gy*e; residual+=w*abs(e); weight+=w;
        }
        float reg=0.00003+0.001*(xx+yy); xx+=reg; yy+=reg;
        float determinant=xx*yy-xy*xy;
        vec2 update=vec2(-yy*bx+xy*by,xy*bx-xx*by)/max(determinant,1e-10);
        update*=min(1.0,1.5/max(length(update),1e-6));
        color=vec4(flow+update,residual/max(weight,1e-5),xx+yy);
      }`,
    regularize: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D field, guide; uniform vec2 pixel; out vec4 color;
      void main(){
        vec2 offsets[5]=vec2[5](vec2(0),vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1));
        vec4 center=texture(field,uv);float luminance=texture(guide,uv).r;
        vec2 flow[5];float weights[5];
        for(int i=0;i<5;i++){
          vec2 p=uv+offsets[i]*pixel;flow[i]=texture(field,p).xy;
          weights[i]=(i==0?1.0:0.75)*exp(-abs(texture(guide,p).r-luminance)*16.0);
        }
        // Select an existing neighbor vector rather than averaging across silhouettes.
        float best=1e20;vec2 selected=center.xy;
        for(int i=0;i<5;i++){
          float cost=0.0;
          for(int j=0;j<5;j++)cost+=weights[j]*length(flow[i]-flow[j]);
          if(cost<best){best=cost;selected=flow[i];}
        }
        color=vec4(selected,center.zw);
      }`,
    copy: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D image; out vec4 color;
      void main(){color=texture(image,uv);}`,
    cut: `#version 300 es
      precision highp float;
      uniform sampler2D a,b; out vec4 color;
      void main(){
        float difference=0.0;
        for(int y=0;y<4;y++)for(int x=0;x<4;x++) {
          vec2 p=(vec2(x,y)+0.5)/4.0;
          difference+=abs(texture(a,p).r-texture(b,p).r);
        }
        color=vec4(step(0.28,difference/16.0),0.0,0.0,1.0);
      }`,
    present: `#version 300 es
      precision highp float;
      in vec2 uv; uniform sampler2D a,b,forwardFlow,backwardFlow,cut;
      uniform vec2 inverseAnalysis; uniform float phase, split; uniform int interpolate, comparison;
      out vec4 color;
      void main(){
        // Source cadence is zero-order hold: keep A until B's timestamp.
        // Both comparison halves share this frame's presentation timestamp.
        if(comparison==1&&uv.x<split){color=phase<0.99999?texture(a,uv):texture(b,uv);return;}
        if(interpolate==0||phase>=0.99999){color=texture(b,uv);return;}
        if(phase<=0.00001||texture(cut,vec2(0.5)).r>0.5){color=texture(a,uv);return;}
        vec2 pa=uv, pb=uv;
        for(int i=0;i<5;i++){
          pa=mix(pa,uv-phase*texture(forwardFlow,pa).xy*inverseAnalysis,0.8);
          pb=mix(pb,uv-(1.0-phase)*texture(backwardFlow,pb).xy*inverseAnalysis,0.8);
        }
        vec2 f=texture(forwardFlow,pa).xy, r=texture(backwardFlow,pb).xy;
        vec2 endA=pa+f*inverseAnalysis,endB=pb+r*inverseAnalysis;
        vec3 imageA=texture(a,pa).rgb,imageB=texture(b,pb).rgb;
        float errA=length(f+texture(backwardFlow,endA).xy);
        float errB=length(r+texture(forwardFlow,endB).xy);
        float photoA=length(imageA-texture(b,endA).rgb);
        float photoB=length(imageB-texture(a,endB).rgb);
        float mapA=length((pa+phase*f*inverseAnalysis-uv)/inverseAnalysis);
        float mapB=length((pb+(1.0-phase)*r*inverseAnalysis-uv)/inverseAnalysis);
        vec2 dx=vec2(inverseAnalysis.x,0),dy=vec2(0,inverseAnalysis.y);
        vec2 ax=(texture(forwardFlow,pa+dx).xy-texture(forwardFlow,pa-dx).xy)*0.5;
        vec2 ay=(texture(forwardFlow,pa+dy).xy-texture(forwardFlow,pa-dy).xy)*0.5;
        vec2 bx=(texture(backwardFlow,pb+dx).xy-texture(backwardFlow,pb-dx).xy)*0.5;
        vec2 by=(texture(backwardFlow,pb+dy).xy-texture(backwardFlow,pb-dy).xy)*0.5;
        // Reject inverse mappings that fold or stretch a region excessively.
        float foldA=(1.0+phase*ax.x)*(1.0+phase*ay.y)-phase*phase*ax.y*ay.x;
        float q=1.0-phase;
        float foldB=(1.0+q*bx.x)*(1.0+q*by.y)-q*q*bx.y*by.x;
        float scaleA=1.5+0.06*length(f),scaleB=1.5+0.06*length(r);
        float ca=exp(-0.5*pow(errA/scaleA,2.0)-photoA*2.0-mapA*0.5);
        float cb=exp(-0.5*pow(errB/scaleB,2.0)-photoB*2.0-mapB*0.5);
        ca*=smoothstep(-0.1,0.15,foldA)*(1.0-smoothstep(4.0,8.0,foldA));
        cb*=smoothstep(-0.1,0.15,foldB)*(1.0-smoothstep(4.0,8.0,foldB));
        ca*=float(all(greaterThanEqual(pa,vec2(0)))&&all(lessThanEqual(pa,vec2(1)))&&all(greaterThanEqual(endA,vec2(0)))&&all(lessThanEqual(endA,vec2(1))));
        cb*=float(all(greaterThanEqual(pb,vec2(0)))&&all(lessThanEqual(pb,vec2(1)))&&all(greaterThanEqual(endB,vec2(0)))&&all(lessThanEqual(endB,vec2(1))));
        float reliability=max(ca,cb);
        ca=max(ca,0.005);cb=max(cb,0.005);
        float wa=(1.0-phase)*ca,wb=phase*cb;
        if(ca>cb*3.0)wb=0.0;
        if(cb>ca*3.0)wa=0.0;
        vec3 warped=(imageA*wa+imageB*wb)/max(wa+wb,1e-6);
        // Preserve ordinary motion; fall back locally only for unreliable large warps.
        float normalizedMotion=max(length(f),length(r))*320.0*inverseAnalysis.x;
        float trust=mix(1.0,smoothstep(0.004,0.025,reliability),smoothstep(16.0,24.0,normalizedMotion));
        vec3 rawA=texture(a,uv).rgb,rawB=texture(b,uv).rgb;
        // Keep unchanged backgrounds/text stable without erasing a moving silhouette.
        float unchanged=max(length(rawA-rawB),max(length(texture(a,uv+dx).rgb-texture(b,uv+dx).rgb),length(texture(a,uv+dy).rgb-texture(b,uv+dy).rgb)));
        if(unchanged<0.006&&(length(f)+length(r)<8.0||max(length(imageA-rawA),length(imageB-rawB))<0.20)){color=vec4(rawA,1.0);return;}
        color=vec4(mix(rawA,warped,trust),1.0);
      }`,
  };

  class Program {
    constructor(gl, fragment) {
      this.gl = gl;
      this.locations = new Map();
      this.program = gl.createProgram();
      for (const [kind, source] of [
               [gl.VERTEX_SHADER, shaders.vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(kind);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const stage = kind === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment';
          const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
          gl.deleteShader(shader);
          gl.deleteProgram(this.program);
          throw new Error(stage + ' shader compilation failed: ' + log);
        }
        gl.attachShader(this.program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(this.program));
    }
    use() {
      this.gl.useProgram(this.program);
      return this;
    }
    location(key) {
      if (!this.locations.has(key))
        this.locations.set(key, this.gl.getUniformLocation(this.program, key));
      return this.locations.get(key);
    }
    number(key, value) {
      this.gl.uniform1f(this.location(key), value);
      return this;
    }
    integer(key, value) {
      this.gl.uniform1i(this.location(key), value);
      return this;
    }
    vector(key, x, y) {
      this.gl.uniform2f(this.location(key), x, y);
      return this;
    }
    texture(key, target, unit) {
      const g = this.gl;
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, target.texture);
      return this.integer(key, unit);
    }
    draw(target, width, height) {
      const g = this.gl;
      g.bindFramebuffer(g.FRAMEBUFFER, target?.framebuffer || null);
      g.viewport(0, 0, target?.width || width, target?.height || height);
      g.drawArrays(g.TRIANGLES, 0, 3);
    }
  }

  class Interpolator {
    constructor(canvas, options) {
      canvas.addEventListener(
          'webglcontextlost',
          () => self.postMessage(
              {type: 'error', message: 'GPU context lost; original playback restored.'}));
      this.canvas = canvas;
      this.options = options;
      this.pool = [];
      this.serial = 0;
      this.closed = false;
      const g = canvas.getContext(
          'webgl2',
          {antialias: false, depth: false, stencil: false, powerPreference: 'high-performance'});
      if (!g) throw new Error('Worker WebGL2 is unavailable.');
      if (!g.getExtension('EXT_color_buffer_float'))
        throw new Error('Floating-point render targets are unavailable.');
      g.getExtension('OES_texture_float_linear');
      this.gl = g;
      g.disable(g.DITHER);
      g.disable(g.DEPTH_TEST);
      g.disable(g.BLEND);
      g.bindVertexArray(g.createVertexArray());
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
      const info = g.getExtension('WEBGL_debug_renderer_info');
      this.renderer =
          info ? g.getParameter(info.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      this.programs = Object.fromEntries(Object.entries(shaders)
                                             .filter(([name]) => name !== 'vertex')
                                             .map(([name, code]) => [name, new Program(g, code)]));
    }
    target(width, height, floating = false, luma = false) {
      const g = this.gl, texture = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, texture);
      g.texStorage2D(g.TEXTURE_2D, 1, floating ? g.RGBA16F : luma ? g.R8 : g.RGBA8, width, height);
      for (const key of [g.TEXTURE_MIN_FILTER, g.TEXTURE_MAG_FILTER])
        g.texParameteri(g.TEXTURE_2D, key, g.LINEAR);
      for (const key of [g.TEXTURE_WRAP_S, g.TEXTURE_WRAP_T])
        g.texParameteri(g.TEXTURE_2D, key, g.CLAMP_TO_EDGE);
      const framebuffer = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, framebuffer);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
      if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE)
        throw new Error('GPU target allocation failed.');
      return {texture, framebuffer, width, height};
    }
    configure(width, height) {
      if (this.inputWidth === width && this.inputHeight === height) return;
      this.releaseTargets();
      this.inputWidth = width;
      this.inputHeight = height;
      const scale = Math.min(
          1, this.options.outputWidth / width, (this.options.outputHeight || Infinity) / height);
      this.width = Math.max(2, Math.round(width * scale));
      this.height = Math.max(2, Math.round(height * scale));
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.capture = new OffscreenCanvas(this.width, this.height);
      this.captureContext = this.capture.getContext('2d', {alpha: false, desynchronized: true});
      this.sizes = [];
      let w = Math.min(this.options.analysisWidth, this.width),
          h = Math.max(16, Math.round(w * this.height / this.width));
      // Reach the same coarse scale at 640-pixel analysis as at smaller sizes.
      for (let level = 0; level < 6; level++) {
        this.sizes.push([w, h]);
        if (w <= 32 || h <= 16) break;
        w = Math.ceil(w / 2);
        h = Math.ceil(h / 2);
      }
      this.scratch = this.sizes.map(([x, y]) => [this.target(x, y, true), this.target(x, y, true)]);
      this.zero = this.target(1, 1, true);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.zero.framebuffer);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      const [aw, ah] = this.sizes[0];
      this.pool = Array.from(
          {length: this.options.capacity},
          () => ({
            color: this.target(this.width, this.height),
            pyramid: this.sizes.map(([x, y]) => this.target(x, y, false, true)),
            forward: this.target(aw, ah, true),
            backward: this.target(aw, ah, true),
            cut: this.target(1, 1),
          }));
      this.serial = 0;
    }
    solve(a, b, destination) {
      let seed = this.zero;
      for (let level = this.sizes.length - 1; level >= 0; level--) {
        const [w, h] = this.sizes[level], temporary = this.scratch[level];
        for (let step = 0; step < (level === this.sizes.length - 1 ? 6 : 4); step++) {
          const out = temporary[step % 2];
          this.programs.solve.use()
              .texture('reference', a.pyramid[level], 0)
              .texture('following', b.pyramid[level], 1)
              .texture('estimate', seed, 2)
              .vector('pixel', 1 / w, 1 / h)
              .number('seedScale', seed === this.zero ? 1 : w / seed.width)
              .integer('hasSeed', seed === this.zero ? 0 : 1)
              .draw(out);
          seed = out;
        }
        const filtered = seed === temporary[0] ? temporary[1] : temporary[0];
        this.programs.regularize.use()
            .texture('field', seed, 0)
            .texture('guide', a.pyramid[level], 1)
            .vector('pixel', 1 / w, 1 / h)
            .draw(filtered);
        seed = filtered;
      }
      this.programs.copy.use().texture('image', seed, 0).draw(destination);
    }
    accept(frame, previous, time) {
      const begin = performance.now();
      this.configure(frame.displayWidth, frame.displayHeight);
      const slot = this.pool[this.serial++ % this.pool.length];

      const g = this.gl;
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, slot.color.texture);
      if (this.width === frame.displayWidth && this.height === frame.displayHeight) {
        // Native-size VideoFrames can be uploaded without the 2D scaling copy.
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, g.RGBA, g.UNSIGNED_BYTE, frame);
      } else {
        this.captureContext.drawImage(frame, 0, 0, this.width, this.height);
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, g.RGBA, g.UNSIGNED_BYTE, this.capture);
      }
      const uploaded = performance.now();
      for (let level = 0; level < this.sizes.length; level++) {
        this.programs[level ? 'reduce' : 'luma']
            .use()
            .texture('image', level ? slot.pyramid[level - 1] : slot.color, 0)
            .draw(slot.pyramid[level]);
      }
      const result = {slot, time, paired: false};
      if (previous && previous.slot !== slot) {
        this.solve(previous.slot, slot, slot.forward);
        this.solve(slot, previous.slot, slot.backward);
        this.programs.cut.use()
            .texture('a', previous.slot.pyramid.at(-1), 0)
            .texture('b', slot.pyramid.at(-1), 1)
            .draw(slot.cut);
        result.paired = true;
      }
      g.flush();
      this.uploadMs = uploaded - begin;
      this.computeMs = performance.now() - uploaded;
      return result;
    }
    render(left, right, phase, comparison = false, split = .5) {
      const [aw, ah] = this.sizes[0];
      this.programs.present.use()
          .texture('a', left.slot.color, 0)
          .texture('b', right.slot.color, 1)
          .texture('forwardFlow', right.slot.forward, 2)
          .texture('backwardFlow', right.slot.backward, 3)
          .texture('cut', right.slot.cut, 4)
          .vector('inverseAnalysis', 1 / aw, 1 / ah)
          .number('phase', phase)
          .number('split', split)
          .integer('comparison', comparison ? 1 : 0)
          .integer('interpolate', left !== right && right.paired ? 1 : 0)
          .draw(null, this.width, this.height);
    }
    snapshot() {
      const pixels = new Uint8Array(this.width * this.height * 4);
      const g = this.gl;
      g.readPixels(0, 0, this.width, this.height, g.RGBA, g.UNSIGNED_BYTE, pixels);
      return pixels;
    }
    releaseTargets() {
      if (!this.gl) return;
      const targets = this.pool.flatMap(p => [p.color, ...p.pyramid, p.forward, p.backward, p.cut]);
      if (this.scratch) targets.push(...this.scratch.flat());
      if (this.zero) targets.push(this.zero);
      for (const t of targets) {
        this.gl.deleteFramebuffer(t.framebuffer);
        this.gl.deleteTexture(t.texture);
      }
      this.pool = [];
      this.scratch = null;
      this.zero = null;
    }
    dispose() {
      this.closed = true;
      this.releaseTargets();
    }
  }

  class Timeline {
    constructor(delay, capacity = 12) {
      this.delay = delay;
      this.capacity = capacity;
      this.frames = [];
      this.offset = null;
      this.offsets = [];
      this.intervals = [];
      this.started = false;
    }
    add(frame, arrival) {
      const last = this.frames.at(-1);
      if (last && frame.time <= last.time) return false;
      if (last) {
        const d = frame.time - last.time;
        if (d > 1 && d < 1000) {
          this.intervals.push(d);
          if (this.intervals.length > 60) this.intervals.shift();
        }
      }
      this.frames.push(frame);
      if (this.frames.length > this.capacity) this.frames.shift().original?.close();
      this.offsets.push(arrival - frame.time);
      if (this.offsets.length > 60) this.offsets.shift();
      const best = Math.min(...this.offsets);
      if (this.offset === null || !this.started)
        this.offset = best;
      else
        this.offset += Math.max(-0.05, Math.min(0.05, best - this.offset));
      return true;
    }
    frequency() {
      if (!this.intervals.length) return 0;
      const values = [...this.intervals].sort((a, b) => a - b);
      return 1000 / values[Math.floor(values.length / 2)];
    }
    at(wall) {
      if (this.offset === null || this.frames.length < 2) return null;
      const time = wall - this.offset - this.delay, first = this.frames[0],
            last = this.frames.at(-1);
      if (time < first.time) return null;
      this.started = true;
      if (time >= last.time) return {left: last, right: last, phase: 1, held: true};
      for (let i = 1; i < this.frames.length; i++)
        if (time <= this.frames[i].time) {
          const left = this.frames[i - 1], right = this.frames[i];
          return {left, right, phase: (time - left.time) / (right.time - left.time), held: false};
        }
      return null;
    }
  }

  let gpu = null, timeline = null, reader = null, port = null, active = false, manual = false,
      firstTimestamp = null, lastArrival = null, captureClockResets = 0;
  let framesReceived = 0, bootOptions = null, lastReport = 0, nextOutputTime = 0;
  let sourcePeriods = [], lastSourceTime = null, native = false, generationMs = 0, decodedFps = 0;
  let rateLimited = false, rateSkipped = 0, cappedTail = null, capOffset = null;
  let capCanvas = null, capContext = null, capWidth = 0, capHeight = 0;
  const defaults = {
    outputWidth: 1280,
    analysisWidth: 640,
    capacity: 3,
    delayMs: 220,
    maxFps: 60,
    comparison: false,
    split: .5
  };
  function captureFps() {
    const sorted = [...sourcePeriods].sort((a, b) => a - b);
    return sorted.length ? 1000 / sorted[Math.floor(sorted.length / 2)] : 0;
  }
  function sourceFps() {
    return decodedFps || captureFps();
  }
  function report(id) {
    self.postMessage({
      type: 'producer-stats',
      requestId: id,
      sourceFps: sourceFps(),
      captureFps: captureFps(),
      framesReceived,
      captureClockResets,
      rateLimited,
      rateSkipped,
      outputFps: rateLimited ? bootOptions.maxFps : sourceFps(),
      passthrough: rateLimited || native,
      uploadMs: gpu?.uploadMs || 0,
      computeMs: gpu?.computeMs || 0,
      generationMs,
      renderer: gpu?.renderer || '',
      width: rateLimited ? capWidth : gpu?.width || 0,
      height: rateLimited ? capHeight : gpu?.height || 0
    });
    lastReport = performance.now();
  }
  function reset() {
    cappedTail?.frame.close();
    cappedTail = null;
    capOffset = null;
    for (const item of timeline?.frames || []) item.original?.close();
    timeline = new Timeline(bootOptions.delayMs, bootOptions.capacity);
    nextOutputTime = null;
    port?.postMessage({type: 'reset'});
  }
  function emitCapped(frame, time, arrival) {
    const original = bootOptions.comparisonInPresenter ? new VideoFrame(frame) : null;
    let output;
    if (bootOptions.resize &&
        (frame.displayWidth !== bootOptions.outputWidth ||
         frame.displayHeight !== bootOptions.outputHeight)) {
      capCanvas ||= new OffscreenCanvas(bootOptions.outputWidth, bootOptions.outputHeight);
      capContext ||= capCanvas.getContext('2d', {alpha: false});
      capContext.imageSmoothingEnabled = true;
      capContext.imageSmoothingQuality = 'high';
      capContext.drawImage(frame, 0, 0, capCanvas.width, capCanvas.height);
      output = new VideoFrame(capCanvas, {timestamp: Math.round(time * 1000)});
    } else
      output = new VideoFrame(frame, {timestamp: Math.round(time * 1000)});
    if (capOffset === null || !timeline.started)
      capOffset = Math.min(capOffset ?? Infinity, arrival - time);
    capWidth = output.displayWidth;
    capHeight = output.displayHeight;
    const item = {frame: output, original, time, originalTime: time, generated: false};
    try {
      port.postMessage(
          {type: 'batch', clockOrigin: performance.timeOrigin + capOffset, frames: [item]},
          [output, original].filter(Boolean));
    } catch (error) {
      output.close();
      original?.close();
      throw error;
    }
  }
  function ingest(frame) {
    try {
      if (!active) return;
      const arrival = performance.now();
      if (firstTimestamp === null) firstTimestamp = frame.timestamp;
      let time = (frame.timestamp - firstTimestamp) / 1000;
      const elapsed = lastArrival === null ? 0 : arrival - lastArrival;
      if (!manual && lastSourceTime !== null &&
          (time - lastSourceTime < -50 || time - lastSourceTime > Math.max(1000, elapsed + 500))) {
        time = lastSourceTime + Math.max(1, elapsed);
        firstTimestamp = frame.timestamp - time * 1000;
        captureClockResets++;
      }
      lastArrival = arrival;
      if (lastSourceTime !== null && time > lastSourceTime) {
        sourcePeriods.push(time - lastSourceTime);
        if (sourcePeriods.length > 45) sourcePeriods.shift();
      }
      lastSourceTime = time;
      framesReceived++;
      const capped = !manual && sourceFps() > bootOptions.maxFps / .98;
      if (capped !== rateLimited) {
        rateLimited = capped;
        native = false;
        reset();
        if (capped) port.postMessage({type: 'cadence', fps: bootOptions.maxFps});
      }
      if (sourcePeriods.length >= 12 && !manual && !rateLimited) {
        const enough = bootOptions.interpolation === false || sourceFps() >= bootOptions.maxFps * .98;
        if (enough !== native) {
          native = enough;
          reset();
          if (native) port.postMessage({type: 'native'});
        }
      }
      if (native) {
        if (performance.now() - lastReport >= 1000) report();
        return;
      }
      if (rateLimited) {
        const step = 1000 / bootOptions.maxFps;
        if (nextOutputTime !== null && time < nextOutputTime - .001) {
          rateSkipped++;
          cappedTail?.frame.close();
          cappedTail = {frame: new VideoFrame(frame), time, arrival};
          return;
        }
        cappedTail?.frame.close();
        cappedTail = null;
        nextOutputTime = (Math.floor((time + .001) / step) + 1) * step;
        emitCapped(frame, time, arrival);
        if (performance.now() - lastReport >= 1000) report();
        return;
      }
      if (gpu.inputWidth &&
          (gpu.inputWidth !== frame.displayWidth || gpu.inputHeight !== frame.displayHeight))
        reset();
      let previous = timeline.frames.at(-1);
      if (previous && time <= previous.time) return;
      if (previous && time - previous.time > 350) {
        reset();
        previous = null;
      }
      const image = gpu.accept(frame, previous, time);
      if (bootOptions.comparisonInPresenter) image.original = new VideoFrame(frame);
      timeline.add(image, arrival);
      if (!manual && previous) {
        const frames = [], interval = 1000 / bootOptions.maxFps, started = performance.now();
        if (nextOutputTime === null)
          nextOutputTime = Math.ceil(previous.time / interval) * interval;
        while (nextOutputTime <= time + .001) {
          const phase =
              Math.max(0, Math.min(1, (nextOutputTime - previous.time) / (time - previous.time)));
          gpu.render(
              previous, image, phase, !bootOptions.comparisonInPresenter && bootOptions.comparison,
              bootOptions.split);
          const original = (phase >= .99999 ? image.original : previous.original);
          frames.push({
            original: original ? new VideoFrame(original) : null,
            frame: new VideoFrame(gpu.canvas, {timestamp: Math.round(nextOutputTime * 1000)}),
            time: nextOutputTime,
            generated: phase > .001 && phase < .999,
            comparison: bootOptions.comparison,
            split: bootOptions.split,
            originalTime: phase >= .99999 ? image.time : previous.time
          });
          nextOutputTime += interval;
        }
        generationMs = performance.now() - started;
        port.postMessage(
            {type: 'batch', clockOrigin: performance.timeOrigin + timeline.offset, frames},
            frames.flatMap(item => [item.frame, item.original].filter(Boolean)));
      }
      if (performance.now() - lastReport >= 1000) report();
    } finally {
      frame.close();
    }
  }
  async function consume(stream) {
    reader = stream.getReader();
    try {
      while (active) {
        const {value, done} = await reader.read();
        if (done) break;
        ingest(value);
      }
    } catch (error) {
      if (active) self.postMessage({type: 'error', message: String(error), stack: error.stack});
    } finally {
      if (active && port) {
        if (rateLimited && cappedTail) {
          emitCapped(cappedTail.frame, cappedTail.time, cappedTail.arrival);
          rateSkipped--;
          cappedTail.frame.close();
          cappedTail = null;
        }
        const image = timeline.frames.at(-1), interval = 1000 / bootOptions.maxFps;
        if (!native && image && nextOutputTime - interval < image.time - .001) {
          gpu.render(image, image, 0, false);
          const frame = new VideoFrame(gpu.canvas, {timestamp: Math.round(image.time * 1000)});
          const original = image.original ? new VideoFrame(image.original) : null;
          port.postMessage(
              {
                type: 'batch',
                clockOrigin: performance.timeOrigin + timeline.offset,
                frames: [
                  {frame, original, time: image.time, originalTime: image.time, generated: false}
                ]
              },
              [frame, original].filter(Boolean));
        }
        port.postMessage({
          type: 'end',
          time: (lastSourceTime || 0) + 1000 / (sourceFps() || bootOptions.maxFps)
        });
      }
    }
  }
  self.onmessage = async ({data}) => {
    try {
      if (data.type === 'comparison') {
        if (bootOptions) {
          bootOptions.comparison = !!data.enabled;
          if (Number.isFinite(data.split))
            bootOptions.split = Math.max(.02, Math.min(.98, data.split));
        }
      } else if (data.type === 'cadence') {
        if (Number.isFinite(data.fps) && data.fps > 0) decodedFps = data.fps;
      } else if (data.type === 'start') {
        bootOptions = {...defaults, ...data.options};
        manual = !!data.manual;
        port = data.port || null;
        if (port)
          port.onmessage = ({data: message}) => {
            if (message.type === 'playout-started') timeline.started = true;
          };
        gpu = new Interpolator(data.canvas || new OffscreenCanvas(2, 2), bootOptions);
        timeline = new Timeline(bootOptions.delayMs, bootOptions.capacity);
        active = true;
        lastReport = performance.now();
        self.postMessage({type: 'ready', renderer: gpu.renderer});
        if (data.stream) consume(data.stream);
      } else if (data.type === 'finish') {
        await reader?.cancel();
      } else if (data.type === 'stop') {
        active = false;
        cappedTail?.frame.close();
        cappedTail = null;
        try {
          await reader?.cancel();
        } catch {
        }
        port?.close();
        for (const item of timeline?.frames || []) item.original?.close();
        gpu?.dispose();
      } else if (data.type === 'frame') {
        ingest(data.frame);
        self.postMessage(
            {type: 'accepted', id: data.id, offset: timeline.offset, delay: timeline.delay});
      } else if (data.type === 'render') {
        const pair = timeline.at(data.wall);
        if (!pair) throw new Error('Requested time is outside buffered history.');
        gpu.render(
            pair.left, pair.right, pair.phase, data.comparison ?? bootOptions.comparison,
            data.split ?? bootOptions.split);
        const pixels = gpu.snapshot();
        const glError = gpu.gl.getError();
        if (glError !== gpu.gl.NO_ERROR) throw new Error('WebGL error ' + glError);
        self.postMessage(
            {
              type: 'pixels',
              id: data.id,
              width: gpu.width,
              height: gpu.height,
              phase: pair.phase,
              held: pair.held,
              originalTime: pair.phase >= .99999 ? pair.right.time : pair.left.time,
              pixels
            },
            [pixels.buffer]);
      } else if (data.type === 'snapshot')
        report(data.id);
    } catch (error) {
      self.postMessage({type: 'error', message: String(error), stack: error.stack});
    }
  };
  self.postMessage({type: 'boot'});
}
