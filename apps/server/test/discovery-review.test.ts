import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,copyFile,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {UnderstandingRepository,understandingDigest,type UnderstandingRecord} from '../../../packages/storage-sqlite/src/understanding.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
import {createLifestreamServer} from '../src/index.ts';
import {RecoveryJournal} from '../src/admin/recovery-journal.ts';
import {loadProfile} from '../src/config/loader.ts';

test('authenticated hypothesis review preserves evidence and rejection survives failed storage and database restore',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-hypothesis-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomUUID(),password=randomUUID()+randomUUID(),options={config,localAuth:{stateDirectory:join(root,'safety'),installerToken}};
 let app=createLifestreamServer(options);await app.start();t.after(()=>app.shutdown());let base=`http://127.0.0.1:${app.address().port}`;const headers:Record<string,string>={'content-type':'application/json',origin:base};
 const request=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 const api=async(path:string,body?:unknown)=>{const response=await request(path,body);return {status:response.status,body:await response.json() as any};};
 const setup=await request('/api/auth/v1/setup',{installerToken,username:'owner',password});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=(await setup.json() as any).session.csrfToken;
 const assistant=(await api('/api/admin/v1/assistants',{displayName:'Synthetic Hypothesis Review'})).body;await api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const relationship=(await api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).body.relationship;
 const prefix=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}`,path=prefix+'/understanding/v1';
 const discovery=(body:Record<string,unknown>)=>api(path,{schemaVersion:'1.0.0',...body});
 const created=await api(prefix+'/candidates',{idempotencyKey:'declaration',expectedRevision:relationship.revision,content:'I enjoy exploring unusual places in this synthetic story.',source:'synthetic-declaration',sourceFamily:'user-declaration',uncertainty:'low',contextUse:'baseline'});assert.equal(created.status,201,JSON.stringify(created));
 const approve=await api(prefix+`/candidates/${created.body.candidate.candidateId}/decision`,{idempotencyKey:'approve-declaration',expectedRevision:created.body.relationshipRevision,decision:'approved'});assert.equal(approve.status,200,JSON.stringify(approve));const candidate=approve.body.candidate;
 const draft=await discovery({operation:'draft',idempotencyKey:'settings',expectedActiveConfigurationId:null,settings:{...extensionSettings.understanding,enabled:true,policyRefs:['policy:synthetic']}});assert.equal(draft.status,201,JSON.stringify(draft));const configuration=draft.body.records[0];
 assert.equal((await discovery({operation:'activate',idempotencyKey:'activate',configurationId:configuration.configurationId,expectedRevision:configuration.revision,confirmed:true})).status,200);
 const source={sourceRef:'source:synthetic',sourceFamily:'family:synthetic',sourceRevision:'revision:1',topicRef:'topic:story',policyRef:'policy:synthetic',retrievedAt:new Date().toISOString(),reliability:'unknown',reliabilityBasis:'Synthetic supplied source.',content:'The synthetic story has exploratory areas.',claims:[{claimId:randomUUID(),text:'The synthetic story has exploratory areas.',sourceRefs:['source:synthetic'],qualifier:'attributed',versionScope:'Synthetic edition',spoilerClass:'none',contradictionRefs:[]}],aliasClaims:[],knowledgeGaps:['Other reasons are unknown.']};
 const prepared=await discovery({operation:'prepare',purpose:'briefRebuild',idempotencyKey:'source',topicRef:'topic:story',evidenceRefs:[],sources:[source]});assert.equal(prepared.status,202,JSON.stringify(prepared));
 let inspection:any;for(let n=0;n<50;n++){inspection=await discovery({operation:'inspect'});if(inspection.body.records.some((r:any)=>r.state==='published'))break;await new Promise(resolve=>setTimeout(resolve,10));}
 const db=new Database({path:config.storage.databasePath});const repo=new UnderstandingRepository(db);let databaseOpen=true;t.after(()=>{if(databaseOpen)db.close();});
 const saved=db.connection.prepare('SELECT payload_json,boundary FROM understanding_work WHERE work_id=?').get(prepared.body.records[0].workId)!;
 const previous=JSON.parse(String(saved.payload_json)),scope={assistantId:relationship.assistantId,userId:relationship.userId,relationshipId:relationship.relationshipId,deploymentId:relationship.deploymentId};
 const evidenceRef=`relationship-record:${candidate.candidateId}:2`;
 // Synthetic seeded model output tests the real protected review path, not provider reasoning quality.
 const hypothesis:UnderstandingRecord={...scope,schemaVersion:'1.0.0',recordType:'hypothesis',hypothesisId:randomUUID(),revision:1,epistemicStatus:'tentative',status:'candidate',topicRefs:['topic:story'],explanations:[{explanationId:randomUUID(),summary:'Exploration may contribute to enjoyment.',traitRefs:['trait:exploration'],supportEvidenceRefs:[evidenceRef],counterEvidenceRefs:[],boundary:'The current statement only.'},{explanationId:randomUUID(),summary:'Novelty may contribute to enjoyment.',traitRefs:['trait:novelty'],supportEvidenceRefs:[evidenceRef],counterEvidenceRefs:[],boundary:'Exploration does not establish a universal preference.'}],unknownAlternative:'Other motives remain unknown.',sourceCoverage:'unknown',uncertainty:'Two plausible explanations, not established motives.',dependencyRefs:[`evidence:${evidenceRef}:2`],createdAt:new Date().toISOString(),configurationRef:previous.configurationRef};
 const work={...previous,workId:randomUUID(),idempotencyKey:'synthetic-analysis',purpose:'hypothesisAnalysis',state:'queued',revision:1,admissionReceiptRef:null,lastOutcome:'notRun',producedRefs:[],createdAt:new Date().toISOString()};repo.admit(scope,work,understandingDigest(work),understandingDigest('synthetic-review-seed'),String(saved.boundary),()=>true);repo.start(scope,work.workId);assert.equal(repo.publish(scope,work.workId,String(saved.boundary),[hypothesis],()=>true),true);
 const evidenceBefore=JSON.stringify(JSON.parse(String(db.connection.prepare('SELECT payload_json FROM assistant_relationships WHERE relationship_id=?').get(scope.relationshipId)!.payload_json)).candidates);
 const review={operation:'disposition',idempotencyKey:'review-once',recordId:hypothesis.hypothesisId,expectedRevision:1,decision:'reviewHypothesis',reason:'Useful as a tentative explanation.'};
 const reviewed=await discovery(review);assert.equal(reviewed.status,200,JSON.stringify(reviewed));assert.equal(reviewed.body.records[0].status,'reviewed');assert.equal(reviewed.body.records[0].epistemicStatus,'tentative');assert.equal(reviewed.body.records[0].revision,2);assert.equal((await discovery(review)).status,200);assert.equal((await discovery({...review,idempotencyKey:'stale-review'})).status,409);
 const denied=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({schemaVersion:'1.0.0',...review})});assert.equal(denied.status,401);
 assert.equal((await discovery({...review,decision:'rejectHypothesis',expectedRevision:2})).status,409,'review key cannot become a rejection journal intent');
 assert.equal((await discovery({operation:'inspect'})).status,200,'invalid retry must not cause pending recovery');
 const backup=join(root,'before-rejection.sqlite');await db.backup(backup);
 db.exec("CREATE TRIGGER fail_hypothesis_rejection BEFORE INSERT ON understanding_hypothesis_rejections BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
 const reject={...review,idempotencyKey:'reject-once',expectedRevision:2,decision:'rejectHypothesis',reason:'This hypothesis is not useful; retain the observations.'};
 assert.equal((await discovery(reject)).status,409);assert.equal((await discovery({operation:'inspect'})).status,503,'recorded intent denies derived use even when SQLite fails');
 db.exec('DROP TRIGGER fail_hypothesis_rejection');const rejected=await discovery(reject);assert.equal(rejected.status,200,JSON.stringify(rejected));assert.equal(rejected.body.records[0].status,'rejected');assert.equal(rejected.body.records[0].revision,3);assert.equal((await discovery(reject)).status,200);assert.equal((await discovery({...reject,reason:'changed retry'})).status,409);
 assert.equal((await discovery({...review,idempotencyKey:'revive',expectedRevision:3})).status,409,'rejection cannot be undone by accepting an old hypothesis');
 assert.equal(JSON.stringify(JSON.parse(String(db.connection.prepare('SELECT payload_json FROM assistant_relationships WHERE relationship_id=?').get(scope.relationshipId)!.payload_json)).candidates),evidenceBefore);
 await app.shutdown();db.close();databaseOpen=false;await copyFile(backup,config.storage.databasePath);app=createLifestreamServer(options);await app.start();base=`http://127.0.0.1:${app.address().port}`;headers.origin=base;delete headers.cookie;delete headers['x-lifestream-csrf'];
 const login=await request('/api/auth/v1/sign-in',{username:'owner',password,totp:''});assert.equal(login.status,200);headers.cookie=login.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=(await login.json() as any).session.csrfToken;
 const restored=await discovery({operation:'inspect'});assert.equal(restored.status,200,JSON.stringify(restored));assert.equal(restored.body.records.find((r:any)=>r.hypothesisId===hypothesis.hypothesisId).status,'rejected');assert.equal((await discovery(reject)).status,200);
 const reopened=new Database({path:config.storage.databasePath});t.after(()=>reopened.close());const repository=new UnderstandingRepository(reopened);assert.equal(repository.hypothesisRejected(scope,{...hypothesis,hypothesisId:randomUUID(),explanations:(hypothesis.explanations as any[]).map(e=>({...e,explanationId:randomUUID()}))}),true,'new generated IDs cannot restore identical rejected content');
 assert.equal(JSON.stringify(JSON.parse(String(reopened.connection.prepare('SELECT payload_json FROM assistant_relationships WHERE relationship_id=?').get(scope.relationshipId)!.payload_json)).candidates),evidenceBefore);
 assert.equal(repository.hypothesisRejected({...scope,userId:randomUUID()},hypothesis),false,'a rejection does not cross users');
 const replayWork={...work,workId:randomUUID(),idempotencyKey:'renamed-hypothesis-replay',createdAt:new Date().toISOString()};repository.admit(scope,replayWork,understandingDigest(replayWork),understandingDigest('renamed-replay'),String(saved.boundary),()=>true);repository.start(scope,replayWork.workId);
 assert.throws(()=>repository.publish(scope,replayWork.workId,String(saved.boundary),[{...hypothesis,hypothesisId:randomUUID(),explanations:(hypothesis.explanations as any[]).map(e=>({...e,explanationId:randomUUID()}))}],()=>true),/Rejected/);

 const journalPath=join(root,'safety','relationship-recovery','journal.json'),journal=JSON.parse(await readFile(journalPath,'utf8'));
 assert.equal(journal.intents[0].hypothesisRejection.hypothesisId,hypothesis.hypothesisId);assert.doesNotMatch(JSON.stringify(journal),/Exploration may contribute|retain the observations|enjoy exploring/,'journal retains IDs and digests, never evidence or reason prose');
 const currentRelationship=(await api(prefix+'/records')).body.relationship;
 const forgotten=await api(prefix+'/privacy',{idempotencyKey:'forget-evidence',expectedRevision:currentRelationship.revision,action:'delete-source',targets:[{kind:'record',id:candidate.candidateId,revision:candidate.revision}]});assert.equal(forgotten.status,200,JSON.stringify(forgotten));
 assert.equal((await discovery(reject)).status,200,'historical rejection retry never recreates erased hypothesis payload');assert.equal(reopened.connection.prepare('SELECT COUNT(*) AS n FROM understanding_artifacts').get()!.n,0);assert.equal(repository.hypothesisRejected(scope,hypothesis),true);
 journal.intents[0].hypothesisRejection.expectedRevision=-1;await writeFile(journalPath,JSON.stringify(journal));assert.equal(new RecoveryJournal(reopened,join(root,'safety','relationship-recovery')).currency,'unknown','malformed new rejection fields deny recovery currency');

});
