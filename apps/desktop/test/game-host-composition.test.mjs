import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gameHostMessage,parseGameHostFramePath,GAME_HOST_PROTOCOL as protocol} from '../../../packages/contracts/src/game-host.ts';
import {WindowsGameHostClient} from '../../../packages/providers-bizhawk/src/game-host-client.ts';
import {GameFrameCustody,inspectGamePng} from '../../../packages/providers-bizhawk/src/frame-custody.ts';
import {createDesktopGameHostComposition,gameHostSetupFromArguments} from '../game-host-composition.cjs';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
const {installGameHostControls}=createRequire(import.meta.url)('../game-host-controls.cjs');
const origin='http://127.0.0.1:43182',json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('setup switches support Windows-safe equals syntax and reject ambiguous or incomplete pins',()=>{
 const path=resolve(tmpdir(),'setup.json'),pin='a'.repeat(64);
 assert.deepEqual(gameHostSetupFromArguments(['--game-host-setup='+path,'--game-host-setup-sha256='+pin]),{path,sha256:pin});
 assert.equal(gameHostSetupFromArguments([]),null);
 for(const args of [['--game-host-setup='+path],['--game-host-setup='+path,'--game-host-setup='+path,'--game-host-setup-sha256='+pin],['--game-host-setup=relative','--game-host-setup-sha256='+pin]])assert.throws(()=>gameHostSetupFromArguments(args));
});
function fixture(resolveDone=false,configured=true){
 const directory=mkdtempSync(join(tmpdir(),'desktop-game-composition-')),frames=join(directory,'frames');mkdirSync(frames);
 const scope=observe().scope,endpoint={endpointId:scope.contextBinding.endpointId,ownership:'personal',privacyClass:'personal',health:'healthy'},sourceRevision='b'.repeat(64),runtimeSourceRevision='c'.repeat(64);
 const attach={protocol,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-composition',sourceRevision};
 const authentication={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,owner:true,adminExpiresAt:new Date(Date.now()+60000).toISOString(),csrfToken:'SYNTHETIC_ONLY_NO_REAL_CREDENTIAL_1234567890'};
 const calls=[],attachmentId=randomUUID();let changed=false,denied=false,driver,options,nativeClosed=0,shutdown=0,releaseNative,conversationId=scope.contextBinding.conversationId,audienceScope='authenticatedSession';
 const nativeGate=new Promise(resolve=>{releaseNative=resolve;});
 const partition={async fetch(url,init){const route=new URL(url).pathname;calls.push(route);
  if(denied)return new Response(JSON.stringify({code:'authentication_required'}),{status:401,headers:{'content-type':'application/json'}});
  if(route==='/api/auth/v1/session')return json(authentication);
  if(route==='/api/runtime/v1/session-context')return json({conversationId,ended:changed,revision:1,endpoint,runtimeSelfContext:{audienceScope,sourceRevision:runtimeSourceRevision}});
  if(route.endsWith('/attach'))return json({protocol,attachmentId,expiresAt:new Date(Date.now()+4000).toISOString(),pollMs:1000,maxMessageBytes:131072});
  if(route.endsWith('/next'))return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('fixture cancellation')),{once:true});if(init.signal.aborted)reject(Error('fixture cancellation'));});
  if(route.endsWith('/detach'))return json({protocol,attachmentId,fenced:true});throw Error('unexpected fixture route');
 }};
 const handlers=new Map(),frame={url:origin+'/control/'},window=new EventEmitter();window.isDestroyed=()=>false;window.webContents={mainFrame:frame,send(){}};
 const controls=installGameHostControls({ipcMain:{handle:(key,value)=>handlers.set(key,value),removeHandler:key=>handlers.delete(key)},window,origin});
 const sdk={gameHostMessage,parseGameHostFramePath,inspectGamePng,GameFrameCustody,createOwnedWindowsGameHostDriver(value){options=value;
  const client=new WindowsGameHostClient({attach:value.attach,fetchAuthenticated:value.fetchAuthenticated,isScopeCurrent:value.isScopeCurrent,sourceIsQualified:()=>true,nativeBoundary:{providerRef:attach.providerRef,maxDurationMs:5000,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>true,reconcileEffect:async()=>true,admitRelease:async()=>true},openNative:async()=>{await nativeGate;return {adapter:{observe:async()=>{throw Error('no gameplay fixture');}},close(){nativeClosed++;}};},shutdownExactOldLease:async()=>{shutdown++;},httpTimeoutMs:1000,sessionDurationMs:5000,shutdownTimeoutMs:1000});
  const running=client.run();driver={ready:client.ready,done:resolveDone?running.catch(()=>{}):running,fence:async()=>{client.close();await driver.done.catch(()=>{});},get snapshot(){return client.snapshot;}};return driver;
 }};
 const setup={schemaVersion:'lifestream.desktop-game-host-setup.v1',sourceRevision,approvalRef:'synthetic-fixture-not-a-live-grant',attach,binding:{revision:1,endpoint,runtimeSourceRevision},expiresAt:new Date(Date.now()+5000).toISOString(),paths:{emulator:join(directory,'emulator.exe'),configFile:join(directory,'fixture.ini'),romFile:join(directory,'fixture.zip'),frameDirectory:frames},evidence:{directory,sourceFiles:[]},native:{port:43183,connectionTimeoutMs:1000,authenticationTimeoutMs:1000,sessionDurationMs:5000,bounds:{maxScreenshotBytes:2097152,screenshotQueueByteBudget:4194304,maxScreenshotLongEdge:1024},romSha1:'d'.repeat(40)}};
 const path=join(directory,'setup.json');writeFileSync(path,JSON.stringify(setup));
 const setupSource={path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
 const composition=createDesktopGameHostComposition({controls,partition,sdk,sourceRevision,nativeDirectory:directory,setupSource:configured?setupSource:null});
 return {composition,calls,handlers,window,frame,authentication,scope,setup,path,setupSource,sdk,partition,controls,directory,get driver(){return driver;},get options(){return options;},get nativeClosed(){return nativeClosed;},get shutdown(){return shutdown;},releaseNative,set conversationId(value){conversationId=value;},set audienceScope(value){audienceScope=value;},set denied(value){denied=value;},set changed(value){changed=value;},async cleanup(){releaseNative();await composition.stop();window.emit('closed');rmSync(directory,{recursive:true,force:true});}};
}
test('composed main IPC reads actual supplied session metadata without start or credential export',async()=>{
 const f=fixture();try{const event={sender:f.window.webContents,senderFrame:f.frame};const result=await f.handlers.get('game-host-readiness')(event);
  assert.equal(result.ready,true);assert.equal(result.sessionId,f.scope.contextBinding.sessionId);assert.equal(f.driver,undefined);assert.equal(JSON.stringify(result).includes(f.authentication.csrfToken),false);
  assert.equal((await f.composition.readiness()).authenticated,true);assert.equal(f.composition.status().enabled,false);
  const before=f.calls.length;assert.equal((await f.handlers.get('game-host-readiness')({sender:f.window.webContents,senderFrame:{url:f.frame.url}})).ready,false);assert.equal(f.calls.length,before);
 }finally{await f.cleanup();}assert.equal(f.handlers.has('game-host-readiness'),false);
});

test('composition distinguishes a current session from missing, changed and expired setup',async()=>{
 const f=fixture(false,false);try{
  const missing=await f.composition.readiness();assert.equal(missing.sessionReady,true);assert.equal(missing.ready,false);assert.equal(missing.blockingReason,'setup_required');assert.equal(f.driver,undefined);
  const setup=structuredClone(f.setup);setup.expiresAt=new Date(Date.now()-1).toISOString();writeFileSync(f.path,JSON.stringify(setup));
  f.composition.selectSetupSource({path:f.path,sha256:createHash('sha256').update(readFileSync(f.path)).digest('hex')});
  const expired=await f.composition.readiness();assert.equal(expired.ready,false);assert.equal(expired.blockingReason,'setup_expired');
  await assert.rejects(f.composition.startApprovedSession(),error=>error.code==='setup_expired');assert.equal(f.composition.status().lastStartFailure,'setup_expired');assert.equal(f.driver,undefined);
  writeFileSync(f.path,JSON.stringify(f.setup));assert.equal((await f.composition.readiness()).blockingReason,'setup_changed');assert.equal(f.calls.some(path=>path.includes('/game-host/')),false);
 }finally{await f.cleanup();}
});

test('readiness and Start reject an unknown audience with the same diagnostic before any native allocation',async()=>{
 const f=fixture();try{
  f.audienceScope='unknown';const readiness=await f.composition.readiness();assert.equal(readiness.ready,false);assert.equal(readiness.blockingReason,'audience_unavailable');
  await assert.rejects(f.composition.startApprovedSession(),error=>error.code==='audience_unavailable');assert.equal(f.composition.status().lastStartFailure,'audience_unavailable');assert.equal(f.driver,undefined);
  assert.equal(f.calls.some(path=>path.includes('/game-host/')),false);assert.equal(JSON.stringify(readiness).includes(f.authentication.csrfToken),false);
 }finally{await f.cleanup();}
});
test('composition waits for real client native connection and backend attachment, then stop fences once',async()=>{
 const f=fixture();try{let settled=false;const start=f.composition.startApprovedSession().then(value=>{settled=true;return value;});await new Promise(r=>setTimeout(r,20));
  assert.equal(settled,false);assert.equal(f.driver.snapshot.attached,false);assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);f.releaseNative();
  const status=await start;assert.equal(status.nativeConnected,true);assert.equal(status.attached,true);assert.equal(f.options.fetchAuthenticated instanceof Function,true);
  assert.equal(f.options.native.pairingSecret.every(byte=>byte===0),true);
  await f.composition.stop();await f.composition.stop();assert.equal(f.composition.status().enabled,false);assert.equal(f.driver.snapshot.attached,false);assert.equal(f.shutdown,1);assert.equal(f.nativeClosed,1);await assert.rejects(f.composition.startApprovedSession());
 }finally{await f.cleanup();}
});

function currentSessionSetup(f){
 const setup=structuredClone(f.setup);setup.schemaVersion='lifestream.desktop-game-host-setup.v2';setup.binding={mode:'currentOwnerSession'};
 setup.attach.scope.contextBinding.sessionId=null;setup.attach.scope.contextBinding.conversationId=null;
 writeFileSync(f.path,JSON.stringify(setup));return {path:f.path,sha256:createHash('sha256').update(readFileSync(f.path)).digest('hex')};
}
test('trusted-main selection after a new sign-in binds current transport IDs without editing the setup',async()=>{
 const f=fixture(false,false);try{
  const source=currentSessionSetup(f),sessionId=randomUUID(),conversationId=randomUUID();f.authentication.sessionId=sessionId;f.conversationId=conversationId;
  assert.equal(f.composition.configured,false);f.composition.selectSetupSource(source);assert.equal(f.composition.configured,true);
  assert.equal(f.driver,undefined);assert.equal(f.calls.length,0);f.releaseNative();await f.composition.startApprovedSession();
  assert.equal(f.options.attach.scope.contextBinding.sessionId,sessionId);assert.equal(f.options.attach.scope.contextBinding.conversationId,conversationId);
  assert.equal(f.options.attach.scope.principalId,f.scope.principalId);assert.equal(f.options.attach.scope.contextBinding.endpointId,f.scope.contextBinding.endpointId);
  assert.equal(createHash('sha256').update(readFileSync(f.path)).digest('hex'),source.sha256);
  await assert.rejects(async()=>f.composition.selectSetupSource(source));
  assert.equal(JSON.stringify(f.composition.status()).includes(f.authentication.csrfToken),false);
 }finally{await f.cleanup();}
});
for(const mode of ['wrongOwner','wrongEndpoint','unknownAudience','missingConversation','expiredAdministration','revokedSession','explicitOldSession'])test('late binding refuses '+mode+' before driver creation',async()=>{
 const f=fixture(false,false);try{
  let source=currentSessionSetup(f);
  if(mode==='wrongOwner')f.authentication.principalId=randomUUID();if(mode==='unknownAudience')f.audienceScope='unknown';if(mode==='missingConversation')f.conversationId=null;if(mode==='expiredAdministration')f.authentication.adminExpiresAt=new Date(0).toISOString();if(mode==='revokedSession')f.denied=true;
  if(mode==='wrongEndpoint'||mode==='explicitOldSession'){const setup=JSON.parse(readFileSync(f.path));setup.attach.scope.contextBinding[mode==='wrongEndpoint'?'endpointId':'sessionId']=randomUUID();writeFileSync(f.path,JSON.stringify(setup));source={path:f.path,sha256:createHash('sha256').update(readFileSync(f.path)).digest('hex')};}
  f.composition.selectSetupSource(source);await assert.rejects(f.composition.startApprovedSession());assert.equal(f.driver,undefined);assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);
 }finally{await f.cleanup();}
});
test('session changed after late binding is refused by the broker recheck',async()=>{
 const f=fixture(false,false);try{
  f.composition.selectSetupSource(currentSessionSetup(f));const fetch=f.partition.fetch;let authReads=0;
  f.partition.fetch=(url,init)=>{if(url.endsWith('/api/auth/v1/session')&&++authReads===2)f.authentication.sessionId=randomUUID();return fetch(url,init);};
  await assert.rejects(f.composition.startApprovedSession());assert.equal(f.driver,undefined);
 }finally{await f.cleanup();}
});

test('a restart withdrawing audience between binding and admission cannot use earlier readiness',async()=>{
 const f=fixture(false,false);try{
  f.composition.selectSetupSource(currentSessionSetup(f));assert.equal((await f.composition.readiness()).ready,true);
  const fetch=f.partition.fetch;let authReads=0;
  f.partition.fetch=(url,init)=>{if(url.endsWith('/api/auth/v1/session')&&++authReads===2)f.audienceScope='unknown';return fetch(url,init);};
  await assert.rejects(f.composition.startApprovedSession(),error=>error.code==='audience_unavailable');assert.equal(f.composition.status().lastStartFailure,'audience_unavailable');assert.equal(f.driver,undefined);assert.equal(f.calls.some(path=>path.includes('/game-host/')),false);
 }finally{await f.cleanup();}
});
test('stop during session binding prevents pairing and selection cannot replace pending source',async()=>{
 const f=fixture(false,false);let resume;try{
  const source=currentSessionSetup(f);f.composition.selectSetupSource(source);const fetch=f.partition.fetch;
  f.partition.fetch=async(url,init)=>{if(url.endsWith('/api/auth/v1/session'))await new Promise(resolve=>{resume=resolve;});return fetch(url,init);};
  const starting=f.composition.startApprovedSession();await new Promise(r=>setImmediate(r));
  assert.throws(()=>f.composition.selectSetupSource(source));await f.composition.stop();resume();await assert.rejects(starting);assert.equal(f.driver,undefined);assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);
 }finally{resume?.();await f.cleanup();}
});
for(const mode of ['expired','wrongSession','changedContext','modifiedDescriptor','missingSetup'])test(mode+' refuses before owned driver creation',async()=>{
 const f=fixture();try{let composition=f.composition;
  if(mode==='expired')f.authentication.adminExpiresAt=new Date(0).toISOString();if(mode==='wrongSession')f.authentication.sessionId=randomUUID();if(mode==='changedContext')f.changed=true;if(mode==='modifiedDescriptor')writeFileSync(f.path,'{}');
  if(mode==='missingSetup')composition=createDesktopGameHostComposition({controls:{bindBroker(){}},partition:f.partition,sdk:f.sdk,sourceRevision:'b'.repeat(64),nativeDirectory:f.directory});
  await assert.rejects(composition.startApprovedSession());assert.equal(f.driver,undefined);assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);
 }finally{await f.cleanup();}
});
test('normal driver completion fences the composed broker and cannot remain authenticated/enabled',async()=>{
 const f=fixture(true);try{f.releaseNative();await f.composition.startApprovedSession();await f.driver.fence();await new Promise(r=>setTimeout(r,10));assert.equal(f.composition.status().enabled,false);assert.equal(f.composition.status().authenticated,false);assert.equal(f.shutdown,1);}finally{await f.cleanup();}
});
test('stop while native startup is pending fences before attachment and closes the late port',async()=>{
 const f=fixture();try{const start=f.composition.startApprovedSession();await new Promise(r=>setTimeout(r,20));const stop=f.composition.stop();f.releaseNative();await assert.rejects(start);await stop;assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);assert.equal(f.nativeClosed,1);assert.equal(f.shutdown,1);}finally{await f.cleanup();}
});

test('v3 explicitly selects finite pixel transfer while older setups remain references-only',async()=>{
 const f=fixture();try{currentSessionSetup(f);const setup=JSON.parse(readFileSync(f.path,'utf8'));setup.schemaVersion='lifestream.desktop-game-host-setup.v3';setup.frameTransfer={purpose:'simulatedGame/gameFramebuffer',maximumFrames:1,maximumBytes:2097152,maximumLongEdge:1024,maximumAgeMs:30000};writeFileSync(f.path,JSON.stringify(setup));f.composition.selectSetupSource({path:f.path,sha256:createHash('sha256').update(readFileSync(f.path)).digest('hex')});f.releaseNative();await f.composition.startApprovedSession();assert.deepEqual(f.options.frameTransfer,setup.frameTransfer);}finally{await f.cleanup();}
 for(const mode of ['purpose','count','bytes','extra']){const f=fixture();try{currentSessionSetup(f);const setup=JSON.parse(readFileSync(f.path,'utf8'));setup.schemaVersion='lifestream.desktop-game-host-setup.v3';setup.frameTransfer={purpose:'simulatedGame/gameFramebuffer',maximumFrames:1,maximumBytes:2097152,maximumLongEdge:1024,maximumAgeMs:30000};if(mode==='purpose')setup.frameTransfer.purpose='physicalWorld/camera';if(mode==='count')setup.frameTransfer.maximumFrames=0;if(mode==='bytes')setup.frameTransfer.maximumBytes=2097153;if(mode==='extra')setup.frameTransfer.path='unrelated';writeFileSync(f.path,JSON.stringify(setup));f.composition.selectSetupSource({path:f.path,sha256:createHash('sha256').update(readFileSync(f.path)).digest('hex')});await assert.rejects(f.composition.startApprovedSession());assert.equal(f.driver,undefined);}finally{await f.cleanup();}}
});
