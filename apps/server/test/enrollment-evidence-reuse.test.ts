import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync,statSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {LocalAuthentication,INACTIVE_PERSONAL_DAILY_SESSION_POLICY} from '../src/auth/local-auth.ts';

const origin='http://127.0.0.1:33000';
async function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'enrollment-evidence-')),database=new Database({path:join(root,'test.sqlite')});database.migrate();
 const installerToken='synthetic-'+randomBytes(24).toString('hex'),auth=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken,personalSessionPolicy:{...INACTIVE_PERSONAL_DAILY_SESSION_POLICY,enabled:true}});
 t.after(()=>{database.close();rmSync(root,{recursive:true,force:true});});
 const setup=await auth.setup('owner','synthetic-'+randomBytes(24).toString('hex'),installerToken,origin),context=auth.context(setup.session.token,origin)!;
 const path=join(root,'auth','owner-enrolled'),source=readFileSync(path,'utf8');
 let decryptions=0;const original=(auth as any).unseal.bind(auth);
 (auth as any).unseal=(...args:any[])=>{decryptions++;return original(...args);};
 return {auth,database,path,source,context,principalId:setup.session.principalId,decryptions:()=>decryptions};
}

test('identical encrypted enrollment evidence reuses identity without retaining a credential snapshot',async t=>{
 const f=await fixture(t);
 for(let i=0;i<20;i++){assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.auth.assertCurrent(f.context),f.context);}
 assert.equal(f.decryptions(),0);
 assert.deepEqual(Object.keys((f.auth as any).enrollmentProof).sort(),['principalId','source']);
});

test('changed bytes are validated even with identical size and restored mtime; a failed check invalidates reuse',async t=>{
 const f=await fixture(t),before=statSync(f.path),saved=JSON.parse(f.source);
 saved.payload=(saved.payload[0]==='A'?'B':'A')+saved.payload.slice(1);
 const tampered=JSON.stringify(saved);assert.equal(Buffer.byteLength(tampered),Buffer.byteLength(f.source));
 writeFileSync(f.path,tampered);utimesSync(f.path,before.atime,before.mtime);
 assert.throws(()=>f.auth.enrollmentPrincipal(),error=>(error as any).code==='owner_enrollment_evidence_invalid');
 assert.equal((f.auth as any).enrollmentProof,undefined);
 const attempts=f.decryptions();writeFileSync(f.path,f.source);
 assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.decryptions(),attempts+1);
 assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.decryptions(),attempts+1);
});

test('missing evidence and current database owner withdrawal both deny a previously qualified identity',async t=>{
 const f=await fixture(t);unlinkSync(f.path);
 assert.throws(()=>f.auth.enrollmentPrincipal(),error=>(error as any).code==='owner_enrollment_evidence_missing');
 assert.equal((f.auth as any).enrollmentProof,undefined);writeFileSync(f.path,f.source);
 assert.equal(f.auth.enrollmentPrincipal(),f.principalId);
 f.database.connection.prepare('UPDATE local_accounts SET owner=0 WHERE principal_id=?').run(f.principalId);
 assert.throws(()=>f.auth.enrollmentPrincipal(),error=>(error as any).code==='owner_enrollment_evidence_invalid');
 assert.equal((f.auth as any).enrollmentProof,undefined);
 f.database.connection.prepare('UPDATE local_accounts SET owner=1 WHERE principal_id=?').run(f.principalId);
 const attempts=f.decryptions();assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.decryptions(),attempts+1);
});

test('warm enrollment identity never caches account, epoch or session authentication',async t=>{
 const f=await fixture(t);assert.equal(f.auth.enrollmentPrincipal(),f.principalId);
 f.database.connection.prepare('UPDATE local_accounts SET disabled=1 WHERE principal_id=?').run(f.principalId);
 assert.throws(()=>f.auth.assertCurrent(f.context));
 f.database.connection.prepare('UPDATE local_accounts SET disabled=0,epoch=epoch+1 WHERE principal_id=?').run(f.principalId);
 assert.throws(()=>f.auth.assertCurrent(f.context));
 f.database.connection.prepare('UPDATE local_accounts SET epoch=epoch-1 WHERE principal_id=?').run(f.principalId);
 assert.equal(f.auth.assertCurrent(f.context),f.context);f.auth.logout(f.context);assert.throws(()=>f.auth.assertCurrent(f.context));
});

test('valid changed encryption is requalified and oversized legacy evidence is never memoized',async t=>{
 const f=await fixture(t),saved=JSON.parse(f.source),snapshot=(f.auth as any).unseal(saved.payload,saved.principalId);
 saved.payload=(f.auth as any).seal(snapshot,saved.principalId);writeFileSync(f.path,JSON.stringify(saved));
 const before=f.decryptions();assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.decryptions(),before+1);
 writeFileSync(f.path,' '.repeat(65536)+f.source);
 assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal((f.auth as any).enrollmentProof,undefined);
 assert.equal(f.auth.enrollmentPrincipal(),f.principalId);assert.equal(f.decryptions(),before+3);
});
