import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {loadMigrations} from '../src/migrations/index.ts';

test('handoff migration conservatively fences all old sign-ins without changing their session or disclosure state',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-handoff-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'db.sqlite');let db=new Database({path,migrations:loadMigrations().filter(m=>m.id<=50)});const old=db.migrate();
 db.exec("INSERT INTO local_accounts(principal_id,username,owner,password_verifier,totp_secret,totp_last_step,epoch,disabled,created_at) VALUES('owner','synthetic',1,'not-a-real-verifier',NULL,-1,1,0,0); INSERT INTO local_sessions VALUES('synthetic-token','owner','old-session','synthetic-csrf','http://localhost',1,0,0,0); INSERT INTO sessions VALUES('old-session','conversation',7,'active',NULL,'interaction'); INSERT INTO local_sessions VALUES('unbound-token','owner','old-unbound','synthetic-csrf','http://localhost',1,0,0,0);");
 const before=db.connection.prepare('SELECT * FROM sessions').all();db.close();db=new Database({path});t.after(()=>db.close());const current=db.migrate();assert.deepEqual(current.slice(0,old.length),old);assert.deepEqual(current.slice(old.length).map(m=>m.id),[51,52,53,54,55,56,57,58,59,60]);assert.deepEqual(db.connection.prepare('SELECT * FROM sessions').all(),before);assert.deepEqual(db.connection.prepare('SELECT session_id FROM session_handoff_usage ORDER BY session_id').all().map((r:any)=>r.session_id),['old-session','old-unbound']);assert.equal(db.connection.prepare('SELECT count(*) AS n FROM session_handoff_records').get()!.n,0);
 db.exec("INSERT INTO local_sessions VALUES('fresh-token','owner','fresh-session','synthetic-csrf','http://localhost',1,0,0,0);");db.migrate();assert.equal(db.connection.prepare("SELECT 1 FROM session_handoff_usage WHERE session_id='fresh-session'").get(),undefined,'new sign-ins can be explicitly readied; rerunning migration does not mark them used');
});
