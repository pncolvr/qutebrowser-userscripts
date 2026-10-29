"""Offline MotionFlow integration and GPU tests; requires qutebrowser/PyQt6 and ffmpeg.

Uses a loopback server, an in-memory browser profile, generated video, and an
in-memory audio destination. No test audio is played through the speakers.
"""
import argparse
import base64
import binascii
import functools
import hashlib
import http.server
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

os.environ['QT_QPA_PLATFORM']='offscreen'
os.environ.setdefault('QTWEBENGINE_CHROMIUM_FLAGS','--no-sandbox --autoplay-policy=no-user-gesture-required --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader')
from qutebrowser.browser import greasemonkey
from qutebrowser.misc import objects
from qutebrowser.utils import usertypes
from PyQt6.QtCore import QTimer,QUrl,QRect,QPoint,Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication
from PyQt6.QtWebEngineCore import QWebEnginePage,QWebEngineProfile,QWebEngineScript,QWebEngineSettings
from PyQt6.QtWebEngineWidgets import QWebEngineView

HOOK = '''
acceptsInput=()=>true;
neuralEnabled=browser.location.search.includes('neural');
if(browser.location.search.includes('animation'))contentId='animation';
if(browser.location.search.includes('gameplay'))contentId='gameplay';
paint();
const baseStart=PlaybackSession.prototype.start;
PlaybackSession.prototype.start=function(){const notify=this.notify;this.notify=update=>{if(update.message==='Preparing GPU model'){const c=browser.__motionFlowCounters;c.warmups=(c.warmups||0)+1;c.warmPaused=c.warmPaused!==false&&this.video.paused}notify(update)};this.options=Object.freeze({...this.options,helperUrl:this.options.helperUrl||'ws://127.0.0.1:8770/v1'});return baseStart.call(this)};
if(browser.location.search.includes('neural-offline')){
 const realStart=PlaybackSession.prototype.start;
 PlaybackSession.prototype.start=function(){this.options=Object.freeze({...this.options,helperUrl:'ws://127.0.0.1:8770/missing'});return realStart.call(this)};
}
const originalHost=PlaybackSession.prototype.createWorkerHost;
PlaybackSession.prototype.createWorkerHost=async function(){if(browser.location.search.includes('controls'))await new Promise(resolve=>browser.setTimeout(resolve,220));return browser.__motionFlowWrapWorker(await originalHost.call(this))};
const originalStop=PlaybackSession.prototype.stop;
PlaybackSession.prototype.stop=function(){originalStop.call(this);browser.__motionFlowCounters.closedCaptures.push(this.capture?.getTracks().filter(t=>t.readyState==='live').length||0)};
let testAnalyser=null,testRoute=null;
browser.addEventListener('error',event=>console.log('SCRIPT_ERROR:'+event.error?.stack));
browser.addEventListener('message',event=>{
 if(event.data?.type!=='motionflow-test')return;
 if(event.data.action==='stall-presenter')session?.presenter?.postMessage({type:'pause'});
 if(event.data.action==='stall-output')session?.layer?.pause();
 if(event.data.action==='warm-up-model'){const producer=session.producer;producer.onmessage({data:{type:'model-preparing',active:true}});browser.setTimeout(()=>producer.onmessage({data:{type:'model-preparing',active:false}}),180);}
 if(event.data.action==='fail-output')session?.notify({state:'error',message:'Simulated output decoder failure'});
 const c=browser.__motionFlowCounters,r=audio.current;
 let rms=0;
 if(event.data.action==='panel-idle'){document.activeElement?.blur();panelInteractionUntil=0;}
 if(event.data.action==='audio'&&r?.active){
  if(testRoute!==r){testAnalyser=audio.context.createAnalyser();testAnalyser.fftSize=2048;r.delay.connect(testAnalyser);testRoute=r;}
  const samples=new Float32Array(2048);testAnalyser.getFloatTimeDomainData(samples);
  rms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);
 }
 browser.postMessage({type:'motionflow-test-reply',id:event.data.id,result:{
  input:{rate:element?.playbackRate,time:element?.currentTime,ready:element?.readyState,paused:element?.paused},
  enabled,state,session:session?{recoveryAttempt:session.recoveryAttempt,preparing:!!session.preparing,ending:!!session.ending,completed:!!session.completed,videoDrained:!!session.videoDrained,frozen:!!session.frozen,showing:session.showing,displayedComparison:session.displayedComparison,comparison:session.comparison,comparisonRevision:session.comparisonRevision,displayedMediaTime:session.displayedMediaTime,stats:session.stats}:null,
  nativeReturn:nativeReturn?{target:nativeReturn.target}:null,
  audio:{active:!!r?.active,mono:audio.monoEnabled,nativeHeld:audio.nativeHeld,delayMs:audio.delayMs,note:audio.note,state:audio.context?.state},
  modelPreparation:{count:c.warmups||0,paused:c.warmPaused!==false},workers:c.workers,workerURLsTrusted:c.workerURLsTrusted,audioSources:c.audioSources,closedCaptures:c.closedCaptures,rms,
  hosts:document.querySelectorAll('#qute-motionflow-worker-host').length,hostType:session?.workerHost?.contentDocument?.contentType,
  profileId,neuralEnabled,contentId,options:session?{...session.options,authToken:session.options.authToken?'(paired)':''}:null,cadence:session?.sourceCadence,capture:session?.captureTrack?.getSettings(),captureConstraintNote:session?.captureConstraintNote,
  rejectedWorkerURL:(()=>{try{workerPolicy?.createScriptURL('https://example.invalid/untrusted.js');return false}catch{return true}})(),
 }},'*');
});
'''

class Files(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/watch'):
            self.nonce_policy='test24' in self.path
            self.server.invalid_host='host-invalid' in self.path
            self.path='/custom-player.html' if any(case in self.path for case in ('upscale','generic')) else '/player.html'
        if self.path=='/robots.txt' and getattr(self.server,'invalid_host',False):
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers()
            self.wfile.write(b'<p>Unexpected HTML</p>');return
        if self.path in ('/sample24.webm', '/sample30.webm'):
            self.video_range()
            return
        super().do_GET()

    def video_range(self):
        # Native handoff seeks must exercise a real byte-range-capable media source.
        file = Path(self.translate_path(self.path))
        size = file.stat().st_size
        start, end = 0, size - 1
        requested = self.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            if match and any(match.groups()):
                first, last = match.groups()
                if first:
                    start, end = int(first), min(int(last), end) if last else end
                else:
                    start = max(0, size - int(last))
            else:
                start = size
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        self.send_response(206 if requested else 200)
        self.send_header('Content-Type', 'video/webm')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if requested:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        try:
            with file.open('rb') as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browsers routinely cancel an old media request when seeking.

    def do_POST(self):
        name=self.path.removeprefix('/quality-image/')
        if not self.path.startswith('/quality-image/') or not re.fullmatch(r'[a-zA-Z0-9-]+\.png',name) or not self.server.quality_output:
            self.send_error(404);return
        try:
            length=int(self.headers.get('Content-Length',0))
            if length<0:raise ValueError('Negative content length')
        except ValueError:
            self.send_error(400,'Invalid content length');return
        if length>4_000_000:self.send_error(413);return
        try:
            pixels=base64.b64decode(self.rfile.read(length),validate=True)
        except (binascii.Error,ValueError):
            self.send_error(400,'Invalid base64 image');return
        (self.server.quality_output/name).write_bytes(pixels)
        self.send_response(204);self.end_headers()
    def end_headers(self):
        if self.path=='/robots.txt':
            # The malformed-host scenario must not reuse an earlier valid
            # document from Chromium's HTTP cache.
            self.send_header('Cache-Control','no-store')
        if self.path=='/custom-player.html':
            self.send_header('Content-Security-Policy',"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; frame-src 'self' about:; require-trusted-types-for 'script'; trusted-types qute-motionflow-workers")
        if self.path=='/player.html':
            source="'nonce-motionflow-test' 'unsafe-inline' 'strict-dynamic' https: http: 'unsafe-eval'" if getattr(self,'nonce_policy',False) else "'unsafe-eval' 'self' 'unsafe-inline' https://www.google.com https://apis.google.com https://ssl.gstatic.com https://www.gstatic.com https://www.googletagmanager.com https://www.google-analytics.com https://*.youtube.com https://*.google.com https://*.gstatic.com https://youtube.com https://www.youtube.com https://google.com https://*.doubleclick.net https://*.googleapis.com https://www.googleadservices.com https://tpc.googlesyndication.com https://www.youtubekids.com https://www.youtube-nocookie.com https://www.youtubeeducation.com https://www-onepick-opensocial.googleusercontent.com"
            self.send_header('Content-Security-Policy', "base-uri 'self'; object-src 'none'; script-src "+source+"; frame-src 'self'; require-trusted-types-for 'script'; trusted-types qute-motionflow-workers")
        super().end_headers()
    def log_message(self,*_args):
        pass

class BrowserPage(QWebEnginePage):
    def javaScriptConsoleMessage(self,level,message,line,source):
        print(f'{level.name}: {message}'+(f' at {source}:{line}' if level==QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel else ''),flush=True)
        if message=='MOTIONFLOW_MENU_PREVIEW' and os.environ.get('MOTIONFLOW_PREVIEW'):
            QTimer.singleShot(80,lambda:self.test_view.grab().save(os.environ['MOTIONFLOW_PREVIEW']))
        if message.startswith('FPS_TYPING_REQUEST:'):
            point=json.loads(message.split(':',1)[1])
            def type_fps():
                widget=self.test_view.focusProxy() or self.test_view
                QTest.mouseClick(widget,Qt.MouseButton.LeftButton,Qt.KeyboardModifier.NoModifier,QPoint(point['x'],point['y']))
                QTest.keyClick(widget,Qt.Key.Key_A,Qt.KeyboardModifier.ControlModifier)
                QTest.keyClicks(widget,'60')
                QTest.keyClick(widget,Qt.Key.Key_Return)
            QTimer.singleShot(60,type_fps)
        if message=='DIVIDER_DRAG_REQUEST':
            def drag_divider():
                widget=self.test_view.focusProxy() or self.test_view
                QTest.mousePress(widget,Qt.MouseButton.LeftButton,Qt.KeyboardModifier.NoModifier,QPoint(333,200))
                QTest.mouseMove(widget,QPoint(465,200),40)
                QTest.mouseRelease(widget,Qt.MouseButton.LeftButton,Qt.KeyboardModifier.NoModifier,QPoint(465,200))
            QTimer.singleShot(40,drag_divider)
        if message=='FULLSCREEN_REQUEST':
            QTimer.singleShot(50,lambda:QTest.mouseClick(self.test_view.focusProxy() or self.test_view,Qt.MouseButton.LeftButton,Qt.KeyboardModifier.NoModifier,QPoint(760,540)))
        if message in ('COMPOSITOR_BASELINE_BEGIN','COMPOSITOR_STRESS_BEGIN'):
            self.pixel_samples=[]
            # 45 fps on a 60 Hz display has 33.3 ms presentation gaps. Sampling
            # on that boundary can alias; 40 ms still detects real freezes.
            self.pixel_timer.start(40 if 'detail45' in self.url().query() else 33)
        if message in ('COMPOSITOR_BASELINE_END','COMPOSITOR_STRESS_END'):
            self.pixel_timer.stop()
            changes=sum(a!=b for a,b in zip(self.pixel_samples,self.pixel_samples[1:]))
            print('COMPOSITED_PIXELS',message,len(self.pixel_samples),changes,flush=True)
            self.composited[message]=(len(self.pixel_samples),changes)
        handled_socket_error='neural' in self.url().query() and message.startswith("WebSocket connection to 'ws://127.0.0.1:8770/")
        if level==QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel and not handled_socket_error:
            self.application.exit(1)
        if message.startswith('TEST_RESULT:'):
            result=json.loads(message.split(':',1)[1])
            if self.url().path()=='/watch' and not any(case in self.url().query() for case in ('unsupported','transfer-error','host-invalid','offline','generic','upscale','controls','tail')) and result.get('passed'):
                for name in ['COMPOSITOR_BASELINE_END','COMPOSITOR_STRESS_END']:
                    count,changes=self.composited.get(name,(0,0))
                    if count<10 or changes/max(1,count-1)<0.9:
                        print('FAIL: actual composited picture did not keep updating:',name,count,changes,flush=True)
                        self.application.exit(1);return
            if result.get('passed') and self.remaining:
                self.load(self.remaining.pop(0))
            else:
                self.application.exit(0 if result.get('passed') else 1)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gpu-only',action='store_true',help='run only deterministic interpolation image tests')
    parser.add_argument('--pairing-token-file',type=Path,help='exercise generic-origin pairing using the temporary test helper token')
    parser.add_argument('--media-cache',type=Path,help='reuse generated test media in this directory')
    parser.add_argument('--case',choices=['controls','tail','short-tail','test','test24','detail45','unsupported','transfer-error','host-invalid','neural-test','neural-test24','neural-detail45','neural-animation','neural-gameplay','neural-general','neural-upscale','neural-generic','neural-offline'],help='run one player scenario')
    parser.add_argument('--quality-only',action='store_true',help='run motion-boundary and optional real-clip image tests')
    parser.add_argument('--neural-quality',action='store_true',help='use the running AI helper in image-quality tests')
    parser.add_argument('--quality-scale',type=int,choices=[1,2,3],default=1,help='quality scene size: 640, 1280 or 1920 pixels wide')
    parser.add_argument('--reference-worker',type=Path,help='compare against an earlier independent worker implementation')
    parser.add_argument('--clip',type=Path,action='append',default=[],help='locally supplied clip for withheld-middle-frame checks')
    parser.add_argument('--quality-output',type=Path,help='export expected/reference/candidate image sheets')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parents[1]
    objects.backend=usertypes.Backend.QtWebEngine
    subprocess.run([sys.executable,str(repo/'lib/motionflow/build.py'),'--check'],check=True)
    subprocess.run(['node',str(repo/'tests/motionflow-presentation.cjs')],check=True)
    with tempfile.TemporaryDirectory(prefix='qute-motionflow-') as temporary:
        root=Path(temporary)
        (root/'robots.txt').write_text('User-agent: *\nDisallow: /\n')
        shutil.copyfile(repo/'tests/fixtures/motionflow-player.html',root/'player.html')
        shutil.copyfile(repo/'tests/fixtures/motionflow-custom.html',root/'custom-player.html')
        if (repo/'tests/fixtures/motionflow-gpu.html').exists():
            shutil.copyfile(repo/'tests/fixtures/motionflow-gpu.html',root/'gpu.html')
        shutil.copyfile(repo/'tests/fixtures/motionflow-quality.html',root/'quality.html')
        if args.reference_worker:
            (root/'reference-worker.js').write_text('('+args.reference_worker.read_text()+')();')
        clips=[]
        for clip_index,clip in enumerate(args.clip):
            directory=root/f'clip{clip_index}';directory.mkdir()
            expression='+'.join(f'between(n,{frame},{frame+2})' for frame in (30,90,150,210,270,330,390))
            subprocess.run(['ffmpeg','-v','error','-i',str(clip),'-vf',f"select='{expression}',scale={640*args.quality_scale}:{360*args.quality_scale}",'-fps_mode','vfr',str(directory/'%02d.png')],check=True)
            images=sorted(directory.glob('*.png'))
            for i in range(0,len(images)-2,3):
                clips.append({'name':f'clip{clip_index}-pair{i//3}','images':[str(p.relative_to(root)) for p in images[i:i+3]]})
        (root/'quality-clips.json').write_text(json.dumps(clips))
        neural=(repo/'lib/motionflow/neural-worker.js').read_text()
        (root/'neural-worker.js').write_text('('+neural+')();')
        shutil.copyfile(repo/'tests/fixtures/motionflow-neural-gpu.html',root/'neural-gpu.html')
        worker=(repo/'lib/motionflow/worker.js').read_text()
        (root/'worker.js').write_text('('+worker+')();')
        for rate in (() if args.gpu_only or args.quality_only else ((24,) if args.case and any(x in args.case for x in ('test24','generic','upscale')) else (30,) if args.case else (30,24))):
            command=['ffmpeg','-v','error','-f','lavfi','-i',f'testsrc2=size={"640x360" if args.case in ("neural-upscale","neural-generic") else "1920x1080"}:rate={rate//2 if args.case=="neural-animation" else rate},drawgrid=w=80:h=80:t=2:c=white,scroll=horizontal=0.003:vertical=0.0015'+(f',fps={rate}' if args.case=='neural-animation' else ''),
                            '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',('1' if args.case=='short-tail' else '3' if args.case=='tail' else '60'),'-c:v','libvpx',
                            '-deadline','realtime','-c:a','libopus',]
            output=root/f'sample{rate}.webm'
            cached=None
            if args.media_cache:
                args.media_cache.mkdir(parents=True,exist_ok=True)
                cached=args.media_cache/(hashlib.sha256(json.dumps(command).encode()).hexdigest()+'.webm')
            if cached and cached.exists():shutil.copyfile(cached,output)
            else:
                subprocess.run([*command,str(output)],check=True)
                if cached:shutil.copyfile(output,cached)
        with http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Files,directory=temporary)) as server:
            server.quality_output=args.quality_output
            if args.quality_output:args.quality_output.mkdir(parents=True,exist_ok=True)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            app=QApplication(sys.argv);view=QWebEngineView();profile=QWebEngineProfile(view)
            profile.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture,False)
            profile.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled,True)
            page=BrowserPage(profile,view);page.application=app;page.test_view=view;view.setPage(page)
            page.fullScreenRequested.connect(lambda request:request.accept())
            page.pixel_timer=QTimer(view);page.pixel_samples=[];page.composited={}
            def sample_pixels():
                image=view.grab(QRect(354,44,296,330)).toImage()
                page.pixel_samples.append(hashlib.sha256(image.constBits().asstring(image.sizeInBytes())).hexdigest())
            page.pixel_timer.timeout.connect(sample_pixels)
            text=(repo/('custom/js/video-motionflow.js' if args.case=='neural-generic' else 'custom/js/youtube-motionflow.js')).read_text();at=text.rindex('})();')
            test_hook=HOOK
            if args.pairing_token_file:
                test_hook='browser.__motionFlowAuth={token:'+json.dumps(args.pairing_token_file.read_text().strip())+'};\n'+test_hook
            text=text[:at]+test_hook+text[at:]
            parsed=greasemonkey.GreasemonkeyScript.parse(text,filename='MotionFlow test')
            assert parsed.jsworld=='user'
            # Qt also interprets Greasemonkey URL metadata; the fixture is local.
            parsed._code=re.sub(r'// ==UserScript==.*?// ==/UserScript==','',parsed._code,flags=re.S)
            script=QWebEngineScript();script.setName('MotionFlow test')
            script.setWorldId(QWebEngineScript.ScriptWorldId.UserWorld)
            script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentReady)
            script.setRunsOnSubFrames(False)
            script.setSourceCode((repo/'tests/fixtures/motionflow-hook.js').read_text()+'\n'+parsed.code())
            page.scripts().insert(script)
            host='localhost' if args.pairing_token_file else '127.0.0.1'
            page.remaining=[] if args.case else [QUrl(f'http://127.0.0.1:{server.server_port}/watch?v={case}') for case in ('test24','detail45','unsupported','transfer-error','host-invalid')]
            if args.case and args.case.startswith('neural') and 'offline' not in args.case:
                page.remaining.append(QUrl(f'http://127.0.0.1:{server.server_port}/neural-gpu.html'))
            if args.case in ('controls','tail','short-tail'):page.remaining=[]
            if args.case not in ('controls','tail','short-tail') and (root/'gpu.html').exists():page.remaining.append(QUrl(f'http://127.0.0.1:{server.server_port}/gpu.html'))
            quality=f'quality.html?scale={args.quality_scale}&'+('neural=1&' if args.neural_quality else '')+('reference=1&' if args.reference_worker else '')+('clips=1&' if clips else '')+('export=1' if args.quality_output else '')
            if args.case not in ('controls','tail','short-tail'):page.remaining.append(QUrl(f'http://127.0.0.1:{server.server_port}/{quality}'))
            if not args.case and not args.gpu_only and not args.quality_only:
                page.remaining.extend(QUrl(f'http://127.0.0.1:{server.server_port}/'+quality.replace(f'scale={args.quality_scale}',f'scale={scale}')) for scale in (2,3) if scale!=args.quality_scale)
            view.resize(800,600);view.show()
            if args.gpu_only:page.remaining=[QUrl(f'http://127.0.0.1:{server.server_port}/{quality}')]
            if args.quality_only:page.remaining=[]
            path=quality if args.quality_only else 'gpu.html' if args.gpu_only else 'watch?v='+(args.case or 'test')
            if args.pairing_token_file:page.remaining=[]
            page.load(QUrl(f'http://{host}:{server.server_port}/{path}'))
            QTimer.singleShot(160000,lambda:app.exit(2));result=app.exec()
            server.shutdown();thread.join();return result

if __name__=='__main__':
    raise SystemExit(main())
