import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,existsSync,readdirSync} from 'node:fs';
import {join,basename,dirname} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {createInterface} from 'node:readline';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const names=['ConnectionStore','NativeTransport','NativeHealthInventory','NativeHealthPolicy','NativeHealthDelivery','NativeHealthSessionOwner','HealthKitCollector','NativeCalendarAdmission','NativeCalendarPolicy','NativeCalendarAcquisitionOwner','NativeSharedOutboxOwner','NativeHealthRuntime','NativeHealthHost','NativeHealthConnectionOwner','NativeCalendarReadPermission','NativeCalendarSourceOwner','NativeCalendarSelectionSDK','NativeProtectedCalendarStorage','NativeCalendarAppComposition'];
test('existing remote Health setup uses original app owners with actual producer and fake device ports',{timeout:900000},async t=>{
 if(process.platform!=='darwin'){t.skip('Xcode/Foundation host required');return}
 const freeze=process.env.HEALTH_EXISTING_PRODUCER_FREEZE,prior=process.env.HEALTH_EXISTING_PRIOR_COMPONENT;
 assert.ok(freeze&&prior,'Supply retained actual producer freeze and immutable reviewed prior Native component; no fabricated authority');
 assert.equal(hash(join(freeze,'MANIFEST-r2.json')),'e189365acd0cb6879868c39ddc9e0ecddd1029839b4812246130660ececcc668');
 const producer=JSON.parse(readFileSync(join(freeze,'MANIFEST-r2.json')));for(const k of ['driver','runtimeManifest'])assert.equal(hash(join(freeze,basename(producer[k].path))),producer[k].sha256);
 const oldCandidate=join(prior,'source-candidate-r1'),oldManifestPath=join(oldCandidate,'CANDIDATE-MANIFEST.json');assert.equal(hash(oldManifestPath),'f0aa1e7b257dba26b2683b37ce53594ae0419aeb66af60eb1c39b6fa0cc2618f');
 assert.equal(hash(join(prior,'legacy-share-fixture-from-core-regression-r1.json')),'bee36e6ca2521cf354ebca83cdfb6107feb284ac3fcea43ef92156f1c5f6aa28');
 const oldManifest=JSON.parse(readFileSync(oldManifestPath));for(const [p,h] of Object.entries(oldManifest.allReviewed329SHA256))assert.equal(hash(join(oldCandidate,'source',p)),h);
 assert.equal(hash(join(prior,'qualification-r7/compile-inputs.json')),oldManifest.evidenceSHA256['qualification-r7/compile-inputs.json']);
 const oldInputs=JSON.parse(readFileSync(join(prior,'qualification-r7/compile-inputs.json'))),oldMain=join(prior,'qualification-r7/main.swift');assert.equal(hash(oldMain),oldInputs[oldMain]);
 const ios=fileURLToPath(new URL('../',import.meta.url)),work=process.env.HEALTH_EXISTING_TEST_EVIDENCE??mkdtempSync(join(tmpdir(),'native-health-existing-'));mkdirSync(work,{recursive:true});t.diagnostic(work);
 function execute(cmd,args,log,options={}){const r=spawnSync(cmd,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,...options});writeFileSync(join(work,log),r.stdout+r.stderr);assert.equal(r.status,0,(r.stdout+r.stderr).slice(-6000));return r}
 execute('xcodebuild',['-scheme','AssistantCore','-configuration','Debug','-destination','platform=macOS','-derivedDataPath',join(work,'core'),'CODE_SIGNING_ALLOWED=NO','build'],'core-build.log',{cwd:join(ios,'native')});
 const products=join(work,'core/Build/Products/Debug'),native=join(ios,'ios/App/CapApp-SPM/Sources/CapApp-SPM'),currentInputs=names.map(n=>join(native,n+'.swift'));
 copyFileSync(new URL('./native-health-existing-source-probe.swift',import.meta.url),join(work,'main.swift'));
 const base=['-profile-generate','-D','DEBUG','-I',products,join(products,'AssistantCore.o')],binary=join(work,'probe'),disabled=join(work,'disabled-probe'),priorBinary=join(work,'prior-consent-fixture-probe');
 execute('swiftc',[...base,...currentInputs,join(work,'main.swift'),'-o',binary],'native-compile.log');
 execute('swiftc',[...base,'-D','LIFESTREAM_NATIVE_RECOVERY_DISABLED',...currentInputs,join(work,'main.swift'),'-o',disabled],'disabled-compile.log');
 const oldNative=join(oldCandidate,'source/apps/ios/ios/App/CapApp-SPM/Sources/CapApp-SPM');execute('swiftc',[...base,...names.map(n=>join(oldNative,n+'.swift')),oldMain,'-o',priorBinary],'prior-reviewed-fixture-compile.log');
 const compileInputs=[...currentInputs,join(work,'main.swift'),...readdirSync(join(ios,'native/Sources/AssistantCore')).filter(x=>x.endsWith('.swift')).map(n=>join(ios,'native/Sources/AssistantCore',n))];writeFileSync(join(work,'compile-inputs.json'),JSON.stringify(Object.fromEntries(compileInputs.map(p=>[p,hash(p)])),null,2)+'\n');
 const proc=spawn('ssh',['-T','-o','BatchMode=yes','lifestream',...producer.command],{stdio:['pipe','pipe','pipe']});let serial=0,buffer=[],waiters=[],errors='',opened,selected;
 proc.stderr.on('data',d=>errors+=d);createInterface({input:proc.stdout}).on('line',line=>{const value=JSON.parse(line),next=waiters.shift();if(next)next(value);else buffer.push(value)});proc.on('exit',()=>{for(const w of waiters.splice(0))w({kind:'driverExited'})});
 const ask=async frame=>{const id='existing-parent-'+(++serial);proc.stdin.write(JSON.stringify({...frame,id})+'\n');const value=buffer.length?buffer.shift():await new Promise(r=>waiters.push(r));assert.equal(value.id,id);assert.notEqual(value.kind,'driverError',value.code);return value};
 const pin={schemaId:'https://lifestream.dev/contracts/mobile-context/1.0.0',schemaVersion:'1.0.0',digest:'67ed5d813f35f5f62f209e3ce5b3d3bd050df5b3604eb72d91d9e5e368063dd2'};
 async function fixtureControl(operation,payload){const i=opened.syntheticIdentity,r=await ask({command:'request',method:'POST',path:'/api/runtime/v1/mobile-context',headers:[['origin',opened.transportOrigin],['cookie',i.cookie],['x-lifestream-csrf',i.csrf],['x-lifestream-user-context',i.contextRef]],bodyBase64:Buffer.from(JSON.stringify({producerPin:pin,operation,payload})).toString('base64')});assert.equal(r.status,200);return JSON.parse(Buffer.from(r.bodyBase64,'base64')).result}
 const frames=[],cases=[];
 async function stage(name,state,{program=binary,category='SleepSegment',preparation=false}={}){
  const dir=join(work,(preparation?'fixture-':'')+name+'-'+category);mkdirSync(dir,{recursive:true});
  const child=spawn(program,[name],{env:{...process.env,CONSENT_DRIVER_OPEN:Buffer.from(JSON.stringify(opened)).toString('base64'),HEALTH_SELECTED_SOURCE:Buffer.from(JSON.stringify(selected)).toString('base64'),HEALTH_SELECTED_CATEGORY:category,CONSENT_SYNTHETIC_STATE:state,HEALTH_EXISTING_STORAGE_FIXTURE:join(prior,'legacy-share-fixture-from-core-regression-r1.json'),LLVM_PROFILE_FILE:join(dir,'%p.profraw')},stdio:['pipe','pipe','pipe']});
  let stderr='',chain=Promise.resolve();child.stderr.on('data',d=>stderr+=d);createInterface({input:child.stdout}).on('line',line=>{chain=chain.then(async()=>{const frame=JSON.parse(line),r=await ask(frame);if(!preparation&&frame.command==='request'){const body=JSON.parse(Buffer.from(frame.bodyBase64,'base64').toString()||'{}');assert.ok(!['enroll','bindSource','configure','control','requestApproval','approve','revoke','ingestSelected'].includes(body.operation),'new setup path never mutates server source/consent');if(['policy','inventory'].includes(body.operation))frames.push({stage:name,path:frame.path,requestBodyBase64:frame.bodyBase64,status:r.status,responseBodyBase64:r.bodyBase64})}child.stdin.write(JSON.stringify({...r,id:frame.id})+'\n')}).catch(e=>{stderr+='\n'+e.stack;child.kill()})});
  const timer=setTimeout(()=>child.kill(),90000),code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);await chain;
  for(const v of [opened.syntheticIdentity.cookie,opened.syntheticIdentity.csrf,opened.syntheticIdentity.contextRef])if(v)stderr=stderr.split(v).join('[redacted synthetic credential]');writeFileSync(join(dir,'run.log'),stderr);assert.equal(code,0,stderr);assert.match(stderr,preparation?new RegExp('PASS native '+name):new RegExp('PASS native existing '+name));
  cases.push({stage:name,category,fixturePreparationOnly:preparation,programSHA256:hash(program),stateSHA256:existsSync(state)?hash(state):null});t.diagnostic((preparation?'prior reviewed fixture only: ':'new existing-source: ')+name+'/'+category+' passed');
 }
 try{
  opened=await ask({command:'open',case:'policyReadyWithoutConsent'});const categories=['SleepSegment','heartRate','restingHeartRate','respiratoryRate','hrvSDNN'];
  let e=await fixtureControl('enroll',{collector:'healthKit'});e=await fixtureControl('bindSource',{enrollmentId:e.enrollmentId,expectedRevision:e.revision,binding:{createNew:true}});selected=await fixtureControl('configure',{enrollmentId:e.enrollmentId,expectedRevision:e.revision,state:'active',configuration:{categories,uses:[],assistantIds:[],collectionPaused:false,usePaused:true}});
  await stage('denied-policy',join(work,'denied.json'));
  for(const category of categories)await stage('decisions',join(work,'fixture-consent-'+category+'.json'),{program:priorBinary,category,preparation:true});
  for(const name of ['configured-calendar','nonempty-other-domains','protected-unavailable','file-unavailable','protected-read-loss','missing-resources','invalid-category','duplicate-category','invalid-range','noncanonical-range','wrong-revision','wrong-context','wrong-endpoint','wrong-source','wrong-enrollment','file-reentry','confirm-missing','factory-reentry','write-before','write-after','manual-sync','temporary-withdraw','authority-withdraw','permission-late'])await stage(name,join(work,name+'.json'));
  const local=join(work,'saved-local.json');await stage('new-local',local);await ask({command:'reopen'});await stage('confirm-saved',local);
  const duplicate=join(work,'duplicate-local.json');copyFileSync(local,duplicate);await stage('duplicate-local',duplicate);
  const paused=join(work,'paused-local.json');await stage('pause-local',paused);await stage('confirm-paused',paused);
  const corrupt=join(work,'corrupt.json');writeFileSync(corrupt,'{"unexpected":"unreadable original"}');await stage('corrupt-file',corrupt);
  const pending=join(work,'durable-pending.json');await stage('hidden-request',pending,{program:priorBinary,preparation:true});await ask({command:'reopen'});await stage('durable-pending',pending);
  await stage('disabled',join(work,'disabled-never-opened.json'),{program:disabled});
  const checkpoint=await ask({command:'checkpoint'});assert.equal(checkpoint.listening,false);
  writeFileSync(join(work,'ACTUAL-EXISTING-HEALTH-QUALIFICATION-r1.json'),JSON.stringify({schemaVersion:1,syntheticOnly:true,status:'QualifiedActualOriginalCompositionWithFakeDevicePorts',producerManifestSHA256:hash(join(freeze,'MANIFEST-r2.json')),cases,frames,componentCases:cases.filter(c=>!c.fixturePreparationOnly).length,fixturePreparationStages:cases.filter(c=>c.fixturePreparationOnly).length,noHeadersAuthBodiesOrCredentialsRetained:true,firstServerEnrollmentOnlyTestFixtureNotNativeImplementation:true,noActualSDKOSDeviceLiveOrHumanAcceptance:true},null,2)+'\n');
 }finally{try{await ask({command:'close'})}finally{proc.stdin.end()}}
});
