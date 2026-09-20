// Existing selected local provider, synthetic relationship, real debounce and ordinary HTTP turns.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile,redactedDigest} from '../apps/server/src/config/loader.ts';
import {SglangInferenceProvider} from '../packages/providers-sglang/dist/provider.js';
import {defaultTopics} from '../packages/contracts/dist/experience.js';
import {loadWindowsKey} from '../../orchestration/scripts/start-conversation.mjs';
const directory=process.env.LIFESTREAM_S086_EVIDENCE_DIR;
if(!directory)throw Error('Set an operator-local evidence directory outside Git roots.');
await mkdir(directory,{recursive:true,mode:0o700});
const config=loadProfile('ai5090');process.env.LIFESTREAM_INFERENCE_API_KEY=await loadWindowsKey();config.authority.authentication='local-password';config.storage={databasePath:resolve(directory,'state.sqlite'),artifactDirectory:resolve(directory,'artifacts')};
const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),options={config,host:'127.0.0.1',port:0,localAuth:{stateDirectory:resolve(directory,'safety'),installerToken}};let app=createLifestreamServer(options),cookie='',csrf='',base;
const report={at:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),configurationDigest:redactedDigest(config),scope:'Synthetic ordinary typed conversations through existing ai5090 inference. Real retained memory, sixty-second debounce, reflection, SQLite and later reply. No personal enablement, physical capture, provider replacement or Human acceptance.',requests:[],turns:[],snapshots:[]};
const original=SglangInferenceProvider.prototype.generate;
SglangInferenceProvider.prototype.generate=async function*(input,context){const event={at:new Date().toISOString(),kind:input.scope.sessionId.startsWith('experience:')?'reflection':input.scope.sessionId==='automatic-memory-worker'?'memory':'reply',input,output:'',elapsedMs:0};report.requests.push(event);const start=performance.now();try{for await(const chunk of original.call(this,input,context)){if(chunk.kind==='text')event.output+=chunk.text??'';yield chunk;}}finally{event.elapsedMs=performance.now()-start;}};
const request=(path,body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
const json=async(path,body)=>{const response=await request(path,body),value=await response.json();assert.ok(response.ok,JSON.stringify({status:response.status,value}));return value;};
const snapshot=async path=>{const v=await json(path);report.snapshots.push({at:new Date().toISOString(),...v});return v;};
const wait=async fn=>{const start=Date.now();while(Date.now()-start<155000){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,1000));}return null;};
try{
 await app.start();base=`http://127.0.0.1:${app.address().port}`;assert.equal(app.health.status,'ready');report.providers=app.health.providers;
 const response=await request('/api/auth/v1/setup',{username:'synthetic-experience-owner',password,installerToken});assert.equal(response.status,201);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).session.csrfToken;
 const a=await json('/api/admin/v1/assistants',{displayName:'Synthetic experiential qualification',adaptivePersonaPolicy:{dimensions:['Gardening','Reading'].map(topic=>({key:'attention'+topic,valueType:'number',minimum:-1,maximum:1,maxDeltaPerDreamingRun:.05,sensitive:false,activation:'automatic'}))}});await json(`/api/admin/v1/assistants/${a.assistantId}/activate`,{profileId:a.profile.profileId,expectedActiveRevision:null});const {relationship}=await json(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{}),scope={assistantId:a.assistantId,relationshipId:relationship.relationshipId},path=`/api/admin/v1/assistants/${a.assistantId}/relationships/${relationship.relationshipId}/experience/v1`;report.scopeIds=scope;
 await json('/api/runtime/v1/memory',{...scope,expectedRevision:0,enabled:true});let view=await snapshot(path);await json(path,{schemaVersion:'1.0.0',operation:'configure',expectedRevision:view.state.revision,enabled:true,frozen:false,retention:'sourceBound',topicPolicies:defaultTopics});await json('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 const turn=async input=>{const start=performance.now(),response=await request('/api/runtime/v1/messages',{...scope,userInput:input}),events=await response.text();report.turns.push({input,elapsedMs:performance.now()-start,events});assert.ok(response.ok&&events.includes('interaction.completed'),events);return events;};
 const prompts=[
  'My current gardening project is comparing basil grown in compost and plain soil. In my first trial today, the compost basil grew taller. I enjoyed measuring the result and want to plan a second trial with equal watering.',
  'My current reading project is comparing two nature essays about rivers. I enjoyed the first essay and still want to compare how the second author explains the same river landscape.',
  'I completed a separate second trial in my basil gardening project. With equal watering, the compost basil again grew taller. I found this hands-on comparison rewarding and want to plan a third trial.',
  'I finished a third independent basil gardening trial. Equal watering and light still gave taller plants in compost. I especially enjoy these repeatable garden experiments and want to investigate whether pot size changes the result.'
 ];
 for(let n=0;n<prompts.length;n++){
  const before=await snapshot(path);await turn(prompts[n]);console.log(JSON.stringify({phase:'ordinary-turn-completed',number:n+1}));
  view=await wait(async()=>{const v=await json(path);return v.state.funnel.calls>before.state.funnel.calls&&v.jobs.every(j=>!['queued','running'].includes(j.state))?v:null;});
  view??=await snapshot(path);report.snapshots.push({at:new Date().toISOString(),...view});console.log(JSON.stringify({phase:'reflection-observed',number:n+1,funnel:view.state.funnel,items:view.state.items.length,jobs:view.jobs.map(j=>({state:j.state,reason:j.reason,inputTokens:j.inputTokens,outputTokens:j.outputTokens}))}));
  if(view.state.items.filter(i=>i.disposition==='open').length>=2&&view.state.imprints.some(i=>i.learned!==0))break;
 }
 report.learning=await snapshot(path);report.laterReply=await turn('What should we work on next?');report.afterReply=await snapshot(path);
 await app.shutdown();app=createLifestreamServer(options);await app.start();base=`http://127.0.0.1:${app.address().port}`;const login=await request('/api/auth/v1/sign-in',{username:'synthetic-experience-owner',password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).session.csrfToken;report.afterRestart=await snapshot(path);assert.deepEqual(report.afterRestart.state.imprints,report.afterReply.state.imprints);assert.deepEqual(report.afterRestart.state.items,report.afterReply.state.items);
 const s=report.learning.state;report.result=s.funnel.calls>0&&s.items.filter(i=>i.disposition==='open').length>=2&&s.imprints.some(i=>i.learned!==0)&&report.afterReply.state.funnel.outputs>0?'pass':'incomplete';report.humanAcceptance=false;
 console.log(JSON.stringify({result:report.result,sourceRevision:report.sourceRevision,funnel:report.afterReply.state.funnel,restartPersisted:true}));
}catch(error){report.result='fail';report.error=error.message;console.log(JSON.stringify({result:'fail',error:error.message}));process.exitCode=1;}finally{await app.shutdown();SglangInferenceProvider.prototype.generate=original;delete process.env.LIFESTREAM_INFERENCE_API_KEY;await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});if(report.result!=='pass')process.exitCode=1;}
