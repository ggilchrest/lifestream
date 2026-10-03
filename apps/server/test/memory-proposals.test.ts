import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {validateMemoryProposals,proposalDigest,proposalContent,proposalContextContent,memoryProposalInstruction,type MemoryProposal} from '../src/runtime/memory-proposals.ts';
const revision=(input:string)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
const proposal=(quote:string,epistemic:MemoryProposal['epistemic']='advice',key='strategy.bridge'):MemoryProposal=>({key,kind:'proceduralHint',quote,subject:'owner',scope:'relationship',epistemic,meaning:'Consider the guidance when a future situation fits.',attribution:'authenticated participant offers qualified guidance',uncertainty:'Applicability and truth have not been independently established.',dependencyRefs:[]});
const envelope=(quote:string,items:MemoryProposal[])=>({version:2,source:{turnRef:'source:fixture',revision:revision(quote),sessionRef:null,messageRef:null},items});
function setup(t:any,options:{beforeOutput?:()=>Promise<void>;contentAllowed?:(scope:any,content:string)=>boolean;idle?:()=>boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'meaning-memory-')),path=join(root,'db.sqlite'),owner={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()};let db:Database,memories:MemoryRepository,worker:AutomaticMemory,calls=0,items:MemoryProposal[]=[],mutate:(raw:any)=>any=raw=>raw;
 const open=()=>{db=new Database({path});db.migrate();memories=new MemoryRepository(db);worker=new AutomaticMemory({database:db,memories,provider:()=>({revision:'synthetic-proposals-v2',provider:{async *generate(request:any){calls++;const data=JSON.parse(request.sections.find((s:any)=>s.kind==='userInput').content);await options.beforeOutput?.();yield {kind:'text' as const,text:JSON.stringify(mutate({version:2,source:data.sourceIdentity,items}))};yield {kind:'done' as const};}}}),idle:options.idle??(()=>true),contentAllowed:options.contentAllowed,changed:()=>{}});};open();
 t.after(async()=>{await worker.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {owner,get db(){return db;},get memories(){return memories;},get worker(){return worker;},calls:()=>calls,set:(next:MemoryProposal[])=>items=next,mutate:(next:(raw:any)=>any)=>mutate=next,restart:async()=>{await worker.close();db.close();open();},queue:(text:string,source='source:fixture')=>worker.enqueue(owner,source,text,'authenticatedTypedOwner')};
}
test('P04 structural validation accepts pronoun-free qualified meaning without certifying truth',()=>{
 const text='Some puzzle games reward checking the bridge supports before crossing.',raw=envelope(text,[proposal(text)]);
 assert.deepEqual(validateMemoryProposals(raw,text,raw.source),raw);
 assert.match(proposalContent(raw.items[0]!),/unverified applicability/);
 assert.equal(proposalDigest(raw),proposalDigest({items:raw.items,source:{revision:raw.source.revision,turnRef:raw.source.turnRef,sessionRef:null,messageRef:null},version:2}));
 assert.ok(!memoryProposalInstruction.includes('MUST itself include'));
 // A structural checker cannot determine whether a model interpretation is entailed.
 const unproved={...raw,items:[{...raw.items[0]!,meaning:'An unproved interpretation; QA must assess semantic correctness.'}]};
 assert.equal(validateMemoryProposals(unproved,text,raw.source).items[0]!.meaning,unproved.items[0]!.meaning);
});
test('P04 metadata, schema, source, quote and unsupported descendant references fail closed',()=>{
 const text='Check the bridge supports.',raw=envelope(text,[proposal(text)]),check=(v:unknown)=>validateMemoryProposals(v,text,raw.source);
 for(const bad of [{...raw,version:1},{...raw,extra:true},{...raw,source:{...raw.source,turnRef:'foreign'}},{...raw,source:{...raw.source,revision:'changed'}},{...raw,items:[proposal('Invented quote.')]},{...raw,items:[{...proposal(text),scope:'shared'}]},{...raw,items:[{...proposal(text),subject:'assistant'}]},{...raw,items:[{...proposal(text),dependencyRefs:['foreign-memory']}]},{...raw,items:[proposal(text),proposal(text)]},{...raw,items:Array.from({length:4},(_,i)=>proposal(text,'advice','key.'+i))},{...raw,items:[{...proposal(text),confidence:1}]},{...raw,items:[{...proposal(text),meaning:'ÃƒÆ’Ã‚Â¼'.repeat(3000)}]}])assert.throws(()=>check(bad));
 assert.equal(check(envelope(text,[])).items.length,0);
});
test('P04 authenticated pronoun-free advice persists through actual SQLite close/open with source qualification',async t=>{
 const f=setup(t),text='Some puzzle games reward checking the bridge supports before crossing.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);await f.worker.tick();
 const saved=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;assert.equal(saved.content,proposalContent(proposal(text)));assert.equal(saved.provenance.sourceRevision,revision(text));assert.equal(saved.provenance.epistemicStatus,'advice');assert.equal(saved.lifecycle.factuality,'unverified');assert.equal(saved.lifecycle.confidence,0);assert.equal(saved.lifecycle.lastReinforcedAt,null);assert.equal(saved.provenance.actor,f.owner.principalId);assert.equal(saved.provenance.relationshipId,f.owner.relationshipId);assert.deepEqual(saved.provenance.dependencyRefs,[]);
 await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!.content,saved.content);assert.equal(f.calls(),1);
 f.queue(text);await f.worker.tick();assert.equal(f.calls(),1);assert.throws(()=>f.queue('Different bytes.'),/identity conflict/);
});
test('P04 first-person ordinary wording may yield zero and all nonassertive types retain their qualifications',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);f.set([]);f.queue('I am saying hello.');await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.worker.inspect(f.owner).jobs[0]!.state,'noMemory');
 for(const [epistemic,text] of [['hypothesis','I wonder whether floating towers exist.'],['question','Could a lighter pack help?'],['quotation','The fictional guide says: the north gate is safe.'],['joke','The bridge charges rent to every traveler.'],['reportedView','A fictional guide thinks the north gate is safe.']] as const){f.set([proposal(text,epistemic,'qualification.'+epistemic.toLowerCase())]);f.queue(text,'source:'+epistemic);await f.worker.tick();const r=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).find(r=>r.provenance.epistemicStatus===epistemic)!;assert.ok(r);assert.equal(r.lifecycle.factuality,'unverified');assert.equal(r.content,proposalContent(proposal(text,epistemic)));}
});
test('P04 prepared bytes are bound to retry identity across restart; changed interpretation conflicts',async t=>{
 const f=setup(t),text='Check the bridge supports.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);f.db.exec("CREATE TRIGGER reject_meaning BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");await f.worker.tick();
 const row=f.db.connection.prepare('SELECT prepared_json,proposal_digest FROM automatic_memory_work').get()!;assert.ok(row.proposal_digest);const prepared=JSON.parse(String(row.prepared_json));prepared.proposal.items[0].meaning='Changed bytes at the same retry identity.';f.db.connection.prepare('UPDATE automatic_memory_work SET prepared_json=?').run(JSON.stringify(prepared));await f.restart();f.db.exec('DROP TRIGGER reject_meaning');await f.worker.tick();assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.worker.inspect(f.owner).jobs[0]!.reason,'proposal_identity_conflict');
});
test('P04 consent revoke and reapproval do not resurrect current or restarted proposal memories',async t=>{
 const f=setup(t),text='Check the bridge supports.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);await f.worker.tick();const boundary=f.memories.contextBoundaryRows(f.owner.assistantId,f.owner.principalId);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);
 f.worker.configure(f.owner,false,1);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.notDeepEqual(f.memories.contextBoundaryRows(f.owner.assistantId,f.owner.principalId),boundary);await f.restart();f.worker.configure(f.owner,true,2);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
});
test('P04 source revoke scrubs retained advice and durable preparation and fences late/restarted writes',async t=>{
 let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);const f=setup(t,{beforeOutput:async()=>{started();await wait;}}),text='Check the bridge supports.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);const pending=f.worker.tick();await began;f.worker.revokeSource(f.owner,'source:fixture');await pending;release();await new Promise<void>(r=>setImmediate(r));await f.restart();assert.equal(f.queue(text).state,'cancelled');await f.worker.tick();assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,0);const row=f.db.connection.prepare('SELECT input_text,prepared_json,reason FROM automatic_memory_work').get()!;assert.equal(row.input_text,'');assert.equal(row.prepared_json,null);assert.equal(row.reason,'source_removed');
});
test('P04 source revoke erases qualified payload and lifecycle after consent withdrawal',async t=>{
 const f=setup(t),text='Check the bridge supports.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);await f.worker.tick();const id=f.memories.list(f.owner.assistantId)[0]!.id;f.worker.configure(f.owner,false,1);f.worker.revokeSource(f.owner,'source:fixture');assert.equal(f.memories.getForPrivacy(f.owner.assistantId,id,f.owner.principalId)!.content,'');const rows=f.db.connection.prepare('SELECT payload_json FROM memory_lifecycle_events WHERE memory_id=?').all(id);assert.ok(rows.every(row=>!String(row.payload_json).includes(text)));await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
});
test('P04 coalesces unattempted work within owner scope and does not run on the foreground path',async t=>{
 const f=setup(t,{idle:()=>false});f.worker.configure(f.owner,true,0);for(let i=0;i<20;i++)f.queue('I am saying hello '+i,'source:'+i);assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM automatic_memory_work WHERE state='queued'").get()!.n,1);assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM automatic_memory_work WHERE reason='coalesced'").get()!.n,19);await f.worker.tick();assert.equal(f.calls(),0);assert.equal(f.memories.list(f.owner.assistantId).length,0);
});
test('P04 malformed output, secret metadata and foreign or unknown admission preserve ordinary work',async t=>{
 const f=setup(t),text='Check the bridge supports.';assert.equal(f.queue(text).state,'notAdmitted');f.worker.configure(f.owner,true,0);assert.equal(f.worker.enqueue(f.owner,'unknown',text,'unknownSpeaker').state,'notAdmitted');const foreign={...f.owner,principalId:randomUUID()};assert.equal(f.worker.enqueue(foreign,'foreign',text,'authenticatedTypedOwner').state,'notAdmitted');f.set([proposal(text)]);f.mutate(raw=>({...raw,source:{...raw.source,turnRef:'forged'}}));f.queue(text);await f.worker.tick();await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.worker.inspect(f.owner).jobs[0]!.state,'failed');
 f.mutate(raw=>raw);f.set([{...proposal(text),meaning:'api key must remain secret'}]);f.queue(text,'source:secret');await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,0);const row=f.db.connection.prepare("SELECT prepared_json FROM automatic_memory_work WHERE source_turn='source:secret'").get()!;assert.equal(row.prepared_json,null);
});

test('P04 authentic session/message references bind both retry and persisted custody',async t=>{
 const f=setup(t),text='Check the bridge supports.',context={sessionRef:'synthetic-session',messageRef:'synthetic-message'};f.worker.configure(f.owner,true,0);f.set([proposal(text)]);assert.equal(f.worker.enqueue(f.owner,'source:fixture',text,'authenticatedTypedOwner',context).state,'queued');assert.throws(()=>f.worker.enqueue(f.owner,'source:fixture',text,'authenticatedTypedOwner',{...context,sessionRef:'foreign-session'}),/identity conflict/);await f.worker.tick();const record=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;assert.equal(record.provenance.sourceSessionRef,context.sessionRef);assert.equal(record.provenance.sourceMessageRef,context.messageRef);await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);
 f.db.connection.prepare('UPDATE automatic_memory_work SET source_context_json=?').run(JSON.stringify({...context,messageRef:'changed'}));assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
});

test('P04 prepared projection carries proposed attribution and uncertainty inside the existing context budget',()=>{
 const item=proposal('Check the bridge supports.'),content=proposalContextContent({content:proposalContent(item),provenance:{proposalVersion:2,attribution:item.attribution,uncertainty:item.uncertainty}});assert.ok(content.includes(item.quote));assert.ok(content.includes(item.attribution));assert.ok(content.includes(item.uncertainty));assert.match(content,/truth remain unverified/);
});
test('P04 reviewed correction preserves original source custody and forget fences its corrected representation after restart',async t=>{
 const f=setup(t),text='Check the bridge supports.';f.worker.configure(f.owner,true,0);f.set([proposal(text)]);f.queue(text);await f.worker.tick();const original=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!,event=f.memories.proposeCorrection(f.owner.assistantId,original.id,'Participant correction: check the ropes first.',f.owner.principalId)!;const corrected=f.memories.applyCorrection(f.owner.assistantId,original.id,event.revision,Number(original.lifecycle.revision),f.owner.principalId);assert.equal(corrected.provenance.sourceRevision,revision(text));assert.equal(corrected.provenance.correctionSourceRevision,original.lifecycle.revision);await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!.id,corrected.id);f.worker.revokeSource(f.owner,'source:fixture');await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.getForPrivacy(f.owner.assistantId,corrected.id,f.owner.principalId)!.content,'');
});


test('reviewed replacement excludes original interpretation from current context and retains source history',async t=>{
 const f=setup(t),old='Use metal labels for the nursery pots.',replacement='Participant correction: use wooden labels for the nursery pots.';
 f.worker.configure(f.owner,true,0);f.set([{...proposal(old),meaning:'Metal labels identify seedling pots.',attribution:'Participant recommends metal labels.',uncertainty:'Metal durability is untested.'}]);f.queue(old);await f.worker.tick();
 const original=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!,event=f.memories.proposeCorrection(f.owner.assistantId,original.id,replacement,f.owner.principalId)!;
 const corrected=f.memories.applyCorrection(f.owner.assistantId,original.id,event.revision,Number(original.lifecycle.revision),f.owner.principalId);
 // Simulate a correction persisted by the preceding candidate: stale metadata
 // stays raw audit data but must not appear in any current read projection.
 f.db.connection.prepare('UPDATE memories SET provenance_json=? WHERE id=?').run(JSON.stringify({...corrected.provenance,proposedMeaning:'Metal labels identify seedling pots.',attribution:'Participant recommends metal labels.',uncertainty:'Metal durability is untested.',epistemicStatus:'advice'}),corrected.id);await f.restart();
 const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(current.length,1);assert.equal(current[0]!.id,corrected.id);assert.ok(proposalContextContent(current[0]!).includes(replacement));assert.doesNotMatch(proposalContextContent(current[0]!),/metal/i);
 assert.equal(current[0]!.provenance.proposedMeaning,undefined);assert.equal(current[0]!.provenance.attribution,undefined);assert.equal(current[0]!.provenance.uncertainty,undefined);
 const retired=f.memories.getForPrivacy(f.owner.assistantId,original.id,f.owner.principalId)!;assert.equal(retired.lifecycle.status,'superseded');assert.equal(retired.provenance.attribution,'Participant recommends metal labels.');assert.equal(current[0]!.provenance.sourceRevision,revision(old));
 assert.equal(f.memories.search(f.owner.assistantId,'metal').some(r=>r.id===original.id),false);f.worker.revokeSource(f.owner,'source:fixture');await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
});

test('fresh source under renewed consent acquires identical content without reviving obsolete custody',async t=>{
 const f=setup(t),quote='Use a notebook to record seedling heights.';f.worker.configure(f.owner,true,0);f.set([proposal(quote,'advice','garden.measurement')]);f.queue(quote,'source:old');await f.worker.tick();const old=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 f.worker.configure(f.owner,false,1);f.worker.configure(f.owner,true,2);assert.equal(f.memories.get(f.owner.assistantId,old.id),undefined);f.queue(quote,'source:new');await f.worker.tick();await f.restart();
 const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(current.length,1);assert.notEqual(current[0]!.id,old.id);assert.equal(current[0]!.provenance.sourceTurnRef,'source:new');assert.equal(current[0]!.provenance.policyRevision,3);assert.equal(f.memories.getForPrivacy(f.owner.assistantId,old.id,f.owner.principalId)!.provenance.policyRevision,1);assert.equal(f.memories.get(f.owner.assistantId,old.id),undefined);
 assert.equal(f.db.connection.prepare("SELECT state FROM automatic_memory_work WHERE source_turn='source:new'").get()!.state,'saved');assert.equal(current[0]!.lifecycle.lastReinforcedAt,null);assert.equal(current[0]!.lifecycle.factuality,'unverified');
 f.worker.revokeSource(f.owner,'source:old');await f.restart();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!.id,current[0]!.id);
});

test('bounded direct recall covers qualified low-overlap candidates alongside literal distractors without reinforcing them',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);const guidance='Put a permeable cloth over the planter to keep insects away.',question='Which supplies could shield seedlings from hungry bugs?';
 f.set([proposal(guidance,'advice','garden.protection')]);f.queue(guidance,'source:guidance');await f.worker.tick();f.set([proposal('Typing exercise: '+question,'quotation','exercise.prompt')]);f.queue('Typing exercise: '+question,'source:exercise');await f.worker.tick();await f.restart();
 const ids=f.memories.searchCandidates(f.owner.assistantId,question).map(r=>r.provenance.sourceTurnRef);assert.ok(ids.includes('source:guidance'));assert.ok(ids.includes('source:exercise'));assert.equal(f.memories.searchCandidates(f.owner.assistantId,question,1).length,1);assert.equal(f.memories.searchCandidates(f.owner.assistantId,'  ').length,0);assert.equal(f.memories.searchCandidates('foreign-assistant',question).length,0);
 const record=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).find(r=>r.provenance.sourceTurnRef==='source:guidance')!;const before=f.memories.history(f.owner.assistantId,record.id);f.memories.searchCandidates(f.owner.assistantId,question);assert.deepEqual(f.memories.history(f.owner.assistantId,record.id),before);assert.equal(record.lifecycle.factuality,'unverified');
 f.worker.revokeSource(f.owner,'source:guidance');await f.restart();assert.ok(!f.memories.searchCandidates(f.owner.assistantId,question).some(r=>r.id===record.id));f.worker.configure(f.owner,false,1);assert.equal(f.memories.searchCandidates(f.owner.assistantId,question).length,0);
});


test('ineligible old consent does not contradict a fresh differing source or alter old history',async t=>{
 const f=setup(t),first='Use ceramic saucers under seedling pots.',fresh='Use cork mats under seedling pots.';f.worker.configure(f.owner,true,0);f.set([proposal(first,'advice','garden.base')]);f.queue(first,'source:old');await f.worker.tick();const old=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!,history=f.memories.history(f.owner.assistantId,old.id);
 f.worker.configure(f.owner,false,1);f.worker.configure(f.owner,true,2);f.set([proposal(fresh,'advice','garden.base')]);f.queue(fresh,'source:fresh');await f.worker.tick();await f.restart();const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(current.length,1);assert.ok(current[0]!.content.includes(fresh));assert.deepEqual(current[0]!.lifecycle.contradictedBy,[]);assert.deepEqual(f.memories.history(f.owner.assistantId,old.id),history);
});

test('search candidate allocation filters authenticated owner before applying the result limit',async t=>{
 const f=setup(t),quote='Use a mesh cover for the planter.';f.worker.configure(f.owner,true,0);f.set([proposal(quote)]);f.queue(quote);await f.worker.tick();const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 for(let i=0;i<5;i++)f.memories.save({id:'foreign-'+i,assistantId:f.owner.assistantId,content:'Which supplies protect sprouts?',provenance:{actor:'foreign-owner'},lifecycle:{status:'active',revision:1},createdAt:new Date().toISOString()});
 const found=f.memories.searchCandidates(f.owner.assistantId,'Which supplies protect sprouts?',1,f.owner.principalId);assert.deepEqual(found.map(r=>r.id),[current.id]);assert.equal(f.memories.searchCandidates(f.owner.assistantId,'mesh',1,'other-owner').length,0);
});


test('literal saturation leaves bounded coverage room and one source cannot consume every reserve slot',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);const quote='Use a compost thermometer. Keep a garden log. Label the seedlings.';
 f.set([proposal('Use a compost thermometer.','advice','garden.temperature'),proposal('Keep a garden log.','advice','garden.log'),proposal('Label the seedlings.','advice','garden.labels')]);f.queue(quote,'source:multi');await f.worker.tick();
 f.set([proposal('Use a mesh cover.','advice','garden.cover')]);f.queue('Use a mesh cover.','source:single');await f.worker.tick();await f.restart();
 const families=new Set(f.memories.searchCandidates(f.owner.assistantId,'Growing equipment?',2,f.owner.principalId).map(r=>r.provenance.sourceTurnRef));assert.deepEqual(families,new Set(['source:multi','source:single']));
 for(let i=0;i<40;i++)f.memories.save({id:'literal-'+i,assistantId:f.owner.assistantId,content:'Growing equipment?',provenance:{actor:f.owner.principalId},lifecycle:{status:'active',revision:1},createdAt:new Date().toISOString()});
 const found=f.memories.searchCandidates(f.owner.assistantId,'Growing equipment?',20,f.owner.principalId);assert.equal(found.length,20);assert.ok(found.some(r=>r.provenance.sourceTurnRef==='source:single'));assert.ok(found.some(r=>r.id.startsWith('literal-')));assert.ok(found.filter(r=>r.provenance.proposalVersion===2).length<=10);
});


test('retained owner administration survives withdrawal while use and learning stay fenced through reopen',async t=>{
 const f=setup(t),quote='Use a ceramic dish beneath the planter.';f.worker.configure(f.owner,true,0);f.set([proposal(quote)]);f.queue(quote);await f.worker.tick();const original=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 f.worker.configure(f.owner,false,1);await f.restart();const inventory=()=>f.memories.listForOwnerAdministration(f.owner.assistantId,f.owner.principalId,f.owner.relationshipId);assert.equal(inventory()[0]!.id,original.id);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.search(f.owner.assistantId,'ceramic').length,0);assert.equal(f.queue(quote,'source:withdrawn').state,'notAdmitted');
 assert.equal(f.memories.listForOwnerAdministration(f.owner.assistantId,'foreign-owner',f.owner.relationshipId).length,0);assert.equal(f.memories.listForOwnerAdministration(f.owner.assistantId,f.owner.principalId,'foreign-relationship').length,0);assert.equal(f.memories.listForOwnerAdministration('foreign-assistant',f.owner.principalId).length,0);
 assert.equal(f.memories.proposeCorrection(f.owner.assistantId,original.id,'Foreign replacement','foreign-owner'),undefined);
 const event=f.memories.proposeCorrection(f.owner.assistantId,original.id,'Participant correction: use a cork mat beneath the planter.',f.owner.principalId)!;const corrected=f.memories.applyCorrection(f.owner.assistantId,original.id,event.revision,Number(original.lifecycle.revision),f.owner.principalId);await f.restart();assert.ok(inventory().some(r=>r.id===corrected.id));assert.equal(f.worker.policy(f.owner).enabled,false);assert.equal(f.memories.get(f.owner.assistantId,corrected.id),undefined);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.calls(),1);
 assert.equal(f.memories.forget(f.owner.assistantId,corrected.id,f.owner.principalId)?.contentRemoved,true);assert.ok(!inventory().some(r=>r.id===corrected.id));assert.ok(f.memories.history(f.owner.assistantId,original.id).some(event=>event.eventType==='correctionApplied'));await f.restart();assert.equal(f.worker.policy(f.owner).enabled,false);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
});
