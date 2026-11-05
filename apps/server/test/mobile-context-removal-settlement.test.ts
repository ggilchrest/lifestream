import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Duplex} from 'node:stream';import {IncomingMessage,ServerResponse} from 'node:http';
import {removalControlPin,removalControlResponse,removalControlSettlement} from '../../../packages/contracts/src/mobile-context-removal-settlement.ts';
import {mobileControlPin} from '../../../packages/contracts/src/mobile-context-control.ts';
import {ordinaryControlPin} from '../../../packages/contracts/src/mobile-context-control-settlement.ts';
import {mobileContextPin,mobileContextLimits} from '../../../packages/contracts/src/mobile-context.ts';
import {mobileSourceControlProductionBackendOptions} from '../src/runtime/mobile-source-production-composition.ts';
import {healthPolicyPin} from '../../../packages/contracts/src/mobile-context-policy-owner.ts';
import {healthSourceConsentPin} from '../../../packages/contracts/src/mobile-context-health-source-consent.ts';
const diagnostic=(globalThis as any)[Symbol.for('lifestream.test.removal.diagnostic-boundary')];
assert(diagnostic&&diagnostic.root==='/srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/public','Run only through actual reviewed diagnostic bootstrap before server import');
let authPhaseStep=0;
const authPhases=new Set(['source-index-before','source-index-after','fixture-begin','profile-captured','provision-construct-before','provision-construct-after','provision-journal-before','provision-journal-after','provision-shutdown-before','provision-shutdown-after','active-construct-before','active-construct-after','listen-bound','active-start-before','active-start-after','auth-setup-before','auth-setup-after','endpoint-bound','enrollment-configured','classification-before','classification-after','retention-before','retention-after','consent-collection-before','consent-collection-after','consent-transmission-before','consent-transmission-after','fixture-ready','request-before','request-after','reopen-shutdown-before','reopen-shutdown-after','reopen-copy-before','reopen-copy-after','reopen-construct-before','reopen-construct-after','reopen-start-before','reopen-start-after','close-shutdown-before','close-shutdown-after','close-owned-root-before','close-owned-root-after','catch-shutdown-before','catch-shutdown-after','catch-owned-root-before','catch-owned-root-after']);
function authPhase(phase:string){assert(authPhases.has(phase),'Closed synthetic phase label');assert(authPhaseStep<2048,'Synthetic phase-marker bound');diagnostic.boundary.setPhase('auth-fixture:'+phase);console.error('PRODUCER_AUTH_PHASE '+JSON.stringify({step:++authPhaseStep,phase,atUTC:new Date().toISOString()}));}
authPhase('source-index-before');
diagnostic.boundary.setPhase('producer-original-source-index-after-audit-binding');
const {createLifestreamServer}=await import('../src/index.ts');authPhase('source-index-after');
const {loadProfile}=await import('../src/config/loader.ts');
const {readSessionEndpoint}=await import('../src/runtime/session-context.ts');
const evidence:unknown[]=[];

export const producerDiagnosticBootstrap=String.raw`import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {after} from 'node:test';
function installProducerDiagnosticBoundary({scratch,caller}){
 const fs=createRequire(import.meta.url)('node:fs'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(scratch,'/srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/qualification-r1/producer-synthetic-runtime-r1');
 const trace={caller,phase:'builtin-boundary-installation',forbiddenAttempts:[],rejectedImports:[],projections:[],legacy:[],deadlines:{},closed:false};
 for(const key of ['LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS','LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS']){trace.deadlines[key]={previouslySet:Object.hasOwn(process.env,key),effective:'absent'};delete process.env[key];assert.equal(process.env[key],undefined);}
 const scratchStat=fs.lstatSync(scratch);assert(scratchStat.isDirectory()&&!scratchStat.isSymbolicLink()&&scratchStat.uid===process.getuid()&&(scratchStat.mode&0o777)===0o700);assert.equal(fs.realpathSync(scratch),scratch);
 const owned=fs.mkdtempSync(join(scratch,'diagnostic-port-'+caller+'-'));fs.chmodSync(owned,0o700);
 const directories={lifecycle:join(owned,'lifecycle'),transport:join(owned,'transport')};
 for(const path of Object.values(directories)){fs.mkdirSync(path,{mode:0o700});const st=fs.lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);assert.equal(fs.realpathSync(path),path);}
 trace.directories=directories;
 const fdPaths=new Map(),originals=[];
 const pathValue=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value;
 const isOwned=path=>path===scratch||path.startsWith(scratch+'/');
 function reject(operation,path){const event={operation,path,phase:trace.phase,atUTC:new Date().toISOString(),stack:new Error('before-IO').stack};trace.forbiddenAttempts.push(event);console.error('DIAGNOSTIC_GUARD_REJECTION '+JSON.stringify(event));throw Error('excluded_path_or_unowned_fd_before_IO');}
 function guard(operation,value,writing=false){
  if(typeof value==='number'){const path=fdPaths.get(value);if(writing&&value!==1&&value!==2&&(!path||!isOwned(path)))reject(operation,'fd:'+value);return;}
  const raw=pathValue(value);if(typeof raw!=='string')return;const path=resolve(raw);
  for(const denied of ['/srv/lifestream/private-diagnostics','/srv/lifestream/deployment'])if(path===denied||path.startsWith(denied+'/'))reject(operation,path);
 }
 function wrap(object,key,kind){const original=object[key];if(typeof original!=='function')return;
  originals.push([object,key,original]);object[key]=function(...args){guard(key,args[0],kind==='write');if(kind==='two')guard(key,args[1],true);const value=Reflect.apply(original,this,args);
   if(key==='openSync')fdPaths.set(value,resolve(pathValue(args[0])));if(key==='closeSync')fdPaths.delete(args[0]);return value;};
 }
 for(const key of ['readFileSync','openSync','readdirSync','lstatSync','statSync','existsSync','accessSync','realpathSync','opendirSync','closeSync','readSync','fstatSync'])wrap(fs,key,'read');
 for(const key of ['writeFileSync','appendFileSync','writeSync','fsyncSync','ftruncateSync','rmSync','unlinkSync','rmdirSync','mkdirSync','truncateSync','chmodSync'])wrap(fs,key,'write');
 for(const key of ['renameSync','copyFileSync','cpSync'])wrap(fs,key,'two');
 for(const key of ['readFile','open','readdir','lstat','stat','access','realpath','opendir'])wrap(fs.promises,key,'read');
 for(const key of ['writeFile','appendFile','rm','unlink','rmdir','mkdir','truncate','chmod'])wrap(fs.promises,key,'write');
 for(const key of ['rename','copyFile','cp'])wrap(fs.promises,key,'two');
 syncBuiltinESMExports();
 const specs=[{file:'lifecycle-observation.js',sha256:'09cbfb1e5ccd81ad54320722f72a3b4ae02755dca5ade018d537e38226e5ec96',literal:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',offset:10008,length:55,directory:directories.lifecycle},{file:'transport-observation.js',sha256:'d8e2022aecb91d2b34eea04ae3e1a9eed3489f9d824f1aa279feef365befa2d6',literal:'/srv/lifestream/deployment/diagnostics/tts-transport-20261029',offset:5594,length:61,directory:directories.transport}];
 const targets=new Map();for(const spec of specs){const path='/srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/public/packages/providers-voxcpm/dist/'+spec.file;assert.equal(fs.realpathSync(path),path);assert.equal(hash(fs.readFileSync(path)),spec.sha256);targets.set(pathToFileURL(path).href,spec);}
 const hooks=registerHooks({load(url,context,nextLoad){
  const spec=targets.get(url),observer=/\/providers-voxcpm\/dist\/(?:lifecycle|transport)-observation\.js$/.test(new URL(url).pathname);
  if(observer&&!spec){const event={url,phase:trace.phase,atUTC:new Date().toISOString()};trace.rejectedImports.push(event);throw Error('undeclared_observer_URL_before_evaluation');}
  if(/\/apps\/server\/(?:src\/index\.ts|dist\/index\.js)$/.test(new URL(url).pathname)&&url!=='file:///srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/public/apps/server/src/index.ts')throw Error('undeclared_backend_entry_before_evaluation');
  const loaded=nextLoad(url,context);if(!spec)return loaded;
  assert.equal(loaded.format,'module');assert.equal(url,pathToFileURL(fileURLToPath(url)).href);const original=Buffer.from(loaded.source);assert.equal(hash(original),spec.sha256);assert.equal(original.subarray(spec.offset,spec.offset+spec.length).toString(),spec.literal);assert.equal(original.toString().split(spec.literal).length,2);assert.equal(original[spec.offset-1],39);assert.equal(original[spec.offset+spec.length],39);
  const replacement=Buffer.from(JSON.stringify(spec.directory).slice(1,-1));assert(!replacement.includes(39));const transformed=Buffer.concat([original.subarray(0,spec.offset),replacement,original.subarray(spec.offset+spec.length)]),reversed=Buffer.concat([transformed.subarray(0,spec.offset),Buffer.from(spec.literal),transformed.subarray(spec.offset+replacement.length)]);assert.deepEqual(reversed,original);
  trace.projections.push({url,format:loaded.format,originalSHA256:hash(original),transformedSHA256:hash(transformed),byteOffsetUTF8:spec.offset,originalLiteralBytes:spec.length,replacementBytes:replacement.length,originalLiteral:spec.literal,replacementDirectory:spec.directory,reverseExact:true,effectiveSource:transformed.toString()});return {...loaded,source:transformed};
 }});
 return {fs,trace,setPhase(value){trace.phase=value;},close(){assert.equal(trace.forbiddenAttempts.length,0);assert.equal(trace.rejectedImports.length,0);hooks.deregister();fs.rmSync(owned,{recursive:true,force:true});trace.closed=true;/* Guards remain installed through process exit; observer exit callbacks stay confined. */}};
}

const [file,scratch]=process.argv.slice(1),root='/srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/public';
const allowed=['apps/server/test/mobile-context-removal-settlement.test.ts','apps/server/test/recovery-journal-source.test.ts','packages/storage-sqlite/test/mobile-context-removal-settlement.test.ts'];assert(allowed.some(name=>file===join(root,name)));
const boundary=installProducerDiagnosticBoundary({scratch,caller:'producer-test'}),fs=boundary.fs;
const auditPath=join(root,'apps/server/src/runtime/bounded-audit.mjs');assert.equal(createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex'),'ae85a725038beb675a5810cf6c8d762129c0c5e77fe2bffcdef1cd7163d426ac');
const auditBindings=[];
async function bindOriginalAudit(path,label){
 assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'),'ae85a725038beb675a5810cf6c8d762129c0c5e77fe2bffcdef1cd7163d426ac');boundary.setPhase(label+'-original-audit-prebinding');
 const module=await import(pathToFileURL(path).href),root=join(boundary.trace.directories.lifecycle,'..',label+'-audit');fs.mkdirSync(root,{mode:0o700});const synthetic=module.createAudit({root,timers:false}),binding={path,root,disabledStarts:0,synthetic};Object.assign(module.audit,synthetic,{start(){binding.disabledStarts++;}});auditBindings.push(binding);
}
await bindOriginalAudit(auditPath,'current-source');
if(file===join(root,'apps/server/test/recovery-journal-source.test.ts'))await bindOriginalAudit('/srv/lifestream/workspace/mobile-context-a-source-20261029/pwce-main8-presence-conformance-integration-r4/public/apps/server/src/runtime/bounded-audit.mjs','frozen-old-reader');
const marker=Symbol.for('lifestream.test.removal.diagnostic-boundary');assert(!globalThis[marker]);globalThis[marker]={root,boundary,sourceAuditURL:pathToFileURL(auditPath).href};
after(()=>{for(const binding of [...auditBindings].reverse())binding.synthetic.close();boundary.close();console.error('PRODUCER_DIAGNOSTIC_BOUNDARY '+JSON.stringify({file,auditBindings:auditBindings.map(({synthetic,...binding})=>binding),...boundary.trace}));delete globalThis[marker];});
boundary.setPhase('producer-reviewed-test-import');console.error('PRODUCER_BOOTSTRAP_PHASE '+JSON.stringify({phase:'before-reviewed-test-import',atUTC:new Date().toISOString()}));await import(pathToFileURL(file).href);console.error('PRODUCER_BOOTSTRAP_PHASE '+JSON.stringify({phase:'after-reviewed-test-import',atUTC:new Date().toISOString()}));
`;

// Original closed production profile, Auth, policy/consent handlers, SQL and
// journal execute only on disposable synthetic identities/approvals/records.
// Automated test approval bodies are not actual Human consent or device grants.
async function fixture(){
 authPhase('fixture-begin');
 const root=mkdtempSync(join(tmpdir(),'removal-auth-'));chmodSync(root,0o700);const config=loadProfile('test');assert.deepEqual(config.secretRefs,{});config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),transcript:any[]=[],invalidations:any[]=[];let owner:any;
 const profile={environmentId:randomUUID(),destinationId:'synthetic-removal-server',maximumRecordsPerHuman:1000,maximumControlOperationsPerHuman:64,finite:{allowedDurationDays:[2],allowedAnchors:['sourceEnd','firstAuthoritativeImport'] as const}};
 const options:any={config,mobileSchemaPlan:'mobile-source-control/1',sessionEnvironmentId:profile.environmentId,historyRetention:{mode:'disabled'},historyStateRoot:root,localAuth:{stateDirectory:join(root,'auth'),installerToken},personalPhoneAccess:{mode:'authenticatedSession',authenticatedAfterMs:0},audiencePrivacy:{},mobileContext:mobileSourceControlProductionBackendOptions({health:structuredClone(profile),calendar:structuredClone(profile)})};
 // Original schema-only constructor provisions this disposable empty journal;
 // active availability remains requireExisting with no governance injection.
 const {mobileContext,...schemaOnly}=options;authPhase('profile-captured');authPhase('provision-construct-before');const provisioning:any=createLifestreamServer(schemaOnly);authPhase('provision-construct-after');try{authPhase('provision-journal-before');assert.equal(provisioning.admin.recovery.journal.enableSources('initializeEmpty'),true);authPhase('provision-journal-after');}finally{authPhase('provision-shutdown-before');await provisioning.shutdown();authPhase('provision-shutdown-after');}
 authPhase('active-construct-before');let app:any=createLifestreamServer(options);authPhase('active-construct-after');const origin='http://127.0.0.1:52997';
 const bind=()=>{app.address=()=>({host:'127.0.0.1',port:52997});app.server.listen=()=>{queueMicrotask(()=>app.server.emit('listening'));return app.server;};};bind();authPhase('listen-bound');
 const raw=async(method:string,path:string,headers:Record<string,string>,body:Buffer)=>{
  assert(['/api/auth/v1/setup','/api/auth/v1/user-context','/api/runtime/v1/session-context','/api/runtime/v1/mobile-context','/api/runtime/v1/mobile-context-policy'].includes(path));assert(body.length<=262144);
  authPhase('request-before');const socket=new Duplex({read(){},write(_chunk,_encoding,done){done();}});Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});
  const req=new IncomingMessage(socket as any);req.method=method;req.url=path;req.httpVersion='1.1';req.httpVersionMajor=1;req.httpVersionMinor=1;req.complete=true;req.headers={host:'127.0.0.1:52997',origin,'content-type':'application/json',...headers,'content-length':String(body.length)};req.rawHeaders=Object.entries(req.headers).flatMap(([k,v])=>[k,String(v)]);
  const res=new ServerResponse(req),chunks:Buffer[]=[];res.assignSocket(socket as any);const write=res.write.bind(res),end=res.end.bind(res);res.write=((chunk:any,...args:any[])=>{chunks.push(Buffer.from(chunk));return (write as any)(chunk,...args);}) as any;res.end=((chunk?:any,...args:any[])=>{if(chunk!==undefined&&chunk!==null)chunks.push(Buffer.from(chunk));return (end as any)(chunk,...args);}) as any;
  const response=await new Promise<{status:number;headers:Record<string,unknown>;body:Buffer}>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned_handler_timeout:'+path)),5000);res.once('finish',()=>{clearTimeout(timer);resolve({status:res.statusCode,headers:res.getHeaders(),body:Buffer.concat(chunks)});});res.once('error',reject);app.server.emit('request',req,res);req.push(body);req.push(null);});socket.destroy();authPhase('request-after');
  // Raw producer protocol only; never retain setup/password/cookie/CSRF bodies.
  if(path==='/api/runtime/v1/mobile-context')transcript.push({method,path,requestBodyBase64:body.toString('base64'),status:response.status,responseBodyBase64:response.body.toString('base64')});return response;
 };
 const request=async(path:string,body?:unknown,extra:Record<string,string>={})=>{const r=await raw(body===undefined?'GET':'POST',path,{...(owner?{cookie:owner.cookie,'x-lifestream-csrf':owner.csrf,...(owner.contextRef?{'x-lifestream-user-context':owner.contextRef}:{})}:{}),...extra},body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)));return {...r,json:()=>JSON.parse(r.body.toString('utf8'))};};
 try{
  authPhase('active-start-before');await app.start();authPhase('active-start-after');assert.equal(app.server.listening,false);
  authPhase('auth-setup-before');const setup=await request('/api/auth/v1/setup',{username:'synthetic-removal-owner',password,installerToken});authPhase('auth-setup-after');assert.equal(setup.status,201,'Synthetic Auth setup status');const session=setup.json().session;owner={principalId:session.principalId,sessionId:session.sessionId,csrf:session.csrfToken,cookie:String(setup.headers['set-cookie']).split(';')[0],contextRef:''};owner.contextRef=(await request('/api/auth/v1/user-context')).json().contextRef;
  const initial=(await request('/api/runtime/v1/session-context')).json();const bound=await request('/api/runtime/v1/session-context',{expectedRevision:initial.revision,mode:'text',audienceScope:'authenticatedSession',endpointClass:'personalCompanion',bindingKey:randomUUID()});assert.equal(bound.status,200,bound.body.toString());const endpointId=bound.json().endpoint.endpointId;owner.contextRef=(await request('/api/auth/v1/user-context')).json().contextRef;
  authPhase('endpoint-bound');
  const mobile=async(operation:string,payload:any)=>{const r=await request('/api/runtime/v1/mobile-context',{producerPin:mobileContextPin,operation,payload});assert.equal(r.status,200,r.body.toString());return r.json().result;};
  let e=await mobile('enroll',{collector:'healthKit'});e=await mobile('bindSource',{enrollmentId:e.enrollmentId,expectedRevision:e.revision,binding:{createNew:true}});e=await mobile('configure',{enrollmentId:e.enrollmentId,expectedRevision:e.revision,state:'active',configuration:{categories:['SleepSegment'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true}});
  authPhase('enrollment-configured');
  // Follow existing original source-consent fixture flows; no SQL grant rows,
  // callback policy, owner replacement or production-validator exception.
  const policy=async(pin:any,operation:string,payload:any,extra:any={})=>{const response=await request('/api/runtime/v1/mobile-context-policy',{producerPin:pin,operation,payload,...extra});assert.equal(response.status,200,'Synthetic policy fixture status');return response.json().result;};
  const decide=async(payload:any)=>{const preview=await policy(healthPolicyPin,'preview',payload);assert.equal(preview.kind,'ready','Synthetic policy preview');assert.equal((await policy(healthPolicyPin,'apply',payload,{previewDigest:preview.digest})).kind,'observed');const terminal=await policy(healthPolicyPin,'reconcile',payload);assert.equal(terminal.kind,'terminal');assert.equal(terminal.binding.family,'healthPolicy');};
  authPhase('classification-before');await decide({operationId:randomUUID(),command:'approveMapping',expectedRevision:0,scope:{kind:'classification',category:'SleepSegment'},classification:'personal'});authPhase('classification-after');
  authPhase('retention-before');await decide({operationId:randomUUID(),command:'setRawRetention',expectedRevision:0,mappingRevision:1,scope:{kind:'rawRetention',principalId:owner.principalId,collector:'healthKit',sourceNamespace:e.sourceNamespace,category:'SleepSegment'},choice:{mode:'indefinite'}});authPhase('retention-after');
  for(const purpose of ['collection','transmission']){authPhase(purpose==='collection'?'consent-collection-before':'consent-transmission-before');
   const scope={kind:'sourceConsent',principalId:owner.principalId,collector:'healthKit',sourceNamespace:e.sourceNamespace,category:'SleepSegment',installationId:app.localAuth.administrators.current().installationId,environmentId:profile.environmentId,destinationId:profile.destinationId,purpose,recipient:null};
   const consentRequest={operationId:randomUUID(),expectedRevision:0,scope,command:'requestSourceConsent',validity:{kind:'untilRevoked'},reviewDeadlineAt:new Date(Date.now()+300000).toISOString()};const reserved=await policy(healthSourceConsentPin,'requestApproval',consentRequest);assert.equal(reserved.kind,'reserved','Synthetic consent reservation');
   const approval={operationId:randomUUID(),expectedRevision:0,scope,command:'approveSourceConsent',request:consentRequest,confirmationDigest:reserved.confirmationDigest,humanConfirmed:true};assert.equal((await policy(healthSourceConsentPin,'approve',approval)).kind,'observed');const terminal=await policy(healthSourceConsentPin,'reconcile',approval);assert.equal(terminal.kind,'terminal');assert.equal(terminal.binding.family,'healthSourceConsent');authPhase(purpose==='collection'?'consent-collection-after':'consent-transmission-after');
  }
  authPhase('fixture-ready');const original=()=>({schemaVersion:'1.0.0',operationId:randomUUID(),target:{principalId:owner.principalId,endpointId,collector:'healthKit',enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,expectedRevision:app.mobileContext.repository.enrollment(access(),e.enrollmentId).revision},action:{kind:'remove',scope:'wholeSource'}});
  const control=(operation:string,payload:any,pin:any=removalControlPin,extra:any={})=>request('/api/runtime/v1/mobile-context',{producerPin:pin,operation,payload},extra);
  const ingestMany=async(names:readonly string[])=>{
   assert(names.length>0&&new Set(names).size===names.length,'Distinct synthetic upstream identities');
   for(let offset=0;offset<names.length;offset+=mobileContextLimits.batchItems){
    // Original published maximum64. Fresh enrollment read per request; every
    // change still passes original per-item policy/currentness/durable owner.
    const current=app.mobileContext.repository.enrollment(access(),e.enrollmentId),changes=names.slice(offset,offset+mobileContextLimits.batchItems).map(name=>({schemaVersion:'1.0.0',eventId:randomUUID(),enrollmentId:e.enrollmentId,expectedPolicyRevision:current.revision,source:{collector:'healthKit',namespace:e.sourceNamespace,upstreamId:name},mappingVersion:'1.0.0',collectedAt:'2026-11-05T00:00:00.000Z',operation:'upsert',recordType:'SleepSegment',record:{schemaVersion:'1.0.0',startAt:'2026-11-04T00:00:00.000Z',endAt:'2026-11-04T08:00:00.000Z',stage:'coreLight',classification:'measured'}}));
    const payload={schemaVersion:'1.0.0',changes};assert(Buffer.byteLength(JSON.stringify(payload))<=mobileContextLimits.batchBytes,'Published ingest byte bound');
    const result=await mobile('ingest',payload);assert(Array.isArray(result));assert.equal(result.length,changes.length);
    for(let index=0;index<changes.length;index++){assert.equal(result[index].eventId,changes[index].eventId);assert.equal(result[index].outcome,'accepted');assert.equal(result[index].code,'applied');}
   }
  };
  const ingest=(name:string)=>ingestMany([name]);
  function access(){const auth=app.localAuth,context=auth.bindContext(auth.hostSessionContext(owner.sessionId),owner.contextRef),history=app.historyReadAccess(context);history.assertCurrent();assert(history.ordinarySelf());return {principalId:context.principalId,endpointId:readSessionEndpoint(app.database,owner.sessionId).endpoint!.endpointId,current:()=>{try{return history.current()&&history.ordinarySelf();}catch{return false;}}};}
  const count=()=>Number(app.database.connection.prepare('SELECT count(*) n FROM mobile_context_records').get().n),snapshot=()=>({rows:app.database.connection.prepare('SELECT * FROM mobile_context_control_operations ORDER BY operation_id').all(),journal:readFileSync(app.admin.recovery.journal.directory+'/journal.json'),changes:Number(app.database.connection.prepare('SELECT total_changes() n').get().n)});
  return {root,owner,endpointId,e,original,control,ingest,ingestMany,count,snapshot,access,transcript,invalidations,get app(){return app;},async reopen(backup:string){authPhase('reopen-shutdown-before');await app.shutdown();authPhase('reopen-shutdown-after');authPhase('reopen-copy-before');copyFileSync(backup,config.storage.databasePath);authPhase('reopen-copy-after');authPhase('reopen-construct-before');app=createLifestreamServer({...options,mobileContext:{...options.mobileContext,sourceSafetyInitialization:'requireExisting'}});authPhase('reopen-construct-after');bind();authPhase('reopen-start-before');await app.start();authPhase('reopen-start-after');assert.equal(app.server.listening,false);},async close(){authPhase('close-shutdown-before');await app.shutdown();authPhase('close-shutdown-after');evidence.push({syntheticOnly:true,transcript,invalidations,listening:false,originalAuthSQLSourceOwners:true,originalPolicyConsentOwners:true,automatedSyntheticApprovalsNotHumanConsent:true});authPhase('close-owned-root-before');rmSync(root,{recursive:true,force:true});authPhase('close-owned-root-after');}};
 }catch(error){authPhase('catch-shutdown-before');await app.shutdown();authPhase('catch-shutdown-after');authPhase('catch-owned-root-before');rmSync(root,{recursive:true,force:true});authPhase('catch-owned-root-after');throw error;}
}
async function ok(f:Awaited<ReturnType<typeof fixture>>,operation:string,r:any){const response=await f.control(operation,r);assert.equal(response.status,200,response.body.toString());const body=response.json();assert(removalControlResponse(body),response.body.toString());return body;}
test('actual non-listening Auth129record removal publishes observed first and independent exact terminal only',async()=>{
 const f=await fixture();try{
  await f.ingestMany(Array.from({length:129},(_,i)=>'selected-'+i));assert.equal(f.count(),129);const db=f.app.database,journal=f.app.admin.recovery.journal,keys=db.connection.prepare('SELECT source_key,suppression_key FROM mobile_context_records').all();let deletes=0;
  db.connection.function('all_selected_denied',()=>{const denied=new Set(journal.sourceSnapshot().intents.flatMap((v:any)=>[...v.sourceKeys]));if(!keys.every((v:any)=>denied.has(v.source_key)&&denied.has(v.suppression_key)))return 0;deletes++;return 1;});db.exec("CREATE TRIGGER all_denials_before_delete BEFORE DELETE ON mobile_context_records BEGIN SELECT CASE WHEN all_selected_denied()<>1 THEN RAISE(ABORT,'missing independent denial') END; END");
  const r=f.original(),initial=await ok(f,'control',r);assert.equal(initial.result.kind,'observed');assert.equal(removalControlSettlement(r,initial),'held');const terminal=await ok(f,'reconcile',r);assert.equal(removalControlSettlement(r,terminal),'applied');assert.equal(terminal.result.binding.family,'sourceRemovalControl');assert.equal(terminal.result.control.result.receipt.result.removedCount,129);assert.equal(deletes,129);assert.equal(f.count(),0);assert.equal(journal.sourceSnapshot().intents.length,2);
  const stable=f.snapshot();assert.equal((await ok(f,'control',r)).result.kind,'observed');assert.equal(removalControlSettlement(r,await ok(f,'reconcile',r)),'applied');assert.deepEqual(f.snapshot(),stable);
  assert.equal(terminal.result.control.result.receipt.result.enrollment.state,'active');assert.equal(terminal.result.control.result.receipt.result.enrollment.configuration.collectionPaused,false);
 }finally{await f.close();}
});
test('actual producer keeps7819 removal invalid, base originals unqualified, subject and CSRF denial before effects',async()=>{
 const f=await fixture();try{
  const r=f.original();assert.equal((await f.control('control',r,ordinaryControlPin)).status,422);assert.equal((await f.control('control',{...r,operationId:randomUUID(),target:{...r.target,principalId:randomUUID()}})).status,403);assert.equal((await f.control('control',r,removalControlPin,{'x-lifestream-csrf':'invalid'})).status,403);
  const old=await f.control('control',r,mobileControlPin);assert.equal(old.status,200,old.body.toString());assert.equal(old.json().result.status,'applied');const stable=f.snapshot();assert.equal((await ok(f,'reconcile',r)).result.kind,'held');assert.equal((await f.control('control',r)).status,503);assert.deepEqual(f.snapshot(),stable);
 }finally{await f.close();}
});
for(const failure of ['denial','receipt'] as const)test(`actual Auth ${failure} failure retains unknown and original selected effects without HTTP retry`,async()=>{
 const f=await fixture();try{
  await f.ingest('selected');const db=f.app.database,journal=f.app.admin.recovery.journal,real=journal.admitSourceBatch.bind(journal);if(failure==='denial')journal.admitSourceBatch=()=>{throw Error('explicit synthetic denial failure');};else db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON mobile_context_control_operations WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'explicit synthetic receipt failure'); END");
  const r=f.original();assert.equal((await ok(f,'control',r)).result.kind,'observed');journal.admitSourceBatch=real;assert.equal(f.count(),1);assert.equal((await ok(f,'reconcile',r)).result.kind,'held');
  if(failure==='receipt'){assert(journal.sourceSnapshot().controls[0].terminalDigest);const stable=f.snapshot();assert.equal((await f.control('control',r)).status,503);assert.deepEqual(f.snapshot(),stable);assert.equal(f.count(),1);}
  else {await f.ingest('later-unselected');const stable=f.snapshot();assert.equal((await ok(f,'control',r)).result.kind,'observed');assert.deepEqual(f.snapshot(),stable);assert.equal(f.count(),2);f.app.mobileContext.repository.completeReservedControl(f.access(),r);assert.equal(removalControlSettlement(r,await ok(f,'reconcile',r)),'applied');assert.equal(f.count(),1);assert.equal(JSON.parse(String(db.connection.prepare('SELECT source_json FROM mobile_context_records').get().source_json)).upstreamId,'later-unselected');}
 }finally{await f.close();}
});
for(const phase of ['beforeAttempt','afterFrozen','afterTerminal'] as const)test(`actual closed SQL ${phase} restore holds ahead phases and preserves later unselected data`,async()=>{
 const f=await fixture();try{
  await f.ingest('selected');const r=f.original(),db=f.app.database,repo=f.app.mobileContext.repository,journal=f.app.admin.recovery.journal,backup=join(f.root,'closed-restore.sqlite');repo.reserveControl(f.access(),r,undefined,false,true);if(phase==='beforeAttempt')await db.backup(backup);
  const real=journal.admitSourceBatch.bind(journal);journal.admitSourceBatch=()=>{throw Error('synthetic prepared interruption');};repo.completeReservedControl(f.access(),r);journal.admitSourceBatch=real;await f.ingest('later-unselected');if(phase==='afterFrozen')await db.backup(backup);repo.completeReservedControl(f.access(),r);const terminal=await ok(f,'reconcile',r);assert.equal(removalControlSettlement(r,terminal),'applied');if(phase==='afterTerminal')await db.backup(backup);
  await f.reopen(backup);const stable=f.snapshot(),response=await ok(f,'reconcile',r);assert.equal(response.result.kind,phase==='afterTerminal'?'terminal':'held');assert.equal(f.count(),phase==='afterFrozen'?2:1);assert.deepEqual(f.snapshot(),stable);assert.equal((await f.control('control',r)).status,phase==='afterTerminal'?200:503);assert.deepEqual(f.snapshot(),stable);
  if(phase==='afterTerminal'){assert.equal(response.result.control.result.receipt.receiptId,terminal.result.control.result.receipt.receiptId);const row=f.app.database.connection.prepare('SELECT outcome_json FROM mobile_context_control_operations').get();const changed=JSON.parse(String(row.outcome_json));changed.receipt.receiptId=randomUUID();f.app.database.connection.prepare('UPDATE mobile_context_control_operations SET outcome_json=?').run(JSON.stringify(changed));const before=f.snapshot();assert.equal((await ok(f,'reconcile',r)).result.kind,'held');assert.deepEqual(f.snapshot(),before);}
 }finally{await f.close();}
});
test.after(()=>{const path=process.env.REMOVAL_AUTH_EVIDENCE;if(path){assert.equal(path,'/srv/lifestream/workspace/mobile-context-a-source-20261029/mobile-retained-removal-producer-work-r1/qualification-r1/producer-synthetic-runtime-r1/ACTUAL-AUTH-REMOVAL-EVIDENCE-r4.json');writeFileSync(path,JSON.stringify({syntheticOnly:true,actualSourceAuditURL:diagnostic.sourceAuditURL,diagnosticEffectsExcluded:true,observations:evidence},null,2)+'\n',{mode:0o600});}});
