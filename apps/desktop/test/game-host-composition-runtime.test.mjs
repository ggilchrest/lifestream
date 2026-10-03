import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
import {gameHostDigest,GAME_HOST_PROTOCOL as protocol} from '../../../packages/contracts/src/game-host.ts';
const supported=process.platform==='win32'&&process.env.PLAYWRIGHT_MODULE&&process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
test('actual packaged Electron binds the broker, exposes read-only readiness and shows its window',{skip:!supported,timeout:30000},async()=>{
 const {_electron}=await import(process.env.PLAYWRIGHT_MODULE),profile=mkdtempSync(join(tmpdir(),'native-composition-readiness-'));
 const app=await _electron.launch({executablePath:process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE,args:['--url','http://127.0.0.1:43182/control/#account','--user-data-dir='+profile]});
 try{const page=await app.firstWindow();await page.waitForLoadState();
  const proof=await app.evaluate(({BrowserWindow,Menu})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return {visible:w.isVisible(),sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,readinessMenu:!!Menu.getApplicationMenu().getMenuItemById('game-host-readiness'),startEnabled:Menu.getApplicationMenu().getMenuItemById('game-host-start').enabled};});
  assert.deepEqual(proof,{visible:true,sandbox:true,contextIsolation:true,nodeIntegration:false,readinessMenu:true,startEnabled:false});
  const result=await page.evaluate(async()=>({readiness:await window.lifestreamDesktop.gameHostReadiness(),status:await window.lifestreamDesktop.gameHostStatus(),hasStart:typeof window.lifestreamDesktop.startGameHost!=='undefined',hasSetup:typeof window.lifestreamDesktop.selectSetupSource!=='undefined'}));
  assert.equal(result.hasStart,false);assert.equal(result.hasSetup,false);assert.equal(result.status.enabled,false);assert.equal(result.readiness.authenticated,false);assert.equal(result.readiness.ready,false);assert.equal('csrfToken' in result.readiness,false);
 }finally{await app.close();}
});
test('actual Electron post-sign-in selection binds current session and authenticates owned graphical BizHawk at frame zero',{skip:!supported||!process.env.LIFESTREAM_NATIVE_COMPOSITION_FIXTURE,timeout:45000},async()=>{
 const {_electron}=await import(process.env.PLAYWRIGHT_MODULE),fixture=JSON.parse(readFileSync(process.env.LIFESTREAM_NATIVE_COMPOSITION_FIXTURE,'utf8'));
 // This is real packaged main/native I/O with an explicitly synthetic HTTP auth
 // fixture in a disposable desktop profile. It does not qualify G's live login,
 // model, gameplay, ordinary save menus, journal or memory.
 const executable=process.env.LIFESTREAM_TEST_DESKTOP_EXECUTABLE,application=join(dirname(executable),'resources','app'),build=JSON.parse(readFileSync(join(application,'build.json'),'utf8'));
 const request=observe(),scope=request.scope,endpoint={endpointId:scope.contextBinding.endpointId,ownership:'personal',privacyClass:'personal',health:'healthy'},runtimeSourceRevision='c'.repeat(64),pinsDigest=createHash('sha256').update(JSON.stringify(fixture.sourceFiles)).digest('hex');
 const attach={protocol,hostId:randomUUID(),scope,pinsDigest,providerRef:'synthetic-desktop-composition',sourceRevision:pinsDigest};
 const pixels=process.env.LIFESTREAM_NATIVE_FRAME_TRANSFER_QUALIFICATION==='1';
 const setup={schemaVersion:pixels?'lifestream.desktop-game-host-setup.v3':'lifestream.desktop-game-host-setup.v2',sourceRevision:build.sourceRevision,approvalRef:'synthetic-readonly-composition-qualification',attach:structuredClone(attach),binding:{mode:'currentOwnerSession'},expiresAt:new Date(Date.now()+30000).toISOString(),paths:fixture.paths,evidence:{directory:fixture.directory,sourceFiles:fixture.sourceFiles},native:fixture.native,...(pixels?{frameTransfer:{purpose:'simulatedGame/gameFramebuffer',maximumFrames:1,maximumBytes:2097152,maximumLongEdge:1024,maximumAgeMs:30000}}:{})};
 setup.attach.scope.contextBinding.sessionId=null;setup.attach.scope.contextBinding.conversationId=null;
 const setupFile=join(fixture.directory,'setup.json');writeFileSync(setupFile,JSON.stringify(setup));
 request.scope=scope;request.payload.expectedPinsDigest=pinsDigest;
 const profile=join(fixture.directory,'desktop-profile');mkdirSync(profile);
 let app,proof={qualification:'Actual packaged Electron composition and owned graphical/native peer; synthetic auth/backend fixture; zero controller inputs; not live G/Tifa acceptance'};
 try{
  app=await _electron.launch({executablePath:executable,args:['--url','http://127.0.0.1:43182/control/#account','--user-data-dir='+profile]});
  await app.firstWindow();
  await app.evaluate(({net},data)=>{
   const {EventEmitter}=process.getBuiltinModule('events');const fixtureRequire=process.getBuiltinModule('module').createRequire(data.contractModule);globalThis.nativeCompositionProbe={routes:[],observations:0,frameUploads:0,frameBytes:0};let sent=false;
   // Patch net only in this disposable qualification process. Production main
   // and Chromium credentials/session storage are never read or imported.
   net.request=options=>{
    const req=new EventEmitter();let aborted=false;req.abort=()=>{if(!aborted){aborted=true;req.emit('error',Error('synthetic request cancelled'));}};
    req.end=body=>queueMicrotask(()=>{
     if(aborted)return;const route=new URL(options.url).pathname,probe=globalThis.nativeCompositionProbe;probe.routes.push(route);
     if(options.origin!=='http://127.0.0.1:43182'||options.credentials!=='include')throw Error('Missing ordinary session-bound origin');
     let value;
     if(route==='/api/auth/v1/session')value={principalId:data.attach.scope.principalId,sessionId:data.attach.scope.contextBinding.sessionId,owner:true,adminExpiresAt:new Date(Date.now()+30000).toISOString(),csrfToken:'SYNTHETIC_COMPOSITION_ONLY_NO_REAL_CREDENTIAL_123456'};
     else if(route==='/api/runtime/v1/session-context')value={conversationId:data.attach.scope.contextBinding.conversationId,ended:false,revision:1,endpoint:data.endpoint,runtimeSelfContext:{audienceScope:'authenticatedSession',sourceRevision:data.runtimeSourceRevision}};
     else if(route.endsWith('/attach'))value={protocol:data.protocol,attachmentId:data.attachmentId,expiresAt:new Date(Date.now()+10000).toISOString(),pollMs:1000,maxMessageBytes:131072};
     else if(route.endsWith('/next')){if(sent)return;sent=true;data.request.deadlineAt=new Date(Date.now()+4500).toISOString();value={protocol:data.protocol,kind:'command',attachmentId:data.attachmentId,commandId:data.commandId,requestDigest:fixtureRequire(data.contractModule).gameHostDigest(data.request),expiresAt:data.request.deadlineAt,request:data.request};data.commandExpiry=data.request.deadlineAt;}
     else if(route.endsWith('/admit'))value={...JSON.parse(body),admitted:true,expiresAt:data.commandExpiry};
     else if(route.includes('/game-host/frame/')){const identity=fixtureRequire(data.contractModule).parseGameHostFramePath(route);if(!identity||!Buffer.isBuffer(body))throw Error('Invalid actual native frame');const png=Buffer.from(body),disk=process.getBuiltinModule('fs').readFileSync(process.getBuiltinModule('path').join(data.frameDirectory,identity.mediaRef+'.png'));try{if(!png.equals(disk))throw Error('Uploaded frame differs from actual native custody');probe.frameUploads++;probe.frameBytes=png.length;probe.frameDigest=process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex');probe.frameMediaRef=identity.mediaRef;value={accepted:true};}finally{png.fill(0);disk.fill(0);}}
     else if(route.endsWith('/result')){const message=JSON.parse(body);if(data.pixels){const shot=message.result.outcome.payload.observation.screenshots[0];if(probe.frameDigest!==shot.sha256||probe.frameMediaRef!==shot.mediaRef)throw Error('Result lacks exact uploaded frame');}probe.observations++;probe.frameNumber=message.result.outcome.payload?.observation?.frameNumber;value={protocol:data.protocol,attachmentId:data.attachmentId,commandId:message.commandId,resultDigest:message.resultDigest,accepted:true};}
     else if(route.endsWith('/detach'))value={protocol:data.protocol,attachmentId:data.attachmentId,fenced:true};else throw Error('Unexpected synthetic route');
     const response=new EventEmitter();response.statusCode=200;response.headers={'content-type':['application/json']};req.emit('response',response);queueMicrotask(()=>{if(!aborted){response.emit('data',Buffer.from(JSON.stringify(value)));response.emit('end');}});
    });return req;
   };
  },{attach,endpoint,runtimeSourceRevision,protocol,pixels,frameDirectory:fixture.paths.frameDirectory,attachmentId:randomUUID(),commandId:randomUUID(),request,contractModule:join(application,'node_modules','@lifestream','contracts','dist','game-host.js')});
  const mainModule=join(application,'main.cjs');
  const before=await app.evaluate(async(_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.readiness(),mainModule);assert.equal(before.ready,false);assert.equal(before.sessionReady,true);assert.equal(before.blockingReason,'setup_required');assert.equal(before.attached,false);
  assert.equal(before.nativeConfigured,false);
  await app.evaluate(({dialog,Menu},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});Menu.getApplicationMenu().getMenuItemById('game-host-setup').click();},setupFile);
  const selectedDeadline=Date.now()+2000;let selected;
  do{selected=await app.evaluate(({Menu},path)=>({configured:process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.configured,startEnabled:Menu.getApplicationMenu().getMenuItemById('game-host-start').enabled}),mainModule);if(selected.configured&&selected.startEnabled)break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<selectedDeadline);
  assert.deepEqual(selected,{configured:true,startEnabled:true});
  assert.equal(JSON.parse(readFileSync(setupFile)).attach.scope.contextBinding.sessionId,null);

  const connected=await app.evaluate(async(_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.startApprovedSession(),mainModule);assert.equal(connected.attached,true);assert.equal(connected.nativeConnected,true);
  const deadline=Date.now()+5000;let observed;
  do{observed=await app.evaluate(()=>globalThis.nativeCompositionProbe);if(observed.observations===1)break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<deadline);
  assert.equal(observed.observations,1);assert.equal(observed.frameNumber,0);if(pixels){assert.equal(observed.frameUploads,1);assert.ok(observed.frameBytes>57);assert.match(observed.frameDigest,/^[a-f0-9]{64}$/);const uploaded=observed.routes.findIndex(path=>path.includes('/game-host/frame/'));assert.ok(uploaded>=0);assert.ok(uploaded<observed.routes.findIndex(path=>path.endsWith('/result')));}assert.equal(observed.routes.some(path=>path.endsWith('/admit')),true);
  await app.evaluate(async(_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.stop('qualificationComplete'),mainModule);
  const after=await app.evaluate((_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.status(),mainModule);assert.equal(after.enabled,false);assert.equal(after.attached,false);
  const closedDeadline=Date.now()+3000;let native;
  do{try{native=JSON.parse(readFileSync(join(fixture.directory,'native-evidence.json'),'utf8'));}catch{}if(native?.event==='closed')break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<closedDeadline);
  assert.equal(native?.event,'closed');assert.equal(native.scope.contextBinding.sessionId,scope.contextBinding.sessionId);assert.equal(native.scope.contextBinding.conversationId,scope.contextBinding.conversationId);assert.equal(native.paused,true);assert.equal(native.frameNumber,0);assert.equal(Object.values(native.buttons).every(value=>value===false),true);
  assert.equal(hash(setupFile),createHash('sha256').update(JSON.stringify(setup)).digest('hex'));assert.equal(hash(fixture.originalSave),fixture.saveSha256);assert.equal(hash(fixture.workingSave),fixture.saveSha256);
  proof={...proof,status:'passed',sourceRevision:build.sourceRevision,postSigninNativeMenuSelection:true,currentSessionBindingVerified:true,setupFileUnchanged:hash(setupFile)===createHash('sha256').update(JSON.stringify(setup)).digest('hex'),acceptedObservations:1,frameNumber:0,ownedFrameTransfer:pixels,frameUploads:observed.frameUploads,frameBytes:observed.frameBytes,frameDigest:observed.frameDigest??null,nativeClosedPausedNeutral:true,sourceFiles:fixture.sourceFiles,originalSaveUnchanged:true,workingSaveUnchanged:true,routes:observed.routes};
 }catch(error){let startup,transport;try{startup=await app?.evaluate((_electron,path)=>process.getBuiltinModule('module').createRequire(path)(path).gameHostComposition.status(),join(application,'main.cjs'));transport=await app?.evaluate(()=>globalThis.nativeCompositionProbe);}catch{}proof={...proof,status:'failed_or_unverified',error:error.message,startup,transport};throw error;}
 finally{
  await app?.close();
  // Close only the exact qualification child/config, through its ordinary GUI.
  const escaped=fixture.paths.configFile.replaceAll("'","''"),emulator=fixture.paths.emulator.replaceAll("'","''");
  const cleanup=`$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter "name='EmuHawk.exe'" | Where-Object {$_.ExecutablePath -eq '${emulator}' -and $_.CommandLine.Contains('${escaped}')}); foreach($row in $rows){$p=Get-Process -Id $row.ProcessId; if(-not $p.CloseMainWindow()){throw 'qualification_child_close_refused'};if(-not $p.WaitForExit(5000)){throw 'qualification_child_close_pending'}}; [pscustomobject]@{exactChildrenClosed=$rows.Count}|ConvertTo-Json -Compress`;
  try{proof.cleanup=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cleanup],{windowsHide:true,encoding:'utf8',timeout:8000}));}catch(error){proof.cleanupError=error.message;}
  writeFileSync(join(fixture.directory,'composition-qualification.json'),JSON.stringify(proof,null,2)+'\n');
 }
});
