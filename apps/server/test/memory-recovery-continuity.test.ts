import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository,type MemoryRecord} from '@lifestream/storage-sqlite';
import {RelationshipRecovery,type RecoveryRelationship} from '../src/admin/relationship-recovery.ts';
import {recoveryDigest} from '../src/admin/recovery-journal.ts';
function active(memories:MemoryRepository,assistantId:string,actor:string,relationshipId:unknown,id=randomUUID()){
 const record:MemoryRecord={id,assistantId,content:'Synthetic retained '+id,provenance:{actor,...(relationshipId===undefined?{}:{relationshipId})},lifecycle:{status:'candidate',revision:1},createdAt:new Date().toISOString()};memories.save(record);return memories.transition(assistantId,id,'active',actor,undefined,1)!;
}
test('optional relationship inventory preserves unscoped owner records and two-argument compatibility',()=>{
 for(const durable of [false,true]){
  const db=durable?new Database({path:':memory:'}):undefined;db?.migrate();const memories=new MemoryRepository(db),assistantId=randomUUID(),owner=randomUUID(),relationshipId=randomUUID(),other=randomUUID();
  try{
   const own=active(memories,assistantId,owner,relationshipId),unscoped=active(memories,assistantId,owner,undefined),foreign=active(memories,assistantId,owner,other);active(memories,assistantId,randomUUID(),relationshipId);
   assert.deepEqual(memories.contextRecords(assistantId,owner,relationshipId).map(r=>r.id).sort(),[own.id,unscoped.id].sort());assert.deepEqual(memories.contextRecords(assistantId,owner).map(r=>r.id).sort(),[own.id,unscoped.id,foreign.id].sort());
   memories.forget(assistantId,own.id,owner);assert.deepEqual(memories.contextRecords(assistantId,owner,relationshipId).map(r=>r.id),[unscoped.id]);
  }finally{db?.close();}
 }
});
test('relationship filtering precedes the257-row archive bound',()=>{
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),assistantId=randomUUID(),owner=randomUUID(),relationshipId=randomUUID();
 try{
  for(let n=0;n<258;n++)active(memories,assistantId,owner,'foreign-relationship','a'+n.toString().padStart(4,'0'));
  const own=active(memories,assistantId,owner,relationshipId,'z-current-relationship');assert.equal(memories.contextRecords(assistantId,owner).length,257);assert.deepEqual(memories.contextRecords(assistantId,owner,relationshipId).map(r=>r.id),[own.id]);
 }finally{db.close();}
});
function correctionFixture(t:TestContext){const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),recovery=new RelationshipRecovery(db,memories),assistantId=randomUUID(),owner=randomUUID(),relationshipId=randomUUID();t.after(()=>db.close());const record=active(memories,assistantId,owner,relationshipId),replacement='Reviewed synthetic replacement stays qualified.';const proposal=memories.proposeCorrection(assistantId,record.id,replacement,owner)!;const relationship:RecoveryRelationship={assistantId,userId:owner,relationshipId,revision:1,status:'active',candidates:[]};const request={action:'revoke-processing',expectedRevision:1,idempotencyKey:'reviewed-correction',targets:[{kind:'memory',id:record.id,revision:2}]};return {db,memories,recovery,assistantId,owner,record,replacement,proposal,relationship,request};}
test('only the exact current reviewed correction escapes its own revoked-source content digest',t=>{
 const f=correctionFixture(t),ordinary=f.recovery.prepare(f.relationship,f.request),reviewed=f.recovery.prepare(f.relationship,f.request,{memoryId:f.record.id,proposalRevision:f.proposal.revision});
 assert.ok(ordinary.contentDigests.includes(recoveryDigest(f.record.content)));assert.ok(ordinary.contentDigests.includes(recoveryDigest(f.replacement)));assert.ok(reviewed.contentDigests.includes(recoveryDigest(f.record.content)));assert.ok(!reviewed.contentDigests.includes(recoveryDigest(f.replacement)));assert.notEqual(ordinary.requestDigest,reviewed.requestDigest);
 f.recovery.journal.admit(reviewed);assert.equal(f.recovery.journal.forbidden(f.owner,f.relationship.relationshipId,f.record.content),true);assert.equal(f.recovery.journal.forbidden(f.owner,f.relationship.relationshipId,f.replacement),false);
 const corrected=f.memories.applyCorrection(f.assistantId,f.record.id,f.proposal.revision,2,f.owner);assert.equal(corrected.content,f.replacement);assert.equal(corrected.provenance.correctionOf,f.record.id);
});
test('ordinary privacy revocation still blocks all proposed replacement text',t=>{
 const f=correctionFixture(t);f.recovery.journal.admit(f.recovery.prepare(f.relationship,f.request));assert.equal(f.recovery.journal.forbidden(f.owner,f.relationship.relationshipId,f.replacement),true);
});
test('stale or widened correction exemptions are rejected rather than granting unrelated replacement use',async t=>{
 for(const fault of ['proposalRevision','memoryId','action','extraTarget','changedProposal'] as const)await t.test(fault,child=>{
  const f=correctionFixture(child),proof={memoryId:f.record.id,proposalRevision:f.proposal.revision},request=structuredClone(f.request);
  if(fault==='proposalRevision')proof.proposalRevision--;
  if(fault==='memoryId')proof.memoryId=randomUUID();
  if(fault==='action')request.action='delete-source';
  if(fault==='extraTarget')request.targets.push({...request.targets[0]!});
  if(fault==='changedProposal')f.memories.proposeCorrection(f.assistantId,f.record.id,'A later unreviewed replacement',f.owner);
  assert.throws(()=>f.recovery.prepare(f.relationship,request,proof),/Current reviewed memory correction/);assert.equal(f.recovery.journal.snapshot().intents.length,0);
 });
});

test('actual authenticated correction caller preserves only the reviewed replacement while ordinary revocation stays closed',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{randomBytes}=await import('node:crypto');
 const {createLifestreamServer}=await import('../src/index.ts'),{loadProfile}=await import('../src/config/loader.ts');
 const root=await mkdtemp(join(tmpdir(),'memory-correction-continuity-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={'content-type':'application/json',origin};
 const request=async(path:string,body?:unknown)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json() as Record<string,any>};};
 const api=async(path:string,body?:unknown)=>{const value=await request(path,body);assert.ok(value.status>=200&&value.status<300,JSON.stringify(value));return value.body;};
 const setup=await fetch(origin+'/api/auth/v1/setup',{method:'POST',headers,body:JSON.stringify({username:'synthetic-owner',password:randomBytes(32).toString('hex'),installerToken}),signal:AbortSignal.timeout(5000)});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=(await setup.json() as any).session.csrfToken;
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic memory correction'}),assistantPath=`/api/admin/v1/assistants/${assistant.assistantId}`;await api(assistantPath+'/activate',{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await api(assistantPath+'/relationships',{})).relationship,relationshipPath=assistantPath+'/relationships/'+relationship.relationshipId;
 const old='The synthetic project uses Bronze.',replacement='The synthetic project uses Silver.',memory=(await api(assistantPath+'/memories',{content:old})).memory;await api(assistantPath+'/memories/'+memory.id+'/lifecycle',{status:'active',expectedRevision:1});const proposal=(await api(assistantPath+'/memories/'+memory.id+'/correction',{content:replacement})).event;
 const corrected=await api(assistantPath+'/memories/'+memory.id+'/correction',{applyRevision:proposal.revision,expectedRevision:2});assert.equal(corrected.applied,true);assert.equal(corrected.memory.content,replacement);
 const candidate=async(content:string)=>{const rel=(await api(relationshipPath)).relationship;return request(relationshipPath+'/candidates',{content,contextUse:'relevant',source:'synthetic-fixture',sourceFamily:randomUUID(),uncertainty:'high',expectedRevision:rel.revision,idempotencyKey:randomUUID()});};
 assert.equal((await candidate(replacement)).status,201,'exact reviewed replacement was not tombstoned');assert.equal((await candidate(old)).status,409,'old source remains revoked');assert.equal((await request(assistantPath+'/memories/'+memory.id+'/correction',{applyRevision:proposal.revision,expectedRevision:2})).status,409,'stale correction cannot replay');
 const ordinary=(await api(assistantPath+'/memories',{content:'Another synthetic statement.'})).memory;await api(assistantPath+'/memories/'+ordinary.id+'/lifecycle',{status:'active',expectedRevision:1});const pending='A revoked pending replacement.';await api(assistantPath+'/memories/'+ordinary.id+'/correction',{content:pending});const rel=(await api(relationshipPath)).relationship;await api(relationshipPath+'/privacy',{action:'revoke-processing',expectedRevision:rel.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:ordinary.id,revision:2}]});assert.equal((await candidate(pending)).status,409,'ordinary revocation still tombstones proposed replacement');
});
