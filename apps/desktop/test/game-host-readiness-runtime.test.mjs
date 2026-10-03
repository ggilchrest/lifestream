import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
const supported=process.platform==='win32'&&process.env.PLAYWRIGHT_MODULE&&process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE;
test('packaged main reports restart privacy loss and records/fences rejection before its owned dialog',{skip:!supported,timeout:30000},async()=>{
 const {_electron}=await import(process.env.PLAYWRIGHT_MODULE),executable=process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE,application=join(dirname(executable),'resources','app'),main=join(application,'main.cjs');
 const directory=mkdtempSync(join(tmpdir(),'ct-readiness-runtime-')),frames=join(directory,'frames');mkdirSync(frames);
 const sourceRevision=JSON.parse(readFileSync(join(application,'build.json'),'utf8')).sourceRevision,scope=observe().scope;
 const endpoint={endpointId:scope.contextBinding.endpointId,ownership:'personal',privacyClass:'personal',health:'healthy'};
 const setup={schemaVersion:'lifestream.desktop-game-host-setup.v2',sourceRevision,approvalRef:'synthetic-readiness-only-no-native-launch',attach:{protocol:'lifestream.game-host.v1',hostId:randomUUID(),scope:structuredClone(scope),pinsDigest:'a'.repeat(64),sourceRevision:'b'.repeat(64),providerRef:'synthetic-readiness-only'},binding:{mode:'currentOwnerSession'},expiresAt:new Date(Date.now()+20000).toISOString(),paths:{emulator:join(directory,'unavailable.exe'),romFile:join(directory,'unavailable.zip'),configFile:join(directory,'unavailable.ini'),frameDirectory:frames},evidence:{directory,sourceFiles:[]},native:{port:43183,connectionTimeoutMs:1000,authenticationTimeoutMs:1000,sessionDurationMs:5000,bounds:{maxScreenshotBytes:2097152,screenshotQueueByteBudget:2097152,maxScreenshotLongEdge:1024},romSha1:'d'.repeat(40)}};
 setup.attach.scope.contextBinding.sessionId=null;setup.attach.scope.contextBinding.conversationId=null;
 const setupFile=join(directory,'setup.json');writeFileSync(setupFile,JSON.stringify(setup));
 const app=await _electron.launch({executablePath:executable,args:['--url','http://127.0.0.1:43182/control/#account','--user-data-dir='+join(directory,'disposable-profile')]});
 const logs=[];let output='';app.process().stdout.on('data',bytes=>{output+=bytes;let end;while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);try{logs.push(JSON.parse(line));}catch{}}});
 try{
  const page=await app.firstWindow();assert.equal(await page.evaluate(()=>typeof require),'undefined');
  await app.evaluate(({net,dialog,BrowserWindow},data)=>{
   const {EventEmitter}=process.getBuiltinModule('events');globalThis.readinessOnlyProbe={declared:true,routes:[],dialogs:[],release:null};
   // Only this disposable process uses synthetic read responses/dialog promises.
   // Never import an owner profile, expose tokens or allocate a native fixture.
   net.request=options=>{
    const req=new EventEmitter();req.abort=()=>{};req.end=()=>queueMicrotask(()=>{
     const probe=globalThis.readinessOnlyProbe,route=new URL(options.url).pathname;probe.routes.push(options.method+' '+route);
     if(options.method!=='GET')throw Error('Synthetic readiness must stay read-only');
     const value=route==='/api/auth/v1/session'?{principalId:data.scope.principalId,sessionId:data.scope.contextBinding.sessionId,owner:true,adminExpiresAt:new Date(Date.now()+60000).toISOString(),csrfToken:'SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL_1234567890'}:{ended:false,conversationId:data.scope.contextBinding.conversationId,revision:1,endpoint:data.endpoint,runtimeSelfContext:{audienceScope:probe.declared?'authenticatedSession':'unknown',sourceRevision:'c'.repeat(64)}};
     const response=new EventEmitter();response.statusCode=200;response.headers={'content-type':['application/json']};req.emit('response',response);queueMicrotask(()=>{response.emit('data',Buffer.from(JSON.stringify(value)));response.emit('end');});
    });return req;
   };
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[data.setupFile]});
   dialog.showMessageBox=async(window,options)=>{const probe=globalThis.readinessOnlyProbe;probe.dialogs.push({owned:window===BrowserWindow.getAllWindows()[0],...options});return new Promise(resolve=>{probe.release=()=>resolve({response:0});});};
  },{scope,endpoint,setupFile});
  const read=()=>app.evaluate(async(_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.readiness(),main);
  const before=await read();assert.equal(before.sessionReady,true);assert.equal(before.ready,false);assert.equal(before.blockingReason,'setup_required');
  await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('game-host-setup').click());
  const deadline=Date.now()+2000;let selected;
  do{selected=await read();if(selected.nativeConfigured)break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(selected.ready,true);
  await app.evaluate(()=>{globalThis.readinessOnlyProbe.declared=false;});
  const afterRestart=await read();assert.equal(afterRestart.ready,false);assert.equal(afterRestart.sessionReady,false);assert.equal(afterRestart.blockingReason,'audience_unavailable');
  await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('game-host-start').click());
  let proof;const rejectedDeadline=Date.now()+3000;
  do{proof=await app.evaluate(({Menu},path)=>({status:process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.status(),probe:globalThis.readinessOnlyProbe,startEnabled:Menu.getApplicationMenu().getMenuItemById('game-host-start').enabled}),main);if(proof.probe.dialogs.length)break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<rejectedDeadline);
  assert.equal(proof.status.lastStartFailure,'audience_unavailable');assert.equal(proof.status.enabled,false);assert.equal(proof.status.nativeStage,null);assert.equal(proof.startEnabled,false);assert.equal(proof.probe.dialogs[0].owned,true);assert.match(proof.probe.dialogs[0].detail,/If you are alone/);assert.ok(proof.probe.routes.every(route=>route.startsWith('GET ')));
  await app.evaluate(()=>globalThis.readinessOnlyProbe.release());await new Promise(resolve=>setTimeout(resolve,50));
  const rejected=logs.find(log=>log.kind==='gameHostStartRejected');assert.equal(rejected.blockingReason,'audience_unavailable');assert.equal(rejected.attachmentAccepted,false);assert.equal(logs.find(log=>log.kind==='gameHostStartCleanup').stopCompleted,true);assert.ok(logs.some(log=>log.kind==='gameHostDialogDismissed'));assert.equal(JSON.stringify(logs).includes('SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL'),false);
  if(process.env.LIFESTREAM_READINESS_PROOF_PATH)writeFileSync(process.env.LIFESTREAM_READINESS_PROOF_PATH,JSON.stringify({status:'passed',sourceRevision,qualification:'Actual packaged main/window/menu wiring; synthetic read-only session responses and dialog promises; no real owner authority or native launch',restartReadiness:afterRestart,logs,nativeStarts:0,controllerCalls:0},null,2)+'\n');
 }finally{await app.close();}
});
