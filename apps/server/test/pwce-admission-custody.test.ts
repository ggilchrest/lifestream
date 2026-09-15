import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {SqlitePwceAdmissionCustody} from '../src/authority/pwce-admission-custody.ts';

// This layer stores opaque adapter records. Canonical and producer validation
// belong to authority-admission.test.ts and the separate-process proof checks.
const intent=(key='one',invocation='invocation.one')=>({request:{idempotencyKey:key,payload:{invocationId:invocation}},intentDigest:'a'.repeat(64),prepared:{input:{parameters:{level:0.5}}}});
const outcome={decision:{decisionId:'original'},evidenceJson:'{"original":true}'};
function memory(capacity=4096){const db=new Database({path:':memory:'});db.migrate();return {db,store:new SqlitePwceAdmissionCustody(db,capacity)};}

test('pending intent survives actual SQLite close/reopen and cannot be replaced or expired',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pwce-custody-')),path=join(dir,'state.sqlite');let db;
 try{db=new Database({path});db.migrate();let store=new SqlitePwceAdmissionCustody(db);
  const original=intent();assert.equal(store.reserve(original),true);original.prepared.input.parameters.level=1;
  db.close();db=new Database({path});db.migrate();store=new SqlitePwceAdmissionCustody(db);
  assert.equal(store.read('one').intent.prepared.input.parameters.level,0.5);assert.equal(store.read('one').outcome,null);assert.equal(store.reserve(intent()),false);
  assert.throws(()=>store.reserve({...intent(),intentDigest:'b'.repeat(64)}));
  assert.throws(()=>store.reserve(intent('other','invocation.one')));
  assert.throws(()=>store.reserve(intent('one','invocation.other')));
  assert.equal(store.read('other'),undefined);assert.equal(store.read('one').outcome,null);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('first completed result is immutable, survives restart and reads return owned copies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pwce-custody-')),path=join(dir,'state.sqlite');let db;
 try{db=new Database({path});db.migrate();let store=new SqlitePwceAdmissionCustody(db);store.reserve(intent());
  const saved=store.complete('one',outcome);saved.outcome.decision.decisionId='mutated';assert.deepEqual(store.complete('one',outcome).outcome,outcome);
  assert.throws(()=>store.complete('one',{...outcome,evidenceJson:'{}'}));assert.throws(()=>store.complete('absent',outcome));
  db.close();db=new Database({path});db.migrate();store=new SqlitePwceAdmissionCustody(db);assert.deepEqual(store.read('one').outcome,outcome);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed intent and completion transactions never claim a durable result',()=>{
 const {db,store}=memory();try{
  db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON pwce_admission_custody BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(()=>store.reserve(intent()),/synthetic disk failure/);assert.equal(store.read('one'),undefined);
  db.exec('DROP TRIGGER reject_intent');store.reserve(intent());
  db.exec("CREATE TRIGGER reject_outcome BEFORE UPDATE ON pwce_admission_custody BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(()=>store.complete('one',outcome),/synthetic disk failure/);assert.equal(store.read('one').outcome,null);
 }finally{db.close();}
});

test('capacity never evicts pending or completed original keys',()=>{
 const {db,store}=memory(1);try{store.reserve(intent());assert.throws(()=>store.reserve(intent('two','invocation.two')));store.complete('one',outcome);assert.throws(()=>store.reserve(intent('two','invocation.two')));assert.deepEqual(store.read('one').outcome,outcome);}finally{db.close();}
});

test('corrupt intent and evidence bytes fail closed before reuse',()=>{
 for(const field of ['intent_json','intent_sha256','outcome_json','outcome_sha256']){
  const {db,store}=memory();try{store.reserve(intent());store.complete('one',outcome);db.connection.prepare(`UPDATE pwce_admission_custody SET ${field}=?`).run('corrupt');assert.throws(()=>store.read('one'),/pwce_admission_custody_invalid/);assert.throws(()=>store.reserve(intent()));assert.throws(()=>store.complete('one',outcome));}finally{db.close();}
 }
});
