import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
test('actual normal and compiled disabled launch composition with fake lowest ports',{timeout:480000},t=>{
 assert.equal(process.platform,'darwin');
 const ios=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'calendar-launch-'));
 t.diagnostic(temp);
 const build=spawnSync('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(temp,'core'),'build'],{cwd:join(ios,'native'),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(join(temp,'core-build.log'),build.stdout+build.stderr);assert.equal(build.status,0,build.stdout.slice(-4000)+build.stderr);
 const native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM'),products=join(temp,'core/Build/Products/Debug');
 const files=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner','NativeCalendarReadPermission','NativeCalendarSourceOwner','NativeCalendarSelectionSDK','NativeProtectedCalendarStorage','NativeCalendarAppComposition'].map(n=>join(native,n+'.swift'));
 const main=join(temp,'main.swift');writeFileSync(main,readFileSync(new URL('./native-calendar-launch-probe.swift',import.meta.url)));
 writeFileSync(join(temp,'compile-inputs.json'),JSON.stringify(Object.fromEntries([...files,main].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),null,2)+'\n');
 const v4=process.env.NATIVE_RECOVERY_V4;assert.ok(v4,'Supply actual Core-generated synthetic v4 snapshot');
 assert.equal(JSON.parse(readFileSync(v4)).version,4);assert.equal(createHash('sha256').update(readFileSync(v4)).digest('hex'),process.env.NATIVE_RECOVERY_V4_SHA256);
 const producer=process.env.CALENDAR_SELECTED_PRODUCER;
 assert.ok(producer,'Supply actual frozen Main producer bundle');
 const manifestBytes=readFileSync(join(producer,'MANIFEST.json'));
 assert.match(process.env.CALENDAR_SELECTED_PRODUCER_SHA256??'',/^[a-f0-9]{64}$/);assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),process.env.CALENDAR_SELECTED_PRODUCER_SHA256);
 const manifest=JSON.parse(manifestBytes);
 if(manifest.files){for(const [path,pin]of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(join(producer,path))).digest('hex'),pin);}
 else{
  assert.equal(manifest.status,'finalImplementedImmutableProducerRuntimeQualifiedForNativeJoinPendingFocusedReview');
  const inputs=[manifest.driver,manifest.runtime.manifest,...manifest.qualifiedInputs.driver.casePins];
  for(const input of inputs)assert.equal(createHash('sha256').update(readFileSync(join(producer,input.path.split('/').at(-1)))).digest('hex'),input.sha256);
  assert.equal(manifest.qualifiedInputs.tests.fail,0);assert.equal(manifest.qualifiedInputs.driver.noListeningSocket,true);
 }
 assert.equal(manifest.selectedDeliveryPin.digest,'27688770ff658204fac6198f17b6d8e09b482d33bc1abf282cafac751f59fc35');
 for(const mode of ['regular','recovery']){
  const compile=spawnSync('swiftc',['-profile-generate','-D','DEBUG',...(mode==='recovery'?['-D','LIFESTREAM_NATIVE_RECOVERY_DISABLED']:[]),'-I',products,join(products,'AssistantCore.o'),...files,main,'-o',join(temp,mode)],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  writeFileSync(join(temp,mode+'-compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stderr.slice(-7000));
  const run=spawnSync(join(temp,mode),[],{encoding:'utf8',timeout:15000,env:{...process.env,LLVM_PROFILE_FILE:join(temp,mode+'-%p.profraw')}});writeFileSync(join(temp,mode+'-run.log'),run.stdout+run.stderr);assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/recovery inactivity passed/);t.diagnostic(mode+' real registration passed');
 }
 const baseline=process.env.NATIVE_REGISTRATION_REVIEW_BASELINE;assert.ok(baseline,'Supply actual frozen reviewed source candidate for causal regression');
 assert.equal(createHash('sha256').update(readFileSync(join(baseline,'CANDIDATE-MANIFEST.json'))).digest('hex'),'b40d521d85cf7a020da113b33b5806a3afd1ae1d0abe9846f5163161bafa2ce7');
 const compositionRelative='apps/ios/ios/App/CapApp-SPM/Sources/CapApp-SPM/NativeCalendarAppComposition.swift';
 const beforeFile=join(baseline,'source',compositionRelative);assert.equal(createHash('sha256').update(readFileSync(beforeFile)).digest('hex'),'5528765ae23a773803c1d0c21d85f98ef3e4b4acf561137727003513a894179a');
 const beforeFiles=files.map(p=>p.endsWith('/NativeCalendarAppComposition.swift')?beforeFile:p);
 const beforeCompile=spawnSync('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...beforeFiles,main,'-o',join(temp,'before')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});writeFileSync(join(temp,'before-compile.log'),beforeCompile.stdout+beforeCompile.stderr);assert.equal(beforeCompile.status,0,beforeCompile.stderr.slice(-5000));
 const causal=[];
 for(const [binary,args,expected]of [['before',['reentry'],1],['regular',['reentry'],0],['before',[],0]]){
  const run=spawnSync(join(temp,binary),args,{encoding:'utf8',timeout:15000,env:{...process.env,LLVM_PROFILE_FILE:join(temp,binary+'-'+(args[0]??'positive')+'-%p.profraw')}});writeFileSync(join(temp,binary+'-'+(args[0]??'positive')+'.log'),run.stdout+run.stderr);assert.equal(run.status,expected,run.stdout+run.stderr);assert.match(run.stdout+run.stderr,expected===1?/reservation before resource callback refuses reentrant second SourceOwner/:args.length?/registration reentry causal fixture passed/:/recovery inactivity passed/);causal.push({binary,args,expected,actual:run.status});
 }
 writeFileSync(join(temp,'registration-causal-proof.json'),JSON.stringify({schemaVersion:'1.0.0',beforeCompositionSHA256:createHash('sha256').update(readFileSync(beforeFile)).digest('hex'),afterCompositionSHA256:createHash('sha256').update(readFileSync(join(native,'NativeCalendarAppComposition.swift'))).digest('hex'),sameFixtureSHA256:createHash('sha256').update(readFileSync(main)).digest('hex'),sameCoreObjectSHA256:createHash('sha256').update(readFileSync(join(products,'AssistantCore.o'))).digest('hex'),onlyProductionCompileInputChanged:compositionRelative,causal},null,2)+'\n');t.diagnostic('actual frozen beforeFAIL/current afterPASS and before positive with SAME fixture passed');
 for(const scenario of ['positive','denied','hidden']){
  const run=spawnSync(join(temp,'regular'),[scenario],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,CALENDAR_PRODUCER_DRIVER:manifest.driver.path,NATIVE_JOIN_EVIDENCE:temp,LLVM_PROFILE_FILE:join(temp,scenario+'-%p.profraw')}});
  writeFileSync(join(temp,'joined-'+scenario+'.log'),run.stdout+run.stderr);assert.equal(run.status,0,JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message})+'\n'+run.stdout+run.stderr);assert.match(run.stdout,new RegExp('joined '+scenario+' actual producer passed'));t.diagnostic('joined '+scenario+' actual persistent producer passed');
 }
 const plugin=readFileSync(join(native,'AssistantPlugin.swift'),'utf8');assert.match(plugin,/registerPluginInstance\(AssistantPlugin\(calendarRegistration:NativeCalendarAppComposition.standardRegistration\(\)\)\)/);
});
