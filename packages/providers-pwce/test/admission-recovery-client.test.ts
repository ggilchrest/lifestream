import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {PwceGatewayClient,EXPECTED_PWCE_PROFILE,EXPECTED_PWCE_ARTIFACTS,EXPECTED_PWCE_GENERATED_CLIENT_SHA256} from '../src/client.ts';
import {EXPECTED_PWCE_ADMISSION_RECOVERY_BUNDLE as recoveryBundle} from '../src/admission-recovery-bundle.ts';
const operations=['context.getPreparedInputs','context.query','evidence.get','events.subscribe','authority.evaluate','authority.authorizeDispatch','authority.getGrants','capabilities.getSnapshot','capabilities.invoke','capabilities.getInvocation','trace.publish','health.get'];
const profile={...EXPECTED_PWCE_PROFILE,schemaStatus:'published',operationCatalog:operations.map(operation=>({operation}))};
const coreBundle={bundleId:profile.bundleId,bundleVersion:profile.bundleVersion,bundleDigest:profile.schemaDigest,artifacts:EXPECTED_PWCE_ARTIFACTS,generatedClient:{path:'src/gateway/generated-client.js',sha256:EXPECTED_PWCE_GENERATED_CLIENT_SHA256}};
const input=()=>({requestId:randomUUID(),correlationId:randomUUID(),worldRef:'world.personal.v1',executionEnvironmentRef:'test',assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic',deadline:new Date(Date.now()+30000).toISOString(),idempotencyKey:'original.producer.key',requestFingerprint:'{"original":true}',originalSnapshotRef:randomUUID(),approvalRequired:false,approvalRef:null});
function fixture(options={}){
 const calls=[],state={drift:false,mutate:()=>{},hook:async()=>{}};
 const client=new PwceGatewayClient({baseUrl:'http://fixture',token:'synthetic-recovery-token',...options,fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname;calls.push({path,init});await state.hook(path,init);
  if(path==='/gateway/v1/profile')return Response.json(profile);
  if(path==='/gateway/v1/bundle')return Response.json(coreBundle);
  if(path==='/gateway/v1/admission-recovery/bundle')return Response.json(state.drift?{...recoveryBundle,bundleDigest:'0'.repeat(64)}:recoveryBundle);
  assert.equal(path,'/gateway/v1/admission-recovery');const request=JSON.parse(init.body),response={profileId:request.profileId,profileVersion:request.profileVersion,recoveryProfileId:request.recoveryProfileId,recoveryProfileVersion:request.recoveryProfileVersion,requestId:request.requestId,correlationId:request.correlationId,worldRef:request.worldRef,executionEnvironmentRef:request.executionEnvironmentRef,status:'unknown',reason:'admission_not_found',actionRef:null,admissionEvidence:null};state.mutate(response);return Response.json(response);
 }});
 return {client,calls,state};
}

test('recovery negotiates exact contracts and sends only Agent authentication on its read-only route',async()=>{
 const f=fixture(),request=input(),context=randomUUID(),result=await f.client.recoverAdmission(context,request);assert.equal(result.status,'unknown');const sent=f.calls.find(call=>call.init.method==='POST');assert.equal(sent.path,'/gateway/v1/admission-recovery');assert.equal(sent.init.headers['X-PWCE-Admission-Recovery-Contract'],recoveryBundle.bundleDigest);assert.equal(sent.init.headers.Authorization,'Bearer synthetic-recovery-token');assert.equal(sent.init.headers['X-PWCE-Dispatcher-Token'],undefined);
 const body=JSON.parse(sent.init.body);assert.equal(body.authorityContextRef,context);assert.equal(body.operation,'authority.recoverAdmission');assert.equal(body.idempotencyKey,request.idempotencyKey);assert.ok(f.calls.every(call=>!call.path.endsWith('/dispatch')&&!call.path.endsWith('/request')));
});

test('caller fields cannot replace recovery identity or credentials and invalid input causes no I/O',async()=>{
 for(const field of ['operation','authorityContextRef','token','profileId','profileVersion','recoveryProfileId','recoveryProfileVersion']){const f=fixture();await assert.rejects(f.client.recoverAdmission(randomUUID(),{...input(),[field]:'forged'}),/cannot replace/);assert.equal(f.calls.length,0);}
 for(const change of [r=>r.idempotencyKey='',r=>r.requestFingerprint='x'.repeat(32769),r=>r.participantRefs=['same','same'],r=>r.extra=true]){const f=fixture(),request=input();change(request);await assert.rejects(f.client.recoverAdmission(randomUUID(),request));assert.equal(f.calls.length,0);}
});

test('an incompatible recovery manifest prevents the lookup itself',async()=>{
 const f=fixture();f.state.drift=true;await assert.rejects(f.client.recoverAdmission(randomUUID(),input()),/bundle is incompatible/);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
});

test('malformed and foreign recovery responses cannot cross the client boundary',async()=>{
 for(const mutate of [r=>r.extra=true,r=>r.status='known',r=>r.requestId=randomUUID(),r=>r.worldRef='world.other',r=>r.recoveryProfileVersion='2.0.0']){const f=fixture();f.state.mutate=mutate;await assert.rejects(f.client.recoverAdmission(randomUUID(),input()),/recovery response/);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);}
});

test('caller mutation during negotiation cannot change the retained lookup identity',async()=>{
 const f=fixture(),request=input(),before=structuredClone(request);let release,entered;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 f.state.hook=async path=>{if(path==='/gateway/v1/profile'){entered();await gate;}};
 const pending=f.client.recoverAdmission(randomUUID(),request);await ready;request.idempotencyKey='changed';request.participantRefs.push('foreign');release();await pending;
 const body=JSON.parse(f.calls.find(call=>call.init.method==='POST').init.body);assert.equal(body.idempotencyKey,before.idempotencyKey);assert.deepEqual(body.participantRefs,before.participantRefs);
});

test('cancellation and the single call deadline prevent late lookup after negotiation',async()=>{
 const cancelled=fixture(),controller=new AbortController();cancelled.state.hook=async path=>{if(path==='/gateway/v1/admission-recovery/bundle')controller.abort();};await assert.rejects(cancelled.client.recoverAdmission(randomUUID(),input(),controller.signal));assert.equal(cancelled.calls.filter(call=>call.init.method==='POST').length,0);
 const f=fixture({requestTimeoutMs:30});f.state.hook=async()=>new Promise(()=>{});await assert.rejects(f.client.recoverAdmission(randomUUID(),input()),{code:'deadline_exceeded'});assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
});
