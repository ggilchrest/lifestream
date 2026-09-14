import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {analyzeDiscoveryEvidence,type DiscoveryEvidence} from '../src/admin/discovery-analysis.ts';
import {DiscoveryAdministration} from '../src/admin/understanding.ts';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {understandingDigest} from '../../../packages/storage-sqlite/src/understanding.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
import type {InferenceProvider,InferenceRequest} from '../../../packages/runtime/src/inference/port.ts';
const scope=()=>({assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()});
const evidence:DiscoveryEvidence[]=[{ref:'record:stated-interest',revision:2,content:'I enjoy the exploratory parts of the synthetic story.',basis:'userDeclaration',sourceFamily:'explicit-user',coverage:'unknown'},{ref:'record:partial-library',revision:1,content:'An incomplete selected library includes the synthetic story.',basis:'observedActivity',sourceFamily:'partial-import',coverage:'partial'}];
const draft=()=>({explanations:[{summary:'Exploration may contribute to the stated enjoyment.',traitRefs:['trait:exploration'],supportEvidenceRefs:['record:stated-interest'],counterEvidenceRefs:[],boundary:'Tentative explanation of this statement only.'},{summary:'The overall story may matter for reasons not captured by the selected evidence.',traitRefs:[],supportEvidenceRefs:['record:stated-interest'],counterEvidenceRefs:['record:partial-library'],boundary:'Library activity cannot identify the reason for enjoyment.'}],unknownAlternative:'The reason may be unrelated to either proposed explanation.',uncertainty:'Selected evidence is incomplete; absence of other topics does not establish dislike.'});
const options=(provider:InferenceProvider)=>({scope:scope(),topicRef:'topic:synthetic-story',workId:randomUUID(),configurationRef:'config:1',dependencyRefs:['evidence:stated-interest:2'],evidence,port:{provider,identity:'synthetic-provider:1',preemptionBoundMs:0},maximumOutputTokens:2048,maximumInputBytes:16000,deadlineAt:new Date(Date.now()+10000).toISOString(),signal:new AbortController().signal,current:()=>true});

test('bounded hypothesis analysis preserves competing tentative explanations and exact evidence',async()=>{
 let request:InferenceRequest|undefined;
 const provider:InferenceProvider={async *generate(input){request=input;yield {kind:'text',text:JSON.stringify(draft())};yield {kind:'done'};}};
 const result=await analyzeDiscoveryEvidence(options(provider));assert.equal(result.record.epistemicStatus,'tentative');assert.equal(result.record.status,'candidate');assert.equal(result.record.sourceCoverage,'partial');assert.equal((result.record.explanations as any[]).length,2);assert.equal(request?.maximumOutputTokens,2048);assert.ok(request?.scope.sessionId.startsWith('discovery-analysis:'));assert.equal(request?.sections.find(s=>s.kind==='preparedMemory')?.trusted,false);assert.equal(result.record.configurationRef,'config:1');assert.equal(evidence[0]?.revision,2);
});

test('analysis rejects invented support, collapsed alternatives, forged fields, limits and incomplete streams',async()=>{
 for(const mutation of ['invented','duplicate','authority','single','excess','incomplete','capability','late']){
  const body=draft();if(mutation==='invented')body.explanations[0]!.supportEvidenceRefs=['record:foreign'];if(mutation==='duplicate')body.explanations[1]!.summary=body.explanations[0]!.summary;if(mutation==='authority')Object.assign(body,{approved:true});if(mutation==='single')body.explanations.pop();
  const provider:InferenceProvider={async *generate(){if(mutation==='capability'){yield {kind:'capabilityRequest',capability:{name:'fetch',input:{},effect:'read-only'}};return;}yield {kind:'text',text:mutation==='excess'?'x'.repeat(2049):JSON.stringify(body)};if(mutation!=='incomplete')yield {kind:'done'};if(mutation==='late')yield {kind:'text',text:'late'};}};
  await assert.rejects(analyzeDiscoveryEvidence(options(provider)),undefined,mutation);
 }
 let calls=0;const provider:InferenceProvider={async *generate(){calls++;yield {kind:'done'};}};
 await assert.rejects(analyzeDiscoveryEvidence({...options(provider),port:{provider,identity:'unqualified',preemptionBoundMs:undefined}}),/priority/);
 await assert.rejects(analyzeDiscoveryEvidence({...options(provider),maximumInputBytes:50}),/budget/);assert.equal(calls,0);
});

test('durable analysis admission publishes only current hypotheses and never repeats a provider call',async t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const subject=scope(),boundary=understandingDigest('current');let calls=0,published=0;
 const provider:InferenceProvider={async *generate(){calls++;yield {kind:'text',text:JSON.stringify(draft())};yield {kind:'done'};}};
 const configuration={configurationId:randomUUID(),revision:1,extensions:{understanding:{...extensionSettings.understanding,enabled:true,policyRefs:['policy:synthetic']}}} as any;
 const admin=new DiscoveryAdministration(db,{snapshot:()=>({boundary,configuration}),evidenceAllowed:()=>true,sourceAllowed:()=>true,forget:()=> 'missing',analysis:()=>({provider,identity:'fixture:1',preemptionBoundMs:0}),evidence:()=>evidence,changed:()=>{published++;}});t.after(()=>admin.close());
 const input={schemaVersion:'1.0.0',operation:'prepare',purpose:'hypothesisAnalysis',idempotencyKey:'analysis-once',topicRef:'topic:synthetic-story',evidenceRefs:evidence.map(e=>e.ref),sources:[]};
 const accepted=admin.handle(subject,input,()=>true);assert.equal(accepted.status,202,JSON.stringify(accepted));const work=(accepted.body.records as any[])[0];
 for(let attempt=0;attempt<40&&admin.repository.work(subject,work.workId)?.state!=='published';attempt++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(admin.repository.work(subject,work.workId)?.state,'published',JSON.stringify(admin.records(subject)));const hypothesis=admin.records(subject).find(r=>r.recordType==='hypothesis');assert.ok(hypothesis);assert.equal(hypothesis.epistemicStatus,'tentative');assert.equal(admin.repository.select(subject,boundary,'exploration').length,0,'a hypothesis is not silently indexed as topic truth');
 assert.equal(admin.handle(subject,input,()=>true).status,200);assert.equal(calls,1);assert.equal(published,1);
});

test('revocation during model streaming cancels publication and keeps the charged job',async t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const subject=scope();let current=true,release:()=>void=()=>{},entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
 const provider:InferenceProvider={async *generate(){entered();await new Promise<void>(resolve=>{release=resolve;});yield {kind:'text',text:JSON.stringify(draft())};yield {kind:'done'};}};
 const admin=new DiscoveryAdministration(db,{snapshot:()=>({boundary:understandingDigest(current?'current':'revoked'),configuration:{configurationId:randomUUID(),revision:1,extensions:{understanding:{...extensionSettings.understanding,enabled:true,policyRefs:['policy:synthetic']}}} as any}),evidenceAllowed:()=>current,sourceAllowed:()=>true,forget:()=> 'missing',analysis:()=>({provider,identity:'fixture:1',preemptionBoundMs:0}),evidence:()=>evidence,changed:()=>{throw new Error('Must not publish');}});t.after(()=>admin.close());
 const admitted=admin.handle(subject,{schemaVersion:'1.0.0',operation:'prepare',purpose:'hypothesisAnalysis',idempotencyKey:'revoked-analysis',topicRef:'topic:synthetic-story',evidenceRefs:evidence.map(e=>e.ref),sources:[]},()=>true);assert.equal(admitted.status,202);const id=(admitted.body.records as any[])[0].workId;await started;current=false;const end=admin.foregroundStarted();release();
 for(let attempt=0;attempt<40&&admin.repository.work(subject,id)?.state==='running';attempt++)await new Promise(resolve=>setTimeout(resolve,5));end();assert.equal(admin.repository.work(subject,id)?.state,'cancelled');assert.equal(admin.records(subject).filter(r=>r.recordType==='hypothesis').length,0);
});

test('analysis refuses unqualified or mismatched evidence and revokes an in-flight qualification',async t=>{
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const subject=scope(),boundary=understandingDigest('qualification-current');let bound:number|undefined=undefined,calls=0,wrongEvidence=false,release:()=>void=()=>{},entered:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;});const provider:InferenceProvider={async *generate(){calls++;entered();await new Promise<void>(resolve=>{release=resolve;});yield {kind:'text',text:JSON.stringify(draft())};yield {kind:'done'};}};
 const configuration={configurationId:randomUUID(),revision:1,extensions:{understanding:{...extensionSettings.understanding,enabled:true,policyRefs:['policy:synthetic']}}} as any;
 const admin=new DiscoveryAdministration(db,{snapshot:()=>({boundary,configuration}),evidenceAllowed:()=>true,sourceAllowed:()=>true,forget:()=> 'missing',analysis:()=>({provider,identity:'fixture:stable-identity',preemptionBoundMs:bound}),evidence:()=>wrongEvidence?evidence.map(e=>({...e,ref:'foreign:'+e.ref})):evidence,changed:()=>{throw new Error('Revoked qualification must not publish');}});t.after(()=>admin.close());
 const input={schemaVersion:'1.0.0',operation:'prepare',purpose:'hypothesisAnalysis',idempotencyKey:'qualification-revoked',topicRef:'topic:synthetic-story',evidenceRefs:evidence.map(e=>e.ref),sources:[]};
 assert.equal(admin.handle(subject,input,()=>true).status,409);assert.equal(calls,0);assert.equal(admin.records(subject).length,0);
 bound=0;wrongEvidence=true;assert.equal(admin.handle(subject,input,()=>true).status,409);assert.equal(calls,0);wrongEvidence=false;
 const admitted=admin.handle(subject,input,()=>true);assert.equal(admitted.status,202);const id=(admitted.body.records as any[])[0].workId;await started;bound=undefined;release();
 for(let attempt=0;attempt<40&&admin.repository.work(subject,id)?.state==='running';attempt++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(admin.repository.work(subject,id)?.state,'cancelled');assert.equal(admin.records(subject).filter(r=>r.recordType==='hypothesis').length,0);assert.equal(calls,1);
});
