import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {WebSocketServer} from 'ws';

test('Foundation WebSocket and production decoder accept actual synthetic server final ordering',{timeout:30000},async t=>{
 if(process.platform!=='darwin'){t.skip('Foundation host probe requires macOS');return}
 const dir=await mkdtemp(join(tmpdir(),'ordered-transport-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=fileURLToPath(new URL('../',import.meta.url));
 const cases=await Promise.all(['ordered-server-events.json','ordered-server-gap.json'].map(async name=>JSON.parse(await readFile(new URL('./fixtures/'+name,import.meta.url),'utf8'))));
 const build=[['-emit-library','-emit-module','-module-name','AssistantCore',join(root,'native/Sources/AssistantCore/OrderedVoiceInput.swift'),'-o',join(dir,'libAssistantCore.dylib'),'-emit-module-path',join(dir,'AssistantCore.swiftmodule')],['-parse-as-library','-I',dir,'-L',dir,'-lAssistantCore','-Xlinker','-rpath','-Xlinker',dir,join(root,'test/native-ordered-transport-probe.swift'),'-o',join(dir,'probe')]];
 for(const args of build){const result=spawnSync('swiftc',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr)}
 for(const [index,events] of cases.entries()) {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  server.once('connection',socket=>{for(const e of events)socket.send(JSON.stringify(e));socket.close()});
  const result=await new Promise((resolve,reject)=>{const child=spawn(join(dir,'probe'),[`ws://127.0.0.1:${server.address().port}`,...(index?['gap']:[])]);let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}))});
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/production decoder and sequence state/);
 }
});
