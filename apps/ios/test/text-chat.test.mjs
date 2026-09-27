import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {createLifestreamServer} from '../../server/src/index.ts';
import {loadProfile} from '../../server/src/config/loader.ts';

async function probe(t){
 const root=await mkdtemp(join(tmpdir(),'ls-ios-text-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=name=>new URL('../ios/App/CapApp-SPM/Sources/CapApp-SPM/'+name,import.meta.url).pathname;
 await copyFile(new URL('./text-probe.swift',import.meta.url),join(root,'main.swift'));
 for(const args of [
  ['-emit-library','-emit-module','-module-name','AssistantCore',new URL('../native/Sources/AssistantCore/VoiceProtocol.swift',import.meta.url).pathname,'-o',join(root,'libAssistantCore.dylib'),'-emit-module-path',join(root,'AssistantCore.swiftmodule')],
  ['-D','DEBUG','-I',root,'-L',root,'-lAssistantCore','-Xlinker','-rpath','-Xlinker',root,source('NativeTransport.swift'),source('ConnectionStore.swift'),source('NativeText.swift'),join(root,'main.swift'),'-o',join(root,'probe')]
 ]){const result=spawnSync('swiftc',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
 const run=configuration=>new Promise((resolve,reject)=>{const child=spawn(join(root,'probe'),[],{stdio:['pipe','pipe','pipe']});let out='',error='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error(error||`Native text probe exited ${code}`));try{resolve(JSON.parse(out))}catch{reject(Error(out+error))}});child.stdin.end(JSON.stringify(configuration)+'\n');});
 return {root,run};
}

test('native typed chat completes the real isolated runtime SSE protocol without audio',{timeout:90000},async t=>{
 const {root,run}=await probe(t),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();t.after(()=>app.shutdown());
 const endpoint=`http://127.0.0.1:${app.address().port}`;let cookie='',csrf='';
 const api=async(path,body)=>{const response=await fetch(endpoint+path,{method:'POST',headers:{origin:endpoint,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf},body:JSON.stringify(body)});if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const value=await response.json();csrf=value.session?.csrfToken??csrf;assert.ok(response.ok,JSON.stringify(value));return value;};
 await api('/api/auth/v1/setup',{username:'ios-text',password,installerToken});const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic typed chat'});
 const proposal=await api('/api/auth/v1/proposals',{operation:{method:'POST',path:`/api/admin/v1/assistants/${assistant.assistantId}/activate`,body:{profileId:assistant.profile.profileId,expectedActiveRevision:null},expectedRevision:null}});await api(`/api/auth/v1/proposals/${proposal.proposalId}/approve`,{reviewedDigest:proposal.digest,humanConfirmed:true});
 let audioRequests=0;app.server.on('upgrade',()=>audioRequests++);
 const result=await run({endpoint,password,assistantId:assistant.assistantId,context:'true'});assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.result.text,/Synthetic typed question/);assert.equal(result.result.trace,'b392061b-0300-46b9-ab89-aad7f611093c');assert.match(result.result.interactionTraceId,/^[a-f0-9-]{36}$/);assert.equal(result.active,false);assert.equal(audioRequests,0);assert.equal(result.physicalAudio,false);
});

test('native text rejects incomplete, mismatched, failed and oversized replies and cancels stale requests',{timeout:90000},async t=>{
 const {run}=await probe(t),assistantId=randomUUID(),interactionId=randomUUID(),trace='b392061b-0300-46b9-ab89-aad7f611093c';let scenario='complete',closed=false,closedAt=0,requests=0;
 const frame=(event,data)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
 const start=frame('interaction.started',{interactionId,assistantId,sessionId:randomUUID()}),delta=frame('message.delta',{interactionId,text:'Synthetic reply.'}),complete=frame('interaction.completed',{interactionId});
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/auth/v1/sign-in'){res.writeHead(200,{'content-type':'application/json','set-cookie':'lifestream_123=syntheticCookie; Path=/; HttpOnly'}).end(JSON.stringify({session:{csrfToken:'synthetic-csrf'}}));return;}
  assert.equal(req.url,'/api/runtime/v1/messages');assert.equal(req.headers['x-lifestream-csrf'],'synthetic-csrf');assert.match(req.headers.cookie,/syntheticCookie/);requests++;res.on('close',()=>{closed=true;closedAt=Date.now()});
  let body='';for await(const chunk of req)body+=chunk;assert.deepEqual(JSON.parse(body),{assistantId,userInput:'Synthetic typed question.'});
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(start);
  if(['cancel','changeOrigin'].includes(scenario)){res.write(': waiting\n\n');return;}
  if(scenario==='error'){res.end(frame('message.delta',{interactionId,text:'Do not show'})+frame('interaction.error',{code:'runtime_input_stale',message:'Scope changed'}));return;}
  if(scenario==='mismatch'){res.end(frame('message.delta',{interactionId:randomUUID(),text:'Do not show'})+complete);return;}
  if(scenario==='large'){res.end(frame('message.delta',{interactionId,text:'x'.repeat(65537)})+complete);return;}
  res.end(delta+(scenario==='incomplete'?'':complete));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const input={endpoint:`http://127.0.0.1:${server.address().port}`,password:'synthetic-password',assistantId};
 const good=await run(input);assert.deepEqual(good,{ok:true,result:{text:'Synthetic reply.',trace,interactionTraceId:interactionId},active:false,physicalAudio:false});
 for(const value of ['incomplete','mismatch','error','large','cancel','changeOrigin']){scenario=value;closed=false;const result=await run({...input,[value]:'true'});assert.equal(result.ok,false,value);assert.equal(result.active,false,value);assert.ok(result.message.length,value);assert.ok(!JSON.stringify(result).includes('Do not show'));assert.equal(closed,true,value);if(['cancel','changeOrigin'].includes(value))assert.ok(Date.now()-closedAt>=200,'request closed before the probe process exited');}
 assert.equal(requests,7);
 const blank=await run({...input,input:' '});assert.equal(blank.ok,false);assert.equal(requests,7,'invalid blank input is rejected before network dispatch');
});
