import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {PwceActionJournal} from '../src/authority/pwce-action-journal.ts';
// Storage tests use opaque records; the real producer suite verifies full proofs.
const intent=(key='original',id='invocation.original')=>({producerKey:key,invocationId:id,expectation:{producerKey:key},request:{payload:{invocationId:id}},confirmationDigest:'a'.repeat(64)});
const evidence=(status='pending')=>({kind:'pwce.action.approval',requestKey:'original',approvalRef:'approval.original',status,review:{original:true},snapshot:{original:true},approvedBy:status==='approved'?'human.synthetic':null,approvedAt:status==='approved'?'2026-09-16T00:00:00Z':null,humanProof:status==='approved'?{synthetic:true}:null});
const hash=text=>createHash('sha256').update(text).digest('hex');
function setup(t){const root=mkdtempSync(join(tmpdir(),'pwce-approval-custody-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const options={stateDirectory:root,deploymentId:randomUUID()},path=join(root,'pwce-action-journal/custody.sqlite');const open=(create=false,capacity=4096)=>{const value=new PwceActionJournal({...options,create,capacity});t.after(()=>value.close());return value;};return {root,options,path,open};}
test('approval intent survives restart and duplicate reservation never replaces or renews it',t=>{
 const s=setup(t),first=s.open(true);assert.equal(first.approvals.reserve(intent()),true);first.close();const next=s.open();assert.equal(next.approvals.reserve(intent()),false);assert.equal(next.approvals.read('original').latest,null);assert.throws(()=>next.approvals.reserve({...intent(),confirmationDigest:'b'.repeat(64)}));assert.throws(()=>next.approvals.reserve(intent('other')));assert.throws(()=>next.approvals.reserve(intent('original','other')));
 assert.equal(next.admissions.read('original'),undefined);assert.equal(next.invocations.read('invocation.original'),undefined);
});
test('approval proof preserves original bytes and pending history across Human approval and restart',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());const pending=JSON.stringify(evidence(),null,2),approved=JSON.stringify(evidence('approved'));a.approvals.observe('original',pending);a.approvals.observe('original',JSON.stringify(evidence()));assert.equal(a.approvals.read('original').observationCount,1);a.approvals.observe('original',approved);a.close();const b=s.open();assert.equal(b.approvals.read('original').latest.proofJson,approved);assert.equal(b.approvals.readProof('original',hash(pending)).proofJson,pending);assert.equal(b.approvals.readProof('foreign',hash(pending)),undefined);assert.throws(()=>b.approvals.observe('original',pending));assert.throws(()=>b.approvals.observe('original',JSON.stringify({...evidence('approved'),approvedBy:'foreign'})));
});
test('approval storage is bounded and never evicts uncertain original attempts',t=>{
 const s=setup(t),a=s.open(true,1);a.approvals.reserve(intent());assert.throws(()=>a.approvals.reserve(intent('other','other')));assert.throws(()=>a.approvals.observe('missing',JSON.stringify(evidence())));assert.throws(()=>a.approvals.observe('original','x'.repeat(131073)));a.approvals.observe('original',JSON.stringify(evidence('expired')));assert.throws(()=>a.approvals.observe('original',JSON.stringify(evidence('approved'))));assert.equal(a.approvals.reserve(intent()),false);
});
test('approval reads fail on corrupt bytes and observations cannot change original review',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());a.approvals.observe('original',JSON.stringify(evidence()));assert.throws(()=>a.approvals.observe('original',JSON.stringify({...evidence('approved'),review:{changed:true}})));const db=new Database({path:s.path});try{db.exec("UPDATE pwce_approval_observations SET proof_json='{}'");assert.throws(()=>a.approvals.read('original'));assert.throws(()=>a.approvals.readProof('original','x'));}finally{db.close();}
});
test('all approval operations obey the journal safety fence',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());writeFileSync(join(s.root,'pwce-journal-identity.json'),'{}');for(const run of [()=>a.approvals.read('original'),()=>a.approvals.reserve(intent()),()=>a.approvals.observe('original',JSON.stringify(evidence())),()=>a.approvals.readProof('original','x')])assert.throws(run,/pwce_action_journal_unavailable/);
});
function legacy(s,damage){
 const first=s.open(true);first.admissions.reserve({request:{idempotencyKey:'existing',payload:{invocationId:'old'}},intentDigest:'a'.repeat(64)});first.close();rmSync(join(s.root,'pwce-action-journal/approval-schema.json'));const db=new Database({path:s.path});try{db.exec('DROP TABLE pwce_approval_observations; DROP TABLE pwce_approval_custody; DELETE FROM schema_migrations WHERE id=39');damage?.(db);}finally{db.close();}
}
test('exact legacy journal upgrades additively while preserving original admission and identity',t=>{
 const s=setup(t);legacy(s);const anchor=readFileSync(join(s.root,'pwce-journal-identity.json'),'utf8');const next=s.open();assert.equal(next.admissions.read('existing').intent.request.payload.invocationId,'old');assert.equal(next.approvals.reserve(intent()),true);assert.equal(readFileSync(join(s.root,'pwce-journal-identity.json'),'utf8'),anchor);next.close();assert.equal(s.open().approvals.reserve(intent()),false);
 const db=new Database({path:s.path});try{assert.deepEqual(db.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(x=>x.id),[36,37,39]);}finally{db.close();}
});
test('damaged legacy migration history or missing custody cannot be upgraded into empty history',t=>{
 for(const damage of [db=>db.exec('DROP TABLE pwce_admission_custody'),db=>db.exec("UPDATE schema_migrations SET digest='changed' WHERE id=36"),db=>db.exec('DELETE FROM schema_migrations WHERE id=37'),db=>db.exec('CREATE TABLE pwce_approval_custody (fake TEXT)')]){const s=setup(t);legacy(s,damage);assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);const db=new Database({path:s.path});try{assert.equal(db.connection.prepare('SELECT count(*) AS n FROM schema_migrations WHERE id=39').get().n,0);}finally{db.close();}}
});
test('missing approval history in an upgraded journal is never recreated',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());a.close();const db=new Database({path:s.path});try{db.exec('DROP TABLE pwce_approval_observations');}finally{db.close();}assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);
});

test('failed approval persistence leaves no claimed attempt or false completed observation',t=>{
 const s=setup(t),a=s.open(true),db=new Database({path:s.path});try{
 db.exec("CREATE TRIGGER reject_approval BEFORE INSERT ON pwce_approval_custody BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
 assert.throws(()=>a.approvals.reserve(intent()));assert.equal(a.approvals.read('original'),undefined);db.exec('DROP TRIGGER reject_approval');assert.equal(a.approvals.reserve(intent()),true);
 db.exec("CREATE TRIGGER reject_proof BEFORE INSERT ON pwce_approval_observations BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
 assert.throws(()=>a.approvals.observe('original',JSON.stringify(evidence())));assert.equal(a.approvals.read('original').latest,null);db.exec('DROP TRIGGER reject_proof');assert.equal(a.approvals.observe('original',JSON.stringify(evidence())).observationCount,1);
 }finally{db.close();}
});

test('upgrade seal prevents removed approval migration metadata from looking like a legacy journal',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());a.close();const db=new Database({path:s.path});try{db.exec('DROP TABLE pwce_approval_observations; DROP TABLE pwce_approval_custody; DELETE FROM schema_migrations WHERE id=39');}finally{db.close();}assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);
});
test('missing upgrade seal fences an upgraded journal and every open approval operation',t=>{
 const s=setup(t),a=s.open(true);a.approvals.reserve(intent());rmSync(join(s.root,'pwce-action-journal/approval-schema.json'));assert.throws(()=>a.approvals.read('original'),/pwce_action_journal_unavailable/);a.close();assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);
});

test('interrupted additive upgrade retains its seal and cannot silently retry as legacy',t=>{
 const s=setup(t);legacy(s,db=>db.exec("CREATE TRIGGER stop_upgrade BEFORE INSERT ON schema_migrations WHEN NEW.id=39 BEGIN SELECT RAISE(ABORT, 'synthetic interrupted upgrade'); END"));assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);
 const db=new Database({path:s.path});try{assert.equal(db.connection.prepare('SELECT count(*) AS n FROM schema_migrations WHERE id=39').get().n,0);db.exec('DROP TRIGGER stop_upgrade');}finally{db.close();}assert.throws(()=>s.open(),/pwce_action_journal_unavailable/);
});
test('independent journal handles share one approval claim and immutable observed proof',t=>{
 const s=setup(t),a=s.open(true),b=s.open();assert.equal(a.approvals.reserve(intent()),true);assert.equal(b.approvals.reserve(intent()),false);const json=JSON.stringify(evidence());a.approvals.observe('original',json);assert.equal(b.approvals.observe('original',json).observationCount,1);b.approvals.observe('original',JSON.stringify(evidence('approved')));assert.equal(a.approvals.read('original').observationCount,2);
});
