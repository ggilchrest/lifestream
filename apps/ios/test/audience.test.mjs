import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createLifestreamServer} from '../../server/src/index.ts';
import {loadProfile} from '../../server/src/config/loader.ts';
async function probe(t){
 const root=await mkdtemp(join(tmpdir(),'ls-ios-audience-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=name=>new URL('../ios/App/CapApp-SPM/Sources/CapApp-SPM/'+name,import.meta.url).pathname;
 const core=name=>new URL('../native/Sources/AssistantCore/'+name,import.meta.url).pathname;
 await copyFile(new URL('./audience-probe.swift',import.meta.url),join(root,'main.swift'));
 for(const args of [
  ['-emit-library','-emit-module','-module-name','AssistantCore',core('VoiceProtocol.swift'),core('AudienceLifecycle.swift'),'-o',join(root,'libAssistantCore.dylib'),'-emit-module-path',join(root,'AssistantCore.swiftmodule')],
  ['-D','DEBUG','-I',root,'-L',root,'-lAssistantCore','-Xlinker','-rpath','-Xlinker',root,source('NativeTransport.swift'),source('ConnectionStore.swift'),source('NativeAudience.swift'),join(root,'main.swift'),'-o',join(root,'probe')]
 ]){const result=spawnSync('swiftc',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
 return config=>new Promise((resolve,reject)=>{const child=spawn(join(root,'probe'),[],{stdio:['pipe','pipe','pipe']});let out='',error='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error(error||`Audience probe exited ${code}`));try{resolve(JSON.parse(out))}catch{reject(Error(out+error))}});child.stdin.end(JSON.stringify(config)+'\n');});
}
test('native audience owns a renewable lease and ends on minimize while evidenced opt-in lock continues',{timeout:90000},async t=>{
 const run=await probe(t);let scenario='good',id=null,revision=1,requests=[];
 const value=()=>({enforced:true,leaseId:id,revision,classification:id?'solo-supported':'unknown',privateAllowed:!!id,basis:id?'manual':'unavailable',expiresAt:id?new Date(Date.now()+20000).toISOString():null,leaseExpiresAt:id?new Date(Date.now()+20000).toISOString():null});
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/auth/v1/sign-in'){res.writeHead(200,{'content-type':'application/json','set-cookie':'lifestream_123=synthetic; Path=/; HttpOnly'}).end(JSON.stringify({session:{csrfToken:'synthetic-csrf'}}));return;}
  if(req.url==='/api/runtime/v1/audience'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value()));return;}
  assert.equal(req.url,'/api/runtime/v1/audience/lease');assert.equal(req.headers['x-lifestream-csrf'],'synthetic-csrf');assert.match(req.headers.cookie,/synthetic/);
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);assert.match(body.leaseId,/^[a-f0-9-]{36}$/);assert.equal(typeof body.expectedAudienceRevision,'number');
  if(scenario==='unsupported'){res.writeHead(404).end('{}');return;}
  if(body.operation==='begin'){assert.equal(body.expectedAudienceRevision,revision);id=body.leaseId;revision++;}
  else if(body.operation==='renew'){if(scenario==='revoked'){id=null;revision++;res.writeHead(409).end('{}');return;}assert.equal(body.leaseId,id);assert.equal(body.expectedAudienceRevision,revision);}
  else if(body.operation==='end'){if(body.leaseId===id){id=null;revision++;}}
  else assert.fail('unsupported operation');
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value()));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const endpoint=`http://127.0.0.1:${server.address().port}`;
 for(const mode of ['good','lock','minimize','cancel','revoked','originChange','unsupported']){
  scenario=mode;id=null;revision=1;requests=[];const result=await run({endpoint,scenario:mode});
  if(mode==='unsupported'){assert.equal(result.ok,false);assert.match(result.message,/update|support/i);assert.equal(requests.length,1,'no legacy five-minute fallback');}
  else if(mode==='revoked'||mode==='originChange'){assert.equal(result.ok,false);assert.equal(result.leaseActive,false);assert.ok(result.ended.length);assert.equal(requests.filter(x=>x.operation==='begin').length,1,'revoked lease never starts itself again');}
  else{assert.equal(result.ok,true,JSON.stringify(result));if(mode==='lock'){assert.equal(result.leaseActive,true);assert.equal(result.sameId,true);assert.equal(result.ended.length,0);}else{assert.equal(result.leaseActive,false);assert.ok(requests.some(x=>x.operation==='end'));if(mode==='good')assert.equal(result.sameId,true);}}
 }
});

test('actual Foundation audience transport acquires renews and releases the real isolated server lease',{timeout:90000},async t=>{
 const run=await probe(t),root=await mkdtemp(join(tmpdir(),'ls-ios-audience-server-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();t.after(()=>app.shutdown());
 const endpoint=`http://127.0.0.1:${app.address().port}`,setup=await fetch(endpoint+'/api/auth/v1/setup',{method:'POST',headers:{origin:endpoint,'content-type':'application/json'},body:JSON.stringify({username:'ios-audience',password,installerToken})});assert.equal(setup.status,201);
 const result=await run({endpoint,password,context:'true'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.sameId,true);assert.equal(result.leaseActive,false);assert.deepEqual(result.ended,['Finished']);
 const reacquired=await run({endpoint,password,context:'true',scenario:'clearThenStart'});assert.equal(reacquired.ok,true,JSON.stringify(reacquired));assert.equal(reacquired.reacquired,true,'an explicit Start can immediately reacquire after remote clear without waiting for heartbeat');assert.equal(reacquired.leaseActive,false);
});
