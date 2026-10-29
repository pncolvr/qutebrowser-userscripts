const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const sandbox={SITE:'generic',document:{querySelectorAll:()=>[],fullscreenElement:null},browser:{innerHeight:800}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/motionflow/settings.js'),'utf8')+';globalThis.api={outputSizing,videoSelection,bufferingOptions};',sandbox);
assert.equal(sandbox.api.videoSelection().video,null,'Pages with no video remain untouched');
const profile={outputWidth:1280,outputHeight:720};
for(const [w,h,res,up,ow,oh,pw,ph] of [[640,360,'source',true,640,360,640,360],[640,360,'auto',true,1280,720,640,360],[640,360,'1080',true,1920,1080,640,360],[640,360,'2160',false,640,360,640,360],[1920,1080,'2160',true,3840,2160,1920,1080],[3840,2160,'source',false,1920,1080,1920,1080],[1920,1080,'auto',false,1280,720,1280,720],[720,1280,'1080',true,608,1080,608,1080]]){
 const actual=sandbox.api.outputSizing({videoWidth:w,videoHeight:h},profile,res,up);
 assert.deepEqual([actual.outputWidth,actual.outputHeight,actual.processingWidth,actual.processingHeight],[ow,oh,pw,ph]);
 assert.ok(Math.abs(actual.outputWidth/actual.outputHeight-w/h)<.002);
}
console.log('PASS: Independent output sizing, upscale opt-in, aspect ratio, inference bounds and empty-page detection');

const MiB=1024*1024;
for(const [buffer,memory,automatic,delay,prepared,budget] of [
 ['auto','512',400,400,250,512],
 ['1500','1024',400,1650,1500,1024],
 ['6000','2048',400,6150,6000,2048],
 ['6000','4096',400,6150,6000,4096],
 ['6000','8192',400,6150,6000,8192],
 ['750','256',700,900,750,256],
 ['Infinity','Infinity',400,400,250,512]
]){
 const result=sandbox.api.bufferingOptions(buffer,memory,automatic);
 assert.deepEqual([result.delayMs,result.bufferMs,result.maxBufferBytes],[delay,prepared,budget*MiB]);
}
console.log('PASS: Long buffers and selectable memory budgets preserve defaults and reject unknown choices');

// Exercise the real audio route with a long video delay and a silent fake graph.
const main=fs.readFileSync(path.join(__dirname,'../lib/motionflow/main.js'),'utf8');
let capacity=0,gain=null;
const param=()=>({value:0,cancelScheduledValues(){},setValueAtTime(value){this.value=value;},linearRampToValueAtTime(value){this.value=value;}});
const node=()=>({connect(){},disconnect(){}});
const audioSandbox={browser:{setTimeout:fn=>fn()},document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData(){}})})}};
vm.runInNewContext(main.slice(main.indexOf('class AudioRoute'),main.indexOf('class PlaybackSession'))+';globalThis.route=new AudioRoute();',audioSandbox);
const route=audioSandbox.route;
route.context={state:'running',currentTime:0,baseLatency:.01,destination:{},
 createDelay(max){capacity=max;return {...node(),delayTime:param()};},
 createMediaElementSource:node,
 createGain:()=>({...node(),gain:{value:1,cancelScheduledValues(){},setValueAtTime(value){this.value=gain=value;},linearRampToValueAtTime(value){this.value=gain=value;}}})};
const video={};
route.follow(video,6150,true);
assert.ok(capacity>=6.15,'Audio delay node must support the longer buffer');
assert.ok(Math.abs(route.delayMs-6140)<.001,'Audio must follow a six-second buffer without the old four-second clamp');
assert.equal(gain,0,'Preparation remains muted');
route.follow(video,6150,false);assert.equal(gain,1,'Audio resumes with delayed video');
route.follow(video,6160,false);assert.ok(Math.abs(route.delayMs-6140)<.001,'Small timing estimates do not modulate audio delay');
const previousDelay=route.current.delay;
route.direct();assert.equal(route.delayMs,0);assert.equal(route.current.active,false);
route.follow(video,6150,true);assert.notEqual(route.current.delay,previousDelay,'A fresh session cannot replay the previous delay line');route.direct();
console.log('PASS: Long buffers keep matching audio, smooth gains and stable timing without stale audio');
