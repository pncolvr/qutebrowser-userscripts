"""Check credential provisioning and action guards without real credentials."""
from pathlib import Path
import subprocess,sys,tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib/motionflow'))
from pair import install
with tempfile.TemporaryDirectory() as folder:
 root=Path(folder);cache=root/'cache';cache.mkdir();(cache/'browser.token').write_text('0'*64)
 install(cache,root/'scripts');file=root/'scripts/_a.motionflow-auth.js';assert file.stat().st_mode&0o777==0o600
 code=r'''
 const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
 let handler,video=false,controls=false;const world={};
 const document={defaultView:world,querySelector:()=>video?{}:null,addEventListener:(name,fn)=>{assert.equal(name,'click');handler=fn}};
 const source=fs.readFileSync(process.argv[1],'utf8');vm.runInNewContext(source,{document});
 const event=trusted=>({isTrusted:trusted,target:{closest:()=>controls?{}:null}});
 assert.equal(world.__motionFlowAuth,undefined);
 handler(event(true));assert.equal(world.__motionFlowAuth,undefined,'ordinary pages cannot provision a credential');
 video=true;controls=true;handler(event(false));assert.equal(world.__motionFlowAuth,undefined,'synthetic clicks cannot provision a credential');
 controls=false;handler(event(true));assert.equal(world.__motionFlowAuth,undefined,'unrelated clicks cannot provision a credential');
 controls=true;handler(event(true));assert.equal(world.__motionFlowAuth.token,'0'.repeat(64));
 let buttonHandler,actions=0;
 const button={addEventListener:(name,fn)=>buttonHandler=fn};const uiDocument={createElement:()=>button};
 const ui=fs.readFileSync(process.argv[2],'utf8');const sandbox={document:uiDocument};vm.runInNewContext(ui+';globalThis.make=makeButton;',sandbox);
 sandbox.make('test',()=>actions++);buttonHandler({isTrusted:false});assert.equal(actions,0);
 buttonHandler({isTrusted:true,preventDefault(){},stopPropagation(){}});assert.equal(actions,1);
 console.log('PASS: pairing requires real video-control interaction; synthetic page clicks cannot activate enhancement');
 '''
 subprocess.run(['node','-e',code,str(file),str(Path(__file__).resolve().parents[1]/'lib/motionflow/ui.js')],check=True)
