import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gameHostMessage,GAME_HOST_PROTOCOL as protocol} from '../../../packages/contracts/src/game-host.ts';
import {WindowsGameHostClient} from '../../../packages/providers-bizhawk/src/game-host-client.ts';
import {GameFrameCustody} from '../../../packages/providers-bizhawk/src/frame-custody.ts';
import {createDesktopGameHostComposition} from '../game-host-composition.cjs';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
const {installGameHostControls}=createRequire(import.meta.url)('../game-host-controls.cjs');
const origin='http://127.0.0.1:43182',json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function fixture(resolveDone=false){
 const directory=mkdtempSync(join(tmpdir(),'desktop-game-composition-')),frames=join(directory,'frames');mkdirSync(frames);
 const scope=observe().scope,endpoint={endpointId:scope.contextBinding.endpointId,ownership:'personal',privacyClass:'personal',health:'healthy'},sourceRevision='b'.repeat(64),runtimeSourceRevision='c'.repeat(64);
 const attach={protocol,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-composition',sourceRevision};
 const authentication={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,owner:true,adminExpiresAt:new Date(Date.now()+60000).toISOString(),csrfToken:'SYNTHETIC_ONLY_NO_REAL_CREDENTIAL_1234567890'};
 const calls=[],attachmentId=randomUUID();let changed=false,denied=false,driver,options,nativeClosed=0,shutdown=0,releaseNative;
 const nativeGate=new Promise(resolve=>{releaseNative=resolve;});
 const partition={async fetch(url,init){const route=new URL(url).pathname;calls.push(route);
  if(denied)return new Response(JSON.stringify({code:'authentication_required'}),{status:401,headers:{'content-type':'application/json'}});
  if(route==='/api/auth/v1/session')return json(authentication);
  if(route==='/api/runtime/v1/session-context')return json({ended:changed,revision:1,endpoint,runtimeSelfContext:{sourceRevision:runtimeSourceRevision}});
  if(route.endsWith('/attach'))return json({protocol,attachmentId,expiresAt:new Date(Date.now()+4000).toISOString(),pollMs:1000,maxMessageBytes:131072});
  if(route.endsWith('/next'))return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('fixture cancellation')),{once:true});if(init.signal.aborted)reject(Error('fixture cancellation'));});
  if(route.endsWith('/detach'))return json({protocol,attachmentId,fenced:true});throw Error('unexpected fixture route');
 }};
 const handlers=new Map(),frame={url:origin+'/control/'},window=new EventEmitter();window.isDestroyed=()=>false;window.webContents={mainFrame:frame,send(){}};
 const controls=installGameHostControls({ipcMain:{handle:(key,value)=>handlers.set(key,value),removeHandler:key=>handlers.delete(key)},window,origin});
 const sdk={gameHostMessage,GameFrameCustody,createOwnedWindowsGameHostDriver(value){options=value;
  const client=new WindowsGameHostClient({attach:value.attach,fetchAuthenticated:value.fetchAuthenticated,isScopeCurrent:value.isScopeCurrent,sourceIsQualified:()=>true,nativeBoundary:{providerRef:attach.providerRef,maxDurationMs:5000,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>true,reconcileEffect:async()=>true,admitRelease:async()=>true},openNative:async()=>{await nativeGate;return {adapter:{observe:async()=>{throw Error('no gameplay fixture');}},close(){nativeClosed++;}};},shutdownExactOldLease:async()=>{shutdown++;},httpTimeoutMs:1000,sessionDurationMs:5000,shutdownTimeoutMs:1000});
  const running=client.run();driver={ready:client.ready,done:resolveDone?running.catch(()=>{}):running,fence:async()=>{client.close();await driver.done.catch(()=>{});},get snapshot(){return client.snapshot;}};return driver;
 }};
 const setup={schemaVersion:'lifestream.desktop-game-host-setup.v1',sourceRevision,approvalRef:'synthetic-fixture-not-a-live-grant',attach,binding:{revision:1,endpoint,runtimeSourceRevision},expiresAt:new Date(Date.now()+5000).toISOString(),paths:{emulator:join(directory,'emulator.exe'),configFile:join(directory,'fixture.ini'),romFile:join(directory,'fixture.zip'),frameDirectory:frames},evidence:{directory,sourceFiles:[]},native:{port:43183,connectionTimeoutMs:1000,authenticationTimeoutMs:1000,sessionDurationMs:5000,bounds:{maxScreenshotBytes:2097152,screenshotQueueByteBudget:4194304,maxScreenshotLongEdge:1024},romSha1:'d'.repeat(40)}};
 const path=join(directory,'setup.json');writeFileSync(path,JSON.stringify(setup));
 const setupSource={path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
 const composition=createDesktopGameHostComposition({controls,partition,sdk,sourceRevision,nativeDirectory:directory,setupSource});
 return {composition,calls,handlers,window,frame,authentication,scope,setup,path,setupSource,sdk,partition,controls,directory,get driver(){return driver;},get options(){return options;},get nativeClosed(){return nativeClosed;},get shutdown(){return shutdown;},releaseNative,set denied(value){denied=value;},set changed(value){changed=value;},async cleanup(){releaseNative();await composition.stop();window.emit('closed');rmSync(directory,{recursive:true,force:true});}};
}
test('composed main IPC reads actual supplied session metadata without start or credential export',async()=>{
 const f=fixture();try{const event={sender:f.window.webContents,senderFrame:f.frame};const result=await f.handlers.get('game-host-readiness')(event);
  assert.equal(result.ready,true);assert.equal(result.sessionId,f.scope.contextBinding.sessionId);assert.equal(f.driver,undefined);assert.equal(JSON.stringify(result).includes(f.authentication.csrfToken),false);
  assert.equal((await f.composition.readiness()).authenticated,true);assert.equal(f.composition.status().enabled,false);
  const before=f.calls.length;assert.equal((await f.handlers.get('game-host-readiness')({sender:f.window.webContents,senderFrame:{url:f.frame.url}})).ready,false);assert.equal(f.calls.length,before);
 }finally{await f.cleanup();}assert.equal(f.handlers.has('game-host-readiness'),false);
});
test('composition waits for real client native connection and backend attachment, then stop fences once',async()=>{
 const f=fixture();try{let settled=false;const start=f.composition.startApprovedSession().then(value=>{settled=true;return value;});await new Promise(r=>setTimeout(r,20));
  assert.equal(settled,false);assert.equal(f.driver.snapshot.attached,false);assert.equal(f.calls.some(path=>path.endsWith('/attach')),false);f.releaseNative();
  const status=await start;assert.equal(status.nativeConnected,true);assert.equal(status.attached,true);assert.equal(f.options.fetchAuthenticated instanceof Function,true);
  assert.equal(f.options.native.pairingSecret.every(byte=>byte===0),true);
  await f.composition.stop();await f.composition.stop();assert.equal(f.composition.status().enabled,false);assert.equal(f.driver.snapshot.attached,false);assert.equal(f.shutdown,1);assert.equal(f.nativeClosed,1);await assert.rejects(f.composition.startApprovedSession());
 }finally{await f.cleanup();}
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
