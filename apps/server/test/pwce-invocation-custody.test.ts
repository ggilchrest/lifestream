import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {SqlitePwceInvocationCustody} from '../src/authority/pwce-invocation-custody.ts';

// Storage preserves opaque adapter records; canonical and producer schemas are
// tested at the adapter boundary and through actual separate-process requests.
const request=(id='invocation.one',key='key.one')=>({requestId:'first',deadlineAt:'2026-09-15T00:00:00Z',cancellationId:'cancel.first',scope:{sessionId:'session.one'},correlationId:'correlation.one',executionMode:'normal',idempotencyKey:key,payload:{invocationId:id,input:{level:0.5}}});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function observation(index=0,terminal=false,id='invocation.one'){
 const proofJson=canonicalJson({synthetic:true,observation:index,terminal}),sha256=hash(proofJson);
 const evidenceRef={reference:`synthetic:${id}:${sha256}`,sha256,byteLength:Buffer.byteLength(proofJson),mediaType:'application/json',schemaRef:'synthetic.schema'};
 return {proofJson,evidenceRef,terminal,status:{type:terminal?'succeeded':'outcomeUnknown',invocationId:id,...(terminal?{output:{confirmed:true},evidenceRef}:{reason:{code:'synthetic_unknown'}})}};
}
function memory(capacity=4096){const db=new Database({path:':memory:'});db.migrate();return {db,store:new SqlitePwceInvocationCustody(db,capacity)};}

test('initial claim and successive evidence survive actual SQLite reopen without another claim',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pwce-invocation-')),path=join(dir,'state.sqlite');let db;
 try{
  db=new Database({path});db.migrate();let store=new SqlitePwceInvocationCustody(db),original=request();
  assert.equal(store.claim(original),true);original.payload.input.level=1;
  db.close();db=new Database({path});db.migrate();store=new SqlitePwceInvocationCustody(db);
  assert.equal(store.read('invocation.one').request.payload.input.level,0.5);assert.equal(store.read('invocation.one').latest,null);
  assert.equal(store.claim({...request(),requestId:'retry',deadlineAt:'later',cancellationId:'other'}),false);
  const uncertain=observation(),confirmed=observation(1,true);
  store.observe('invocation.one',uncertain);store.observe('invocation.one',confirmed);
  db.close();db=new Database({path});db.migrate();store=new SqlitePwceInvocationCustody(db);
  assert.deepEqual(store.read('invocation.one').latest,confirmed);assert.equal(store.read('invocation.one').observationCount,2);
  const historical=store.readObservation('invocation.one',uncertain.evidenceRef);assert.deepEqual(historical,uncertain);
  historical.proofJson='mutated';assert.deepEqual(store.readObservation('invocation.one',uncertain.evidenceRef),uncertain);
  assert.equal(store.readObservation('invocation.other',uncertain.evidenceRef),undefined);
  assert.equal(store.readObservation('invocation.one',{...uncertain.evidenceRef,reference:'changed'}),undefined);
  assert.equal(store.claim(request()),false);assert.equal(store.read('invocation.one').request.requestId,'first');
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('independent SQLite owners cannot acquire a second initial claim or change its identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pwce-invocation-')),path=join(dir,'state.sqlite');let first,second;
 try{
  first=new Database({path});first.migrate();second=new Database({path});second.migrate();
  const a=new SqlitePwceInvocationCustody(first),b=new SqlitePwceInvocationCustody(second);
  assert.equal(a.claim(request()),true);assert.equal(b.claim(request()),false);
  for(const changed of [request('invocation.other'),request('invocation.one','key.other'),{...request(),scope:{sessionId:'other'}},{...request(),payload:{invocationId:'invocation.one',input:{level:1}}}])assert.throws(()=>b.claim(changed),/pwce_invocation_custody_invalid/);
  assert.equal(b.read('invocation.other'),undefined);assert.equal(a.read('invocation.one').latest,null);
 }finally{second?.close();first?.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed claim and observation transactions leave no invented durable result',()=>{
 const {db,store}=memory();try{
  db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON pwce_invocation_custody BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(()=>store.claim(request()),/synthetic disk failure/);assert.equal(store.read('invocation.one'),undefined);
  db.exec('DROP TRIGGER reject_claim');store.claim(request());
  db.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON pwce_invocation_observations BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(()=>store.observe('invocation.one',observation()),/synthetic disk failure/);assert.equal(store.read('invocation.one').latest,null);assert.equal(store.read('invocation.one').observationCount,0);
  assert.equal(store.claim(request()),false);db.exec('DROP TRIGGER reject_observation');assert.deepEqual(store.observe('invocation.one',observation()).latest,observation());
 }finally{db.close();}
});

test('bounded observation history reserves a final confirmation and retains earlier unknown evidence',()=>{
 const {db,store}=memory();try{
  store.claim(request());for(let index=0;index<16;index++)store.observe('invocation.one',observation(index));
  assert.equal(store.observe('invocation.one',observation(15)).observationCount,16);
  assert.throws(()=>store.observe('invocation.one',observation(16)),/pwce_invocation_custody_invalid/);
  const final=observation(16,true);assert.equal(store.observe('invocation.one',final).observationCount,17);
  assert.equal(store.observe('invocation.one',final).observationCount,17);
  assert.deepEqual(store.readObservation('invocation.one',observation().evidenceRef),observation());
  assert.throws(()=>store.observe('invocation.one',observation(17,true)),/pwce_invocation_custody_invalid/);
  assert.throws(()=>store.observe('invocation.one',observation(15)),/pwce_invocation_custody_invalid/);
  assert.deepEqual(store.read('invocation.one').latest,final);
 }finally{db.close();}
});

test('terminal results cannot regress or change while duplicate proof does not consume capacity',()=>{
 const {db,store}=memory();try{
  assert.throws(()=>store.observe('invocation.one',observation()));store.claim(request());
  assert.throws(()=>store.observe('invocation.one',observation(0,false,'foreign')));
  store.observe('invocation.one',observation());store.observe('invocation.one',observation(1));
  assert.throws(()=>store.observe('invocation.one',observation()));
  const final=observation(2,true);store.observe('invocation.one',final);assert.equal(store.observe('invocation.one',final).observationCount,3);
  assert.throws(()=>store.observe('invocation.one',observation(3)));
  assert.throws(()=>store.observe('invocation.one',{...observation(3,true),status:{...final.status,output:{confirmed:false}}}));
  assert.deepEqual(store.read('invocation.one').latest,final);
 }finally{db.close();}
});

test('capacity never evicts either pending or confirmed original dispatch claims',()=>{
 const {db,store}=memory(1);try{
  store.claim(request());assert.throws(()=>store.claim(request('two','two')));
  store.observe('invocation.one',observation(0,true));assert.throws(()=>store.claim(request('two','two')));
  assert.equal(store.claim(request()),false);assert.equal(store.read('two'),undefined);
 }finally{db.close();}
});

test('corrupt request, observation and proof bytes fail closed before reuse',()=>{
 for(const field of ['request_json','request_sha256','request_digest']){
  const {db,store}=memory();try{store.claim(request());db.connection.prepare(`UPDATE pwce_invocation_custody SET ${field}=?`).run('corrupt');assert.throws(()=>store.read('invocation.one'));assert.throws(()=>store.claim(request()));}finally{db.close();}
 }
 for(const field of ['observation_json','sha256']){
  const {db,store}=memory();try{store.claim(request());store.observe('invocation.one',observation());db.connection.prepare(`UPDATE pwce_invocation_observations SET ${field}=?`).run('corrupt');assert.throws(()=>store.read('invocation.one'));assert.throws(()=>store.readObservation('invocation.one',observation().evidenceRef));assert.throws(()=>store.observe('invocation.one',observation(1,true)));}finally{db.close();}
 }
 const {db,store}=memory();try{store.claim(request());assert.throws(()=>store.observe('invocation.one',{...observation(),proofJson:'changed'}));assert.equal(store.read('invocation.one').latest,null);}finally{db.close();}
});
