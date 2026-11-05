// Run after the normal repository build; every imported implementation is the public package output.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';import {performance} from 'node:perf_hooks';import {test} from 'node:test';import {tmpdir} from 'node:os';
import {Database,ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {LocalAuthentication,AuthenticationError,canonicalAuthSessionCustody,canonicalAuthStateDirectory,closeCanonicalAuthSessionCustody} from '../dist/auth/local-auth.js';
import {ConversationRetentionOwner} from '../dist/runtime/conversation-retention-owner.js';
import {ConversationRecoveryJournal} from '../dist/admin/conversation-recovery-journal.js';
test('canonical self-retention uses original auth, private custody and current journals without admin freshness or backfill', {skip:typeof process.geteuid!=='function'||typeof process.getegid!=='function'}, async()=>{
const rootBase=fs.realpathSync(tmpdir()),stateRoot=fs.mkdtempSync(path.join(rootBase,'genuine-auth-db-test-')),authDirectory=path.join(stateRoot,'auth'),databasePath=path.join(stateRoot,'test.sqlite');
fs.chmodSync(stateRoot,0o700);fs.mkdirSync(authDirectory,{mode:0o700});const oldMask=process.umask(0o077),started=performance.now();
let database:Database|undefined,auth:LocalAuthentication|undefined,owner:ConversationRetentionOwner|undefined,now=Date.now(),privateAllowed=true;const outcomes:Array<{name:string;pass:boolean}>=[];
const record=(name:string)=>outcomes.push({name,pass:true});
try{
 database=new Database({path:databasePath});const migrations=database.migrate();assert.equal(migrations.length,71);assert.equal(Math.max(...migrations.map(m=>m.id)),73);
 const installerToken=randomBytes(32).toString('hex'),password='Synthetic-'+randomBytes(24).toString('hex'),origin='http://127.0.0.1';
 auth=new LocalAuthentication(database,{stateDirectory:authDirectory,installerToken,now:()=>now});
 assert.ok(canonicalAuthSessionCustody(auth,database));assert.equal(canonicalAuthStateDirectory(auth,database),authDirectory);assert.equal(canonicalAuthStateDirectory(auth,{}),null);
 const enrollment=await auth.setup('isolated-owner',password,installerToken,origin);const session=enrollment.session,context=auth.hostSessionContext(session.sessionId),actor=session.principalId;
 const assistantId=randomUUID();database.connection.prepare('INSERT INTO assistant_profiles VALUES(?,?,?,?,?,?)').run(assistantId,randomUUID(),1,'active',JSON.stringify({createdBy:actor}),new Date(now).toISOString());assert.equal(auth.canUseAssistant(context,assistantId),true);
 const configuration={mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'} as const;
 owner=new ConversationRetentionOwner({database,authentication:auth,authDirectory,stateRoot,configuration,now:()=>now});
 const scope={actorId:actor,effectiveUserId:actor,contextGeneration:context.effectiveContext.generation,authorityCurrent:()=>{try{auth.assertCurrent(context,false);return privateAllowed;}catch{return false;}}};
 assert.equal(owner.inspect(scope,assistantId).enabled,true);assert.equal(owner.inspect(scope,assistantId).revision,0);record('actual registered LocalAuthentication/Database pair and private modes; future default with no invented consent grant');
 const repository=new ConversationHistoryRepository(database,{retention:owner,now:()=>now});const recovery=new ConversationRecoveryJournal(repository,path.join(stateRoot,'conversation-safety'));assert.equal(recovery.current(),true);
 const create=repository.mutate(scope,{schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId,title:'Synthetic owned conversation'}}),conversationId=create.conversationId;
 const early={entryId:randomUUID(),turnId:randomUUID(),conversationId,speaker:'human',modality:'text',state:'completed',occurredAt:new Date(now).toISOString(),text:'synthetic before consent',expectedRevision:0,attribution:'authenticatedTypedOwner'} as const;
 const earlyEntry=repository.observe(scope,early);assert.equal(earlyEntry.content.state,'unavailable');
 now+=10;auth.csrf(context,session.csrfToken,false);const body=(revision:number,enabled:boolean)=>({schemaVersion:'1.0.0',operation:'set',assistantId,expectedRevision:revision,enabled,retention:'untilDeletion',bodyScope:'textAndTranscripts'});
 assert.equal(owner.set(context,scope,body(0,true)).enabled,true);const reference=owner.reference(scope,assistantId);assert.ok(reference);
 assert.equal(repository.observe(scope,{...early,expectedRevision:earlyEntry.revision,occurredAt:new Date(now+1).toISOString()}).content.state,'unavailable');record('explicit native authenticated self consent and actual repository no-backfill cutoff');
 now+=31*60*1000;assert.throws(()=>auth.assertCurrent(context,true),e=>e instanceof AuthenticationError&&e.code==='administration_freshness_required');assert.doesNotThrow(()=>auth.assertCurrent(context,false));assert.doesNotThrow(()=>auth.csrf(context,session.csrfToken,false));assert.throws(()=>auth.csrf(context,'not-the-token',false),e=>e.code==='csrf_rejected');
 assert.equal(owner.set(context,scope,body(1,true),()=>scope.authorityCurrent()).enabled,true);assert.equal(owner.reference(scope,assistantId),reference);record('real admin idle expiry remains denied while real ordinary auth/CSRF/current self consent succeeds');
 const beforeDenied=fs.readFileSync(path.join(authDirectory,'conversation-retention-policy','owner.json'));privateAllowed=false;assert.throws(()=>owner.set(context,scope,body(2,false),()=>false));assert.deepEqual(fs.readFileSync(path.join(authDirectory,'conversation-retention-policy','owner.json')),beforeDenied);privateAllowed=true;
 assert.throws(()=>owner.set({...context,effectiveContext:{...context.effectiveContext,effectiveUserId:randomUUID()}},scope,body(2,true),()=>true));assert.deepEqual(fs.readFileSync(path.join(authDirectory,'conversation-retention-policy','owner.json')),beforeDenied);record('withdrawn private host scope and foreign effective context leave owner journal unchanged');
 now+=10;const retained={entryId:randomUUID(),turnId:randomUUID(),conversationId,speaker:'human',modality:'text',state:'completed',occurredAt:new Date(now).toISOString(),text:'synthetic retained body',expectedRevision:0,attribution:'authenticatedTypedOwner'} as const;assert.equal(repository.observe(scope,retained).content.state,'retained');
 now+=40*86400000;assert.equal(repository.page(scope,conversationId,'older',50).entries.find(e=>e.entryId===retained.entryId).content.state,'retained');
 owner.close();owner=new ConversationRetentionOwner({database,authentication:auth,authDirectory,stateRoot,configuration:{...configuration,journalInitialization:'requireExisting'},now:()=>now});assert.equal(owner.inspect(scope,assistantId).revision,2);assert.equal(owner.inspect(scope,assistantId).enabled,true);record('untilDeletion retains actual synthetic body without age expiry and original owner/head journal reopens');
 const freshRepository=new ConversationHistoryRepository(database,{retention:owner,now:()=>now}),sameJournal=new ConversationRecoveryJournal(freshRepository,path.join(stateRoot,'conversation-safety'),true);assert.equal(sameJournal.current(),true);
 owner.set(context,scope,body(2,false),()=>scope.authorityCurrent());freshRepository.withdrawPolicy(scope,assistantId,reference);assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline WHERE content_state=\'retained\'').get().n,0);assert.ok(sameJournal.snapshot().intents.length>0);record('explicit withdrawal uses original repository erase and independent content-free denial journal');
 const grantHash=createHash('sha256').update(fs.readFileSync(path.join(authDirectory,'conversation-retention-policy','owner.json'))).digest('hex');auth.logout(context);assert.throws(()=>owner.inspect(scope,assistantId));assert.equal(createHash('sha256').update(fs.readFileSync(path.join(authDirectory,'conversation-retention-policy','owner.json'))).digest('hex'),grantHash);closeCanonicalAuthSessionCustody(auth,database);assert.equal(canonicalAuthStateDirectory(auth,database),null);record('real logout and canonical custody close deny access without rewriting consent history');
 assert.equal(outcomes.length,7);
 assert.ok(performance.now()-started<10000);
}finally{try{owner?.close();if(auth&&database)closeCanonicalAuthSessionCustody(auth,database);}finally{try{database?.close();}finally{process.umask(oldMask);fs.rmSync(stateRoot,{recursive:true,force:true});}}}

assert.equal(fs.existsSync(stateRoot),false);
});
