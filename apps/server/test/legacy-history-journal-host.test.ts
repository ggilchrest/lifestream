// Original public classes and normal build only. No deployed/private realm is copied.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync,readFileSync,existsSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,ConversationHistoryRepository,AssistantProfileRepository} from '@lifestream/storage-sqlite';
import {LocalAuthentication,closeCanonicalAuthSessionCustody} from '../dist/auth/local-auth.js';
import {ConversationRetentionOwner,HistoryRetentionError} from '../dist/runtime/conversation-retention-owner.js';
import {ConversationRecoveryJournal} from '../dist/admin/conversation-recovery-journal.js';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
const secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');
const hash=(body:Uint8Array|string)=>createHash('sha256').update(body).digest('hex');
const fileHash=(path:string)=>hash(readFileSync(path));
const configuration={mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'} as const;
async function originalRealm(root:string){
 const authDirectory=join(root,'safety'),database=new Database({path:join(root,'data.sqlite')});database.migrate();const installerToken=secret(),auth=new LocalAuthentication(database,{stateDirectory:authDirectory,installerToken});let policy:ConversationRetentionOwner|undefined;
 try{
  const enrolled=await auth.setup('synthetic-original-owner',secret(),installerToken,'http://127.0.0.1:43182'),context=auth.hostSessionContext(enrolled.session.sessionId),assistantId=randomUUID();
  new AssistantProfileRepository(database).create({schemaVersion:'2.0.0',assistantId,profileId:randomUUID(),revision:1,status:'draft',createdBy:context.principalId,createdAt:new Date().toISOString()});
  policy=new ConversationRetentionOwner({database,authentication:auth,authDirectory,stateRoot:root,configuration});
  const repository=new ConversationHistoryRepository(database,{retention:policy}),journal=new ConversationRecoveryJournal(repository,join(authDirectory,'conversation-recovery'));assert.equal(journal.current(),true);
  const scope={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext!.generation,authorityCurrent:()=>{try{auth.assertCurrent(context,false);return true;}catch{return false;}}};
  policy.set(context,scope,{schemaVersion:'1.0.0',operation:'set',assistantId,expectedRevision:0,enabled:true,retention:'untilDeletion',bodyScope:'textAndTranscripts'});
  const created=repository.mutate(scope,{schemaVersion:'1.0.0',operation:'create',operationId:randomUUID(),idempotencyKey:randomUUID(),payload:{assistantId,title:'Original journal synthetic chat'}}),conversationId=created.conversationId!;
  const grant=JSON.parse(readFileSync(join(authDirectory,'conversation-retention-policy/owner.json'),'utf8')).grants[0];const afterGrant=new Date(Math.max(Date.now(),Date.parse(grant.grantedAt)+1)).toISOString();
  let erasedId='';for(let i=0;i<6;i++){
   const entry=repository.observe(scope,{entryId:randomUUID(),turnId:randomUUID(),conversationId,speaker:i%2?'assistant':'human',modality:'text',state:'completed',occurredAt:afterGrant,text:'Synthetic original saved row '+i,expectedRevision:0,attribution:i%2?'observedAssistantOutput':'authenticatedTypedOwner'});assert.equal(entry.content.state,'retained');
   if(i===5){erasedId=entry.entryId;repository.erase(scope,{operationId:randomUUID(),idempotencyKey:randomUUID(),conversationId,entryId:entry.entryId,expectedRevision:entry.revision});}
  }
  const bodies=database.connection.prepare('SELECT entry_id,retained_text,content_state FROM conversation_timeline ORDER BY ordinal').all();assert.equal(bodies.filter(r=>r.content_state==='retained').length,5);assert.equal(bodies.filter(r=>r.content_state==='redacted').length,1);
  const digest=hash(JSON.stringify(bodies)),journals=['conversation-retention-policy/owner.json','conversation-retention-policy/head.json','conversation-recovery/journal.json','conversation-recovery/head.json'];const journalHashes=journals.map(n=>[n,fileHash(join(authDirectory,n))]);assert.equal(existsSync(join(authDirectory,'conversation-safety')),false);
  return {assistantId,conversationId,sessionId:context.sessionId,actorId:context.principalId,erasedId,digest,journalHashes};
 }finally{policy?.close();closeCanonicalAuthSessionCustody(auth,database);database.close();}
}

test('original conversation-recovery journal reopens unchanged with retained rows and redaction; missing or invalid journal is never reconstructed',async()=>{
 const mask=process.umask(0o077);
 try{for(const variant of ['original','missing','invalid'] as const){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'legacy-history-journal-'));chmodSync(root,0o700);let app:ReturnType<typeof createLifestreamServer>|undefined;
  try{
   const saved=await originalRealm(root),authDirectory=join(root,'safety'),journal=join(authDirectory,'conversation-recovery/journal.json');
   if(variant==='missing')unlinkSync(journal);if(variant==='invalid')writeFileSync(journal,'{}',{mode:0o600});
   const before=existsSync(journal)?fileHash(journal):null,policyBefore=fileHash(join(authDirectory,'conversation-retention-policy/owner.json'));
   const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
   const options={config,localAuth:{stateDirectory:authDirectory},historyStateRoot:root,historyRetention:{...configuration,journalInitialization:'requireExisting' as const}};
   if(variant!=='original'){
    assert.throws(()=>createLifestreamServer(options),e=>e instanceof HistoryRetentionError&&e.code==='unavailable');
    assert.equal(existsSync(journal)?fileHash(journal):null,before);assert.equal(fileHash(join(authDirectory,'conversation-retention-policy/owner.json')),policyBefore);assert.equal(existsSync(join(authDirectory,'conversation-safety')),false);continue;
   }
   for(let restart=0;restart<2;restart++){
    app=createLifestreamServer(options);await app.start();const actual=app as any,context=actual.localAuth.hostSessionContext(saved.sessionId),scope={actorId:saved.actorId,effectiveUserId:saved.actorId,contextGeneration:context.effectiveContext.generation,authorityCurrent:()=>{try{actual.localAuth.assertCurrent(context,false);return true;}catch{return false;}}};
    assert.equal(actual.conversationSafetyDirectory,join(authDirectory,'conversation-recovery'));assert.equal(actual.durableConversations.privacyCurrent(),true);assert.equal(actual.conversationRetentionOwner.inspect(scope,saved.assistantId).enabled,true);
    const page=actual.durableConversations.page(scope,saved.conversationId,'older',50);assert.equal(page.entries.length,6);assert.equal(page.entries.filter((r:any)=>r.content.state==='retained').length,5);assert.equal(page.entries.find((r:any)=>r.entryId===saved.erasedId).content.state,'redacted');
    assert.equal(hash(JSON.stringify(actual.database.connection.prepare('SELECT entry_id,retained_text,content_state FROM conversation_timeline ORDER BY ordinal').all())),saved.digest);
    for(const [name,digest] of saved.journalHashes)assert.equal(fileHash(join(authDirectory,name)),digest);
    assert.equal(existsSync(join(authDirectory,'conversation-safety')),false);await app.shutdown();app=undefined;
   }
  }finally{await app?.shutdown();rmSync(root,{recursive:true,force:true});}
 }}finally{process.umask(mask);}
});
