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
const scenarioName=process.env.LIFESTREAM_S086_SCENARIO??'gardening';
const scenarios={
 gardening:{topics:['Gardening','Reading'],prompts:[
  'My current gardening project is comparing basil grown in compost and plain soil. In my first trial today, the compost basil grew taller. I enjoyed measuring the result and want to plan a second trial with equal watering.',
  'My current reading project is comparing two nature essays about rivers. I enjoyed the first essay and still want to compare how the second author explains the same river landscape.',
  'I completed a separate second trial in my basil gardening project. With equal watering, the compost basil again grew taller. I found this hands-on comparison rewarding and want to plan a third trial.',
  'I finished a third independent basil gardening trial. Equal watering and light still gave taller plants in compost. I especially enjoy these repeatable garden experiments and want to investigate whether pot size changes the result.'
 ]},
 reading:{topics:['Reading'],prompts:[
  'My current reading project compares two essays about coastal wetlands. In the first essay, I enjoyed how the writer describes migrating birds at dawn. I want to compare another author describing the same marsh.',
  'I read a second essay about that coastal marsh. Comparing how both writers describe the bird migration was rewarding, and I want to read one more account of the same place.',
  'I finished a third wetlands essay. I especially enjoyed noticing how the same landscape changes between seasons, and I want to compare descriptions of autumn next.'
 ]},
 astronomy:{topics:['Astronomy'],prompts:[
  'My current astronomy project is comparing observations of the Moon through two small telescopes. I enjoyed recording the crater edges in my first session and want to repeat the observation under similar conditions.',
  'I repeated my Moon observation with the same two telescopes. Comparing the crater edges was satisfying, and I want to make one more careful observation before drawing conclusions.',
  'I completed a third independent Moon observation with the same setup. I especially enjoy these patient comparisons and want to check whether a different eyepiece changes what I notice.'
 ]}
};
const scenario=scenarios[scenarioName];
if(!scenario)throw Error(`Unsupported synthetic scenario: ${scenarioName}`);
await mkdir(directory,{recursive:true,mode:0o700});
const config=loadProfile('ai5090');process.env.LIFESTREAM_INFERENCE_API_KEY=await loadWindowsKey();config.authority.authentication='local-password';config.storage={databasePath:resolve(directory,'state.sqlite'),artifactDirectory:resolve(directory,'artifacts')};
const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),options={config,host:'127.0.0.1',port:0,localAuth:{stateDirectory:resolve(directory,'safety'),installerToken}};let app=createLifestreamServer(options),cookie='',csrf='',base;
const report={at:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),scenario:scenarioName,configurationDigest:redactedDigest(config),scope:'Synthetic ordinary typed conversations through existing ai5090 inference. Real retained memory, sixty-second debounce, reflection, SQLite and later reply. No personal enablement, physical capture, provider replacement or Human acceptance.',requests:[],turns:[],snapshots:[]};
const original=SglangInferenceProvider.prototype.generate;
SglangInferenceProvider.prototype.generate=async function*(input,context){const event={at:new Date().toISOString(),kind:input.scope.sessionId.startsWith('experience:')?'reflection':input.scope.sessionId==='automatic-memory-worker'?'memory':'reply',input,output:'',elapsedMs:0};report.requests.push(event);const start=performance.now();try{for await(const chunk of original.call(this,input,context)){if(chunk.kind==='text')event.output+=chunk.text??'';yield chunk;}}finally{event.elapsedMs=performance.now()-start;await writeFile(resolve(directory,'report.partial.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}};
const request=(path,body,timeoutMs=20_000)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs)});
const json=async(path,body)=>{const response=await request(path,body),value=await response.json();assert.ok(response.ok,JSON.stringify({status:response.status,value}));return value;};
const snapshot=async path=>{const v=await json(path);report.snapshots.push({at:new Date().toISOString(),...v});return v;};
const wait=async fn=>{const start=Date.now();while(Date.now()-start<155000){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,1000));}return null;};
const waitForReady=async()=>{const deadline=Date.now()+30_000;let latest;while(Date.now()<deadline){const response=await fetch(base+'/health',{signal:AbortSignal.timeout(10_000)});latest=await response.json();report.providerPreflight=latest;if(response.ok&&latest.status==='ready')return latest;await new Promise(r=>setTimeout(r,1500));}throw new Error(`Provider readiness timed out: ${JSON.stringify(latest?.providers??{})}`);};
try{
 await app.start();base=`http://127.0.0.1:${app.address().port}`;await waitForReady();report.providers=app.health.providers;
 const response=await request('/api/auth/v1/setup',{username:'synthetic-experience-owner',password,installerToken});assert.equal(response.status,201);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).session.csrfToken;
 const a=await json('/api/admin/v1/assistants',{displayName:'Synthetic experiential qualification',adaptivePersonaPolicy:{dimensions:scenario.topics.map(topic=>({key:'attention'+topic,valueType:'number',minimum:-1,maximum:1,maxDeltaPerDreamingRun:.05,sensitive:false,activation:'automatic'}))}});await json(`/api/admin/v1/assistants/${a.assistantId}/activate`,{profileId:a.profile.profileId,expectedActiveRevision:null});const {relationship}=await json(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{}),scope={assistantId:a.assistantId,relationshipId:relationship.relationshipId},path=`/api/admin/v1/assistants/${a.assistantId}/relationships/${relationship.relationshipId}/experience/v1`;report.scopeIds=scope;
 await json('/api/runtime/v1/memory',{...scope,expectedRevision:0,enabled:true});let view=await snapshot(path);await json(path,{schemaVersion:'1.0.0',operation:'configure',expectedRevision:view.state.revision,enabled:true,frozen:false,retention:'sourceBound',topicPolicies:defaultTopics});await json('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 const turn=async input=>{const start=performance.now(),response=await request('/api/runtime/v1/messages',{...scope,userInput:input},45_000),events=await response.text();report.turns.push({input,elapsedMs:performance.now()-start,events});assert.ok(response.ok&&events.includes('interaction.completed'),events);return events;};
 const prompts=scenario.prompts;
 for(let n=0;n<prompts.length;n++){
  const before=await snapshot(path),priorMemoryJobs=new Set((await json('/api/runtime/v1/memory?'+new URLSearchParams(scope))).jobs.map(j=>j.id));await turn(prompts[n]+' Acknowledge in one short sentence.');console.log(JSON.stringify({phase:'ordinary-turn-completed',number:n+1}));
  view=await wait(async()=>{const v=await json(path),memory=await json('/api/runtime/v1/memory?'+new URLSearchParams(scope));if(memory.jobs.some(j=>j.state==='failed'&&!priorMemoryJobs.has(j.id))&&v.state.funnel.eligible===before.state.funnel.eligible){report.memoryFailure=memory;return v;}return v.state.funnel.calls>before.state.funnel.calls&&v.jobs.every(j=>!['queued','running'].includes(j.state))?v:null;});
  view??=await snapshot(path);report.snapshots.push({at:new Date().toISOString(),...view});console.log(JSON.stringify({phase:'reflection-observed',number:n+1,funnel:view.state.funnel,items:view.state.items.length,jobs:view.jobs.map(j=>({state:j.state,reason:j.reason,inputTokens:j.inputTokens,outputTokens:j.outputTokens}))}));
  if(view.state.items.filter(i=>i.disposition==='open').length>=2&&view.state.imprints.some(i=>i.learned!==0))break;
 }
 report.learning=await snapshot(path);report.laterReply=await turn('What should we work on next?');report.afterReply=await snapshot(path);
 await app.shutdown();app=createLifestreamServer(options);await app.start();base=`http://127.0.0.1:${app.address().port}`;const login=await request('/api/auth/v1/sign-in',{username:'synthetic-experience-owner',password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).session.csrfToken;report.afterRestart=await snapshot(path);assert.deepEqual(report.afterRestart.state.imprints,report.afterReply.state.imprints);assert.deepEqual(report.afterRestart.state.items,report.afterReply.state.items);
 const s=report.learning.state;report.result=s.funnel.calls>0&&s.items.filter(i=>i.disposition==='open').length>=2&&s.imprints.some(i=>i.learned!==0)&&report.afterReply.state.funnel.outputs>0?'pass':'incomplete';report.humanAcceptance=false;
 console.log(JSON.stringify({result:report.result,sourceRevision:report.sourceRevision,funnel:report.afterReply.state.funnel,restartPersisted:true}));
}catch(error){report.result='fail';report.error=error.message;console.log(JSON.stringify({result:'fail',error:'Qualification failed; complete synthetic evidence retained in report.json.'}));process.exitCode=1;}finally{await app.shutdown();SglangInferenceProvider.prototype.generate=original;delete process.env.LIFESTREAM_INFERENCE_API_KEY;await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});if(report.result!=='pass')process.exitCode=1;}
