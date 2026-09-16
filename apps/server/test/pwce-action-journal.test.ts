import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFileSync,existsSync,mkdtempSync,readFileSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {PwceActionJournal} from '../src/authority/pwce-action-journal.ts';
import {SqlitePwceAdmissionCustody} from '../src/authority/pwce-admission-custody.ts';

// Opaque consumer records. Adapter and joined-process suites verify full wire schemas.
const intent=(key='one',id='invocation.one')=>({request:{idempotencyKey:key,payload:{invocationId:id}},intentDigest:'a'.repeat(64),prepared:{input:{level:0.5}}});
const request=(id='invocation.one',key='one')=>({requestId:'original',deadlineAt:'2026-09-15T00:00:00Z',cancellationId:'cancel',scope:{sessionId:'session.one'},correlationId:'correlation.one',executionMode:'normal',idempotencyKey:key,payload:{invocationId:id,input:{level:0.5}}});
const outcome={decision:{decisionId:'original'},evidenceJson:'{"original":true}'};
const unavailable=/pwce_action_journal_unavailable/;
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'pwce-action-journal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const options={stateDirectory:root,deploymentId:randomUUID()},dir=join(root,'pwce-action-journal'),db=join(dir,'custody.sqlite'),anchor=join(root,'pwce-journal-identity.json'),seal=join(dir,'identity.json');
 const open=(create=false,capacity=4096)=>{const journal=new PwceActionJournal({...options,create,capacity});t.after(()=>journal.close());return journal;};
 return {root,options,dir,db,anchor,seal,open};
}

test('journal requires explicit first provisioning, private files and a stable deployment identity',t=>{
 const s=setup(t);assert.throws(()=>s.open(),unavailable);assert.equal(existsSync(s.anchor),false);
 const first=s.open(true);first.assertCurrent();
 for(const path of [s.anchor,s.seal,s.db])assert.equal(statSync(path).mode&0o777,0o600);
 assert.equal(statSync(s.dir).mode&0o777,0o700);
 assert.throws(()=>new PwceActionJournal({...s.options,deploymentId:randomUUID(),create:true}),unavailable);
 assert.equal(s.open(true).admissions.read('one'),undefined);
 const inspection=new Database({path:s.db});try{
  assert.deepEqual(inspection.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row=>row.id),[36,37,39]);
  assert.equal(inspection.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='assistant_profiles'").get().n,0);
 }finally{inspection.close();}
});

test('actual main database backup restoration cannot erase pending intent or invocation claim',async t=>{
 const s=setup(t),mainPath=join(s.root,'application.sqlite'),backup=join(s.root,'before.sqlite');
 let main=new Database({path:mainPath});main.migrate();await main.backup(backup);
 const journal=s.open(true);assert.equal(journal.admissions.reserve(intent()),true);assert.equal(journal.invocations.claim(request()),true);
 const approval={producerKey:'approval.original',invocationId:'approval.invocation',expectation:{producerKey:'approval.original'},request:{payload:{invocationId:'approval.invocation'}},confirmationDigest:'a'.repeat(64)};assert.equal(journal.approvals.reserve(approval),true);
 main.exec("CREATE TABLE synthetic_after_backup (id TEXT)");main.close();journal.close();
 copyFileSync(backup,mainPath);main=new Database({path:mainPath});main.migrate();
 try{
  assert.equal(main.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='synthetic_after_backup'").get().n,0);
  assert.equal(main.connection.prepare('SELECT count(*) AS n FROM pwce_admission_custody').get().n,0);
  const reopened=s.open();assert.equal(reopened.approvals.reserve(approval),false);assert.equal(reopened.approvals.read('approval.original').latest,null);assert.equal(main.connection.prepare('SELECT count(*) AS n FROM pwce_approval_custody').get().n,0);assert.equal(reopened.admissions.reserve(intent()),false);assert.equal(reopened.invocations.claim(request()),false);
  assert.equal(reopened.admissions.read('one').outcome,null);assert.equal(reopened.invocations.read('invocation.one').latest,null);
  reopened.admissions.complete('one',outcome);reopened.close();assert.deepEqual(s.open().admissions.read('one').outcome,outcome);
 }finally{main.close();}
});

test('independent open owners preserve unique claims, immutable outcome and capacity',t=>{
 const s=setup(t),a=s.open(true,1),b=s.open(false,1);
 assert.equal(a.admissions.reserve(intent()),true);assert.equal(b.admissions.reserve(intent()),false);
 assert.equal(b.invocations.claim(request()),true);assert.equal(a.invocations.claim(request()),false);
 assert.throws(()=>b.admissions.reserve(intent('two','two')));assert.throws(()=>a.invocations.claim(request('two','two')));
 assert.throws(()=>b.admissions.reserve({...intent(),intentDigest:'b'.repeat(64)}));assert.throws(()=>b.invocations.claim(request('other','one')));
 a.admissions.complete('one',outcome);assert.deepEqual(b.admissions.complete('one',outcome).outcome,outcome);
 assert.throws(()=>b.admissions.complete('one',{...outcome,evidenceJson:'{}'}));assert.equal(a.invocations.read('invocation.one').latest,null);
});

test('missing anchor, seal, database or journal directory never causes silent reinitialization',t=>{
 for(const artifact of ['anchor','seal','db','dir']){
  const s=setup(t),journal=s.open(true);journal.admissions.reserve(intent());journal.close();rmSync(s[artifact],{recursive:true,force:true});
  assert.throws(()=>s.open(),unavailable);assert.throws(()=>s.open(true),unavailable);
  assert.equal(existsSync(s[artifact]),false);
 }
});

test('malformed, oversized and foreign identity files fail closed',t=>{
 for(const bytes of ['{}','null','x'.repeat(1025),JSON.stringify({schemaVersion:'1.0.0',deploymentId:randomUUID(),journalId:randomUUID()})]){
  const s=setup(t);s.open(true).close();writeFileSync(s.anchor,bytes);assert.throws(()=>s.open(true),unavailable);
 }
 const s=setup(t);s.open(true).close();writeFileSync(s.seal,readFileSync(s.anchor,'utf8')+' ');assert.throws(()=>s.open(),unavailable);
});

test('partial provisioning does not create an empty replacement journal',t=>{
 const s=setup(t);writeFileSync(s.anchor,JSON.stringify({schemaVersion:'1.0.0',deploymentId:s.options.deploymentId,journalId:randomUUID()}));
 assert.throws(()=>s.open(true),unavailable);assert.equal(existsSync(s.dir),false);
 const missing=join(s.root,'missing');assert.throws(()=>new PwceActionJournal({...s.options,stateDirectory:missing,create:true}),unavailable);assert.equal(existsSync(missing),false);
});

test('symbolic links including dangling SQLite sidecars cannot replace safety files',t=>{
 for(const artifact of ['anchor','seal','db','dir']){
  const s=setup(t);s.open(true).close();const moved=s[artifact]+'.original';renameSync(s[artifact],moved);symlinkSync(moved,s[artifact]);assert.throws(()=>s.open(true),unavailable);
 }
 for(const suffix of ['-wal','-shm','-journal']){
  const s=setup(t);s.open(true).close();symlinkSync(join(s.root,'missing'),s.db+suffix);assert.throws(()=>s.open(),unavailable);assert.equal(existsSync(join(s.root,'missing')),false);
 }
});

test('open journal detects replaced database inode and remains fenced after restoration',t=>{
 const s=setup(t),journal=s.open(true);journal.admissions.reserve(intent());const moved=s.db+'.original';renameSync(s.db,moved);copyFileSync(moved,s.db);
 assert.throws(()=>journal.admissions.read('one'),unavailable);rmSync(s.db);renameSync(moved,s.db);
 assert.throws(()=>journal.admissions.reserve(intent()),unavailable);assert.throws(()=>journal.invocations.claim(request()),unavailable);
});

test('every exposed operation checks the current safety identity and closed handles stay closed',t=>{
 const s=setup(t),journal=s.open(true);journal.admissions.reserve(intent());journal.invocations.claim(request());
 const bytes=readFileSync(s.seal);rmSync(s.seal);
 for(const operation of [()=>journal.admissions.read('one'),()=>journal.admissions.reserve(intent()),()=>journal.admissions.complete('one',outcome),()=>journal.invocations.read('invocation.one'),()=>journal.invocations.claim(request()),()=>journal.invocations.observe('invocation.one',{}),()=>journal.invocations.readObservation('invocation.one',{})])assert.throws(operation,unavailable);
 writeFileSync(s.seal,bytes);assert.throws(()=>journal.assertCurrent(),unavailable);journal.close();journal.close();assert.throws(()=>journal.admissions.read('one'),unavailable);
});

test('identity loss during a mutation cannot return send permission or erase a committed claim',t=>{
 const s=setup(t),journal=s.open(true),bytes=readFileSync(s.seal),reserve=SqlitePwceAdmissionCustody.prototype.reserve;
 // Fault injection after an actual committed transaction, before the wrapper
 // returns to the admission component. Input accessors are correctly rejected.
 const fault=t.mock.method(SqlitePwceAdmissionCustody.prototype,'reserve',function(input){const result=reserve.call(this,input);rmSync(s.seal);return result;});
 assert.throws(()=>journal.admissions.reserve(intent()),unavailable);fault.mock.restore();
 writeFileSync(s.seal,bytes);journal.close();const reopened=s.open();assert.equal(reopened.admissions.reserve(intent()),false);assert.equal(reopened.admissions.read('one').outcome,null);
});

test('loss of an open WAL or shared-memory file fences existing action handles',t=>{
 for(const suffix of ['-wal','-shm']){
  const s=setup(t),journal=s.open(true);journal.admissions.reserve(intent());renameSync(s.db+suffix,s.db+suffix+'.original');
  assert.throws(()=>journal.admissions.read('one'),unavailable);assert.throws(()=>journal.invocations.claim(request()),unavailable);
  renameSync(s.db+suffix+'.original',s.db+suffix);assert.throws(()=>journal.assertCurrent(),unavailable);
 }
});

test('missing history tables and foreign SQLite files are not repaired on reopen',t=>{
 const s=setup(t);s.open(true).close();const inspection=new Database({path:s.db});inspection.exec('DROP TABLE pwce_admission_custody');inspection.close();assert.throws(()=>s.open(true),unavailable);
 const verify=new Database({path:s.db});try{assert.equal(verify.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='pwce_admission_custody'").get().n,0);}finally{verify.close();}
 const other=setup(t);other.open(true).close();copyFileSync(other.db,s.db);assert.throws(()=>s.open(),unavailable);
});

test('failed durable transaction does not grant a claim and corrupt bytes cannot be reused',t=>{
 const s=setup(t),journal=s.open(true),inspection=new Database({path:s.db});
 try{
  inspection.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON pwce_admission_custody BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(()=>journal.admissions.reserve(intent()),/synthetic disk failure/);assert.equal(journal.admissions.read('one'),undefined);
  inspection.exec('DROP TRIGGER reject_intent');assert.equal(journal.admissions.reserve(intent()),true);
  inspection.exec("UPDATE pwce_admission_custody SET intent_sha256='corrupt'");assert.throws(()=>journal.admissions.read('one'),/pwce_admission_custody_invalid/);
 }finally{inspection.close();}
});

test('a killed process retains committed WAL claims without clean shutdown',async t=>{
 const s=setup(t);s.open(true).close();
 const source=new URL('../src/authority/pwce-action-journal.ts',import.meta.url).href;
 const approval={producerKey:'crash.approval',invocationId:'crash.invocation',expectation:{producerKey:'crash.approval'},request:{payload:{invocationId:'crash.invocation'}},confirmationDigest:'a'.repeat(64)};
 const code=`import {PwceActionJournal} from ${JSON.stringify(source)};const journal=new PwceActionJournal(${JSON.stringify(s.options)});journal.admissions.reserve(${JSON.stringify(intent())});journal.invocations.claim(${JSON.stringify(request())});journal.approvals.reserve(${JSON.stringify(approval)});process.stdout.write('committed\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');t.after(()=>child.kill('SIGKILL'));let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
 let timer;try{
  const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error(errors);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('journal child timed out')),10000);})]);
  assert.equal(signal,'committed\n');child.kill('SIGKILL');await exited;
  const reopened=s.open();assert.equal(reopened.approvals.reserve(approval),false);assert.equal(reopened.approvals.read(approval.producerKey).latest,null);assert.equal(reopened.admissions.reserve(intent()),false);assert.equal(reopened.invocations.claim(request()),false);
 }finally{clearTimeout(timer);child.kill('SIGKILL');}
});
