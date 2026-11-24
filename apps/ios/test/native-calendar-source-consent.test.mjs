import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,copyFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function exec(cmd,args,options,log){const r=spawnSync(cmd,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,...options});writeFileSync(log,r.stdout+r.stderr);assert.equal(r.status,0,(r.stdout+r.stderr).slice(-5000));return r}
test('Native source consent uses one original store and survives actual Native process exits against frozen production',{timeout:900000},async t=>{
 assert.equal(process.platform,'darwin');const ios=fileURLToPath(new URL('../',import.meta.url)),work=process.env.CONSENT_TEST_EVIDENCE??mkdtempSync(join(tmpdir(),'native-consent-'));mkdirSync(work,{recursive:true});t.diagnostic(work);
 const core=join(work,'core'),products=join(core,'Build/Products/Debug');
 exec('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',core,'CODE_SIGNING_ALLOWED=NO','build'],{cwd:join(ios,'native')},join(work,'core-build.log'));
 const native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM'),names=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner','NativeCalendarReadPermission','NativeCalendarSourceOwner','NativeCalendarSelectionSDK','NativeProtectedCalendarStorage','NativeCalendarAppComposition'];
 const inputs=names.map(n=>{if(n==='NativeCalendarSourceOwner'&&process.env.CONSENT_REVIEW_BEFORE_SOURCE){assert.equal(hash(process.env.CONSENT_REVIEW_BEFORE_SOURCE),'f0a82310a01af32e0162197470f9cf618bc27eb0a80e3fc8777893025bff6d48');return process.env.CONSENT_REVIEW_BEFORE_SOURCE}return join(native,n+'.swift')}),main=join(work,'main.swift');copyFileSync(new URL('./native-calendar-source-consent-probe.swift',import.meta.url),main);
 writeFileSync(join(work,'compile-inputs.json'),JSON.stringify(Object.fromEntries([...inputs,main,...readdirSync(join(ios,'native/Sources/AssistantCore')).filter(n=>n.endsWith('.swift')).map(n=>join(ios,'native/Sources/AssistantCore',n))].map(p=>[p,hash(p)])),null,2)+'\n');
 const binary=join(work,'probe');exec('swiftc',['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o'),...inputs,main,'-o',binary],{},join(work,'native-compile.log'));
 exec(binary,['wire'],{env:{...process.env,CONSENT_SYNTHETIC_STATE:join(work,'wire-unused.json'),LLVM_PROFILE_FILE:join(work,'wire-%p.profraw')}},join(work,'wire.log'));
 if(process.env.CONSENT_COMPILE_ONLY==='1'){t.diagnostic('Actual Native consent Core/Root/Runtime/SourceOwner compilation passed; no joined runtime claim');return}
 const freeze=process.env.CONSENT_PRODUCER_FREEZE;assert.ok(freeze,'Supply exact final immutable Main producer freeze');assert.equal(hash(join(freeze,'MANIFEST.json')),process.env.CONSENT_PRODUCER_FREEZE_SHA256);
 const manifest=JSON.parse(readFileSync(join(freeze,'MANIFEST.json')));for(const k of ['driver','runtimeManifest'])assert.equal(hash(join(freeze,basename(manifest[k].path))),manifest[k].sha256);
 const evidence=[];
 async function scenario(which,stages){
  const proc=spawn('ssh',['-T','-o','BatchMode=yes','lifestream','/home/gg/.local/share/lifestream/toolchains/node-v24.21.0-linux-x64/bin/node','--experimental-transform-types',manifest.driver.path],{stdio:['pipe','pipe','pipe']});let serial=0,buffer=[],waiters=[],stderr='';proc.stderr.on('data',d=>stderr+=d);createInterface({input:proc.stdout}).on('line',line=>{const v=JSON.parse(line);const waiting=waiters.shift();if(waiting)waiting(v);else buffer.push(v)});proc.on('exit',()=>{for(const w of waiters.splice(0))w({kind:'driverExited'})});
  const ask=async frame=>{const id='parent-'+(++serial);proc.stdin.write(JSON.stringify({...frame,id})+'\n');const v=buffer.length?buffer.shift():await new Promise(r=>waiters.push(r));assert.equal(v.id,id,'Actual driver correlation');assert.notEqual(v.kind,'driverError',v.code);return v};
  const opened=await ask({command:'open',case:which});assert.equal(opened.schemaDigest,'97ef1a3167c4ed9e0c48f1046e3f423894f317d5c9932e36f6880b61a056aca7');
  const dir=join(work,which+'-'+stages[0]+(process.env.CONSENT_POST_POLICY_UNAVAILABLE==='1'?'-post-policy-unavailable':''));mkdirSync(dir);const state=join(dir,'original-synthetic-snapshot.json');
  try{
   for(const stage of stages){
    const child=spawn(binary,[stage],{env:{...process.env,CONSENT_DRIVER_OPEN:Buffer.from(JSON.stringify(opened)).toString('base64'),CONSENT_SYNTHETIC_STATE:state,LLVM_PROFILE_FILE:join(dir,stage+'-%p.profraw')},stdio:['pipe','pipe','pipe']});let errors='',chain=Promise.resolve();child.stderr.on('data',d=>errors+=d);
    createInterface({input:child.stdout}).on('line',line=>{chain=chain.then(async()=>{const frame=JSON.parse(line),reply=await ask(frame);if(frame.command==='request'&&['/api/runtime/v1/mobile-context','/api/runtime/v1/mobile-context-policy'].includes(frame.path))evidence.push({scenario:which,stage,path:frame.path,requestBodyBase64:frame.bodyBase64,result:reply});writeFileSync(join(work,'actual-producer-wire-in-progress.json'),JSON.stringify({syntheticOnly:true,entries:evidence})+'\n');child.stdin.write(JSON.stringify({...reply,id:frame.id})+'\n')}).catch(e=>{errors+='\n'+e.stack;child.kill()})});
    const timer=setTimeout(()=>child.kill(),80000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);await chain;writeFileSync(join(dir,stage+'.log'),errors);assert.equal(code,0,stage+': '+errors);assert.match(errors,new RegExp('PASS native '+stage));assert.ok(existsSync(state));copyFileSync(state,join(dir,stage+'-final-snapshot.json'));t.diagnostic(which+'/'+stage+' actual Native process passed');
   }
   const checkpoint=await ask({command:'checkpoint'});assert.equal(checkpoint.listening,false);writeFileSync(join(dir,'checkpoint.json'),JSON.stringify(checkpoint,null,2)+'\n');
  }finally{await ask({command:'close'});proc.stdin.end();const exit=await new Promise(r=>{if(proc.exitCode!==null)r(proc.exitCode);else proc.once('exit',r)});assert.equal(exit,0,stderr.slice(-2000))}
 }
 if(process.env.CONSENT_REVIEW_FOCUS==='cold'){
  await scenario('policyReadyWithoutConsent',['bootstrap','recover-request-approve','recover-approval-transmission']);
 }else if(process.env.CONSENT_REVIEW_FOCUS==='warm'){
  await scenario('policyReadyWithoutConsent',['warm-connect']);
 }else{
 await scenario('policyReadyWithoutConsent',['bootstrap','recover-request-approve','recover-approval-transmission','selection-sync','revoke','recover-revocation']);
 await scenario('deniedUnconfigured',['denied']);
 await scenario('policyReadyWithoutConsent',['cancel-stage']);
 await scenario('policyReadyWithoutConsent',['warm-connect']);
 await scenario('policyReadyWithoutConsent',['delayed-request']);
 await scenario('policyReadyWithoutConsent',['never-request','recover-request-approve']);
 }
 writeFileSync(join(work,'actual-producer-wire.json'),JSON.stringify({schemaVersion:'1.0.0',syntheticOnly:true,manifestSHA256:hash(join(freeze,'MANIFEST.json')),entries:evidence,noAuthBodiesOrHeaders:true,noDeviceOrLiveAcceptance:true},null,2)+'\n');
});

test('actual prior readers refuse new consent semantics and latest compiled disabled recovery reads them without writes',{timeout:480000},t=>{
 const work=process.env.CONSENT_JOIN_EVIDENCE??process.env.CONSENT_TEST_EVIDENCE;assert.ok(work,'Supply actual joined qualification evidence');
 const prior=process.env.CONSENT_PRIOR_NATIVE;assert.ok(prior,'Supply actual immutable prior native candidate');assert.equal(hash(join(prior,'CANDIDATE-MANIFEST.json')),'c9f2a9158297815d07e8f25d4762015d319caf52e3fde060383cef39aa3b5788');
 const manifest=JSON.parse(readFileSync(join(prior,'CANDIDATE-MANIFEST.json'))),states=[];
 for(const dir of readdirSync(work,{withFileTypes:true}).filter(e=>e.isDirectory()&&(e.name.startsWith('policyReady')||e.name.startsWith('deniedUnconfigured')))){for(const file of readdirSync(join(work,dir.name)).filter(n=>n.endsWith('.json'))){const path=join(work,dir.name,file),v=JSON.parse(readFileSync(path));if(v.calendarNative?.format==='CalendarNative/2')states.push(path)}}
 assert.ok(states.length>=25,'Actual new pending/reserved/settled snapshots required');
 const reader=join(work,'reader-main.swift');writeFileSync(reader,`import Foundation
import AssistantCore
final class Disk:HealthSnapshotStorage{var data:Data,writes=0;init(_ data:Data){self.data=data};func read()throws->Data?{data};func replace(_ bytes:Data)throws{writes+=1;data=bytes}}
for path in CommandLine.arguments.dropFirst(){let original=try Data(contentsOf:URL(fileURLWithPath:path)),raw=try JSONSerialization.jsonObject(with:original) as! [String:Any],disk=Disk(original),box=HealthOutbox(storage:disk)
do{try box.setHuman(UUID(uuidString:raw["lastHuman"] as! String)!);fatalError("old reader accepted new semantics")}catch{guard error as? HealthOutboxError == .corrupt,disk.writes==0,disk.data==original else{fatalError("old reader wrote or wrong refusal")}}}
print("PASS actual old reader refused all new semantics before writes")
`);
 for(const name of ['prior-v4','pre-v4']){
  const root=join(work,name);mkdirSync(root);
  for(const [path,pin]of Object.entries(manifest.allReviewed319SHA256).filter(([p])=>p.startsWith('apps/ios/native/'))){const source=join(prior,'source',path);assert.equal(hash(source),pin);const target=join(root,path.slice('apps/ios/native/'.length));mkdirSync(join(target,'..'),{recursive:true});copyFileSync(source,target)}
  if(name==='pre-v4'){const baseline=process.env.CONSENT_PRE4_HEALTH_OUTBOX;assert.ok(baseline);assert.equal(hash(baseline),'05c0e115135108e8d67ed14c6c851ab74d9115b8e26460e1e4cfa306fc40d948');copyFileSync(baseline,join(root,'Sources/AssistantCore/HealthOutbox.swift'))}
  const build=join(work,name+'-build'),products=join(build,'Build/Products/Debug');exec('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',build,'CODE_SIGNING_ALLOWED=NO','build'],{cwd:root},join(work,name+'-build.log'));
  const binary=join(work,name+'-reader');exec('swiftc',['-profile-generate','-I',products,join(products,'AssistantCore.o'),reader,'-o',binary],{},join(work,name+'-compile.log'));exec(binary,states,{env:{...process.env,LLVM_PROFILE_FILE:join(work,name+'-%p.profraw')}},join(work,name+'-run.log'));t.diagnostic(name+' actual reader refused '+states.length+' new semantic snapshots; zero writes');
 }
 const inputs=JSON.parse(readFileSync(join(work,'compile-inputs.json'))),native=Object.keys(inputs).filter(p=>p.includes('/CapApp-SPM/Sources/'));
 for(const [p,pin]of Object.entries(inputs).filter(([p])=>p.endsWith('.swift')))assert.equal(hash(p),pin,'Actual qualified Native/Core inputs must stay frozen');
 const products=join(work,'core/Build/Products/Debug'),binary=join(work,'latest-disabled-reader');exec('swiftc',['-profile-generate','-D','DEBUG','-D','LIFESTREAM_NATIVE_RECOVERY_DISABLED','-I',products,join(products,'AssistantCore.o'),...native,join(work,'main.swift'),'-o',binary],{},join(work,'latest-disabled-compile.log'));
 exec(binary,['recovery-read',...states],{env:{...process.env,CONSENT_SYNTHETIC_STATE:join(work,'not-opened.json'),LLVM_PROFILE_FILE:join(work,'disabled-%p.profraw')}},join(work,'latest-disabled-run.log'));
 writeFileSync(join(work,'codec-qualification.json'),JSON.stringify({schemaVersion:'1.0.0',oldManifestSHA256:hash(join(prior,'CANDIDATE-MANIFEST.json')),snapshotSHA256:Object.fromEntries(states.map(p=>[p,hash(p)])),latestNativeCoreInputSHA256:inputs,oldReadersRefusedBeforeWrites:true,latestCompiledDisabledReadsWithoutWrites:true,noOSDataOrLiveActions:true},null,2)+'\n');
});
