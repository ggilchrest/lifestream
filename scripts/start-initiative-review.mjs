// Fresh synthetic review realm. No existing database, service or provider is changed.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Database} from '../packages/storage-sqlite/dist/index.js';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile} from '../apps/server/src/config/loader.ts';
import {readSessionEndpoint} from '../apps/server/src/runtime/session-context.ts';
import {AUTH_PARAMETERS} from '../apps/server/src/auth/local-auth.ts';
import {extensionSettings} from '../tests/fixtures/extension-settings.ts';

export async function startInitiativeReview({providerProfile='test',port=0,temporaryRoot=tmpdir()}={}){
 if(!['test','ai5090'].includes(providerProfile))throw new Error('Select test or the existing ai5090 provider profile explicitly.');
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid local port.');
 if(providerProfile==='ai5090'&&!process.env.LIFESTREAM_INFERENCE_API_KEY)throw new Error('The existing ai5090 credential must already be supplied in the environment. No fallback is allowed.');
 const directory=await mkdtemp(join(temporaryRoot,'lifestream-initiative-review-'));await chmod(directory,0o700);
 const credentials={username:'synthetic-review',password:randomBytes(24).toString('base64url')},credentialsPath=join(directory,'credentials.json'),safety=join(directory,'safety');
 await writeFile(credentialsPath,JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'});
 const config=loadProfile(providerProfile);config.profile='test';config.authority.authentication='local-password';config.storage={databasePath:join(directory,'application.sqlite'),artifactDirectory:join(directory,'artifacts')};
 const events=new Map();let owner,app,db,closed=false;
 const same=(a,b)=>['assistantId','userId','relationshipId','deploymentId'].every(k=>a?.[k]===b?.[k]);
 const prune=()=>{for(const [id,item] of events)if(item.event.expiresAt<=Date.now())events.delete(id);};
 const simulation={list:(scope,sessionId)=>{prune();return [...events].filter(([,v])=>same(v.scope,scope)&&v.event.sessionId===sessionId).map(([id])=>id);},resolve:(scope,sessionId,id)=>{prune();const value=events.get(id);return value&&same(value.scope,scope)&&value.event.sessionId===sessionId?structuredClone(value.event):undefined;}};
 const close=async()=>{if(closed)return;closed=true;events.clear();try{await app?.shutdown();}finally{db?.close();}};
 try{
  const installerToken=randomBytes(32).toString('base64url');
  app=createLifestreamServer({config,host:'127.0.0.1',port,initiativeSimulation:simulation,localAuth:{stateDirectory:safety,installerToken},profileLoader:()=>{throw new Error('This review host cannot switch profiles or open another database.');}});await app.start();
  if(app.health.status!=='ready')throw new Error('Selected providers are not ready. No fallback was substituted.');
  const base=`http://127.0.0.1:${app.address().port}`;
  const authenticate=async(operation,body)=>{const response=await fetch(base+'/api/auth/v1/'+operation,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Synthetic review authentication failed.');const result=await response.json();return {session:result.session,cookie:response.headers.get('set-cookie').split(';')[0]};};
  const request=async(auth,path,body)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',cookie:auth.cookie,'x-lifestream-csrf':auth.session.csrfToken},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Synthetic review operation failed (${response.status}).`);return response.json();};
  const first=await authenticate('setup',{...credentials,installerToken});let assistant,relationship,consentRef,topicRef;
  try{
   assistant=await request(first,'/api/admin/v1/assistants',{displayName:'Synthetic Initiative Review'});await request(first,`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
   relationship=(await request(first,`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship;
   const path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}`;
   const approve=async content=>{const revision=(await request(first,path)).relationship.revision,result=await request(first,path+'/candidates',{content,category:'declaration',contextUse:'baseline',source:'authored',sourceFamily:'synthetic-review-host',uncertainty:'low',expectedRevision:revision,idempotencyKey:randomUUID()});await request(first,path+`/candidates/${result.candidate.candidateId}/decision`,{decision:'approved',expectedRevision:(await request(first,path)).relationship.revision,idempotencyKey:randomUUID()});return result.candidate.candidateId;};
   consentRef=await approve('Allow synthetic Initiative openings in this isolated development review only.');topicRef=await approve('My synthetic exercise SYNTHETIC_EXERCISE_14 is unfinished; a brief follow-up is welcome.');
   owner={assistantId:assistant.assistantId,userId:first.session.principalId,relationshipId:relationship.relationshipId,deploymentId:relationship.deploymentId};
  }finally{await request(first,'/api/auth/v1/sign-out',{});}
  db=new Database({path:config.storage.databasePath});
  const sessions=()=>{if(closed)return [];const now=Date.now();return db.connection.prepare("SELECT l.session_id AS sessionId,l.token_hash AS tokenHash,l.admin_last_activity AS lastActivity FROM local_sessions l JOIN local_accounts a ON a.principal_id=l.principal_id JOIN sessions s ON s.id=l.session_id WHERE l.principal_id=? AND l.revoked=0 AND a.disabled=0 AND a.epoch=l.epoch AND s.status='active' AND l.authenticated_at<=? AND l.admin_last_activity<=? AND l.admin_last_activity>? ORDER BY l.admin_last_activity DESC LIMIT 32").all(owner.userId,now,now,now-AUTH_PARAMETERS.adminIdleMs).filter(row=>!existsSync(join(safety,`revoked-${row.tokenHash}`))).map(row=>({sessionId:row.sessionId,lastActivity:row.lastActivity,...readSessionEndpoint(db,row.sessionId)})).filter(row=>row.endpoint);};
  const selected=sessionId=>{if(closed)throw new Error('Review host is closed.');const session=sessions().find(row=>row.sessionId===sessionId);if(!session)throw new Error('Choose a current browser session after applying its disclosure.');return session;};
  const configure=async sessionId=>{
   const target=selected(sessionId),auth=await authenticate('sign-in',credentials);
   try{
    const route=`/api/admin/v1/assistants/${owner.assistantId}/relationships/${owner.relationshipId}/initiative/v1`,current=await request(auth,route,{schemaVersion:'1.0.0',operation:'inspect'}),settings={...structuredClone(extensionSettings.initiative),preset:'custom',proactiveness:5,dimensions:{initiative:5,warmth:5,curiosity:3,followThrough:3,persistence:0},allowedContexts:['privateAvailable'],endpointIds:[target.endpoint.endpointId],allowedModalities:['text','speech'],allowedKinds:['arrivalReturn','availableCheckIn','groundedFollowUp'],consentRefs:[consentRef],tuning:{...extensionSettings.initiative.tuning,openingsPerHour:2,openingsPerDay:8,minimumGapSeconds:1200,checkInIntervalSeconds:1800}};
    const draft=await request(auth,route,{schemaVersion:'1.0.0',operation:'draft',idempotencyKey:randomUUID(),expectedActiveConfigurationId:current.activeConfigurationId,settings}),configuration=draft.records.find(row=>row.recordType==='configuration'&&row.lifecycle==='draft');
    const fresh=selected(sessionId);if(fresh.revision!==target.revision||fresh.endpoint.endpointId!==target.endpoint.endpointId)throw new Error('Session changed during preparation; the new configuration remains a draft.');
    await request(auth,route,{schemaVersion:'1.0.0',operation:'activate',idempotencyKey:randomUUID(),configurationId:configuration.configurationId,expectedRevision:configuration.revision,confirmed:true});return {configurationId:configuration.configurationId,endpointId:target.endpoint.endpointId};
   }finally{await request(auth,'/api/auth/v1/sign-out',{});}
  };
  const prepare=(sessionId,kind='availableCheckIn',modality='text')=>{
   selected(sessionId);if(!['availableCheckIn','arrivalReturn','groundedFollowUp'].includes(kind)||!['text','speech'].includes(modality))throw new Error('Choose a supported synthetic kind and text or speech.');prune();if(events.size>=128)throw new Error('Prepared event capacity reached; wait for existing events to expire.');
   const now=Date.now(),sourceEventId=randomUUID(),event={userId:owner.userId,sessionId,sourceEventId,kind,topicRef:kind==='groundedFollowUp'?topicRef:null,observedAt:now-10000,expiresAt:now+60000,context:'privateAvailable',modality,...(kind==='arrivalReturn'?{dwellSeconds:10,absenceSeconds:600}:{}),...(kind==='groundedFollowUp'?{unfinishedEvidenceCurrent:true}: {})};events.set(sourceEventId,{scope:{...owner},event});return {sourceEventId,kind,modality,expiresAt:new Date(event.expiresAt).toISOString()};
  };
  await writeFile(join(directory,'review-environment.json'),JSON.stringify({kind:'lifestream-initiative-synthetic-review-v1',executionProfile:'test',providerProfile,providerImplementations:config.providers,createdAt:new Date().toISOString(),scope:owner},null,2)+'\n',{mode:0o600,flag:'wx'});
  return {app,directory,credentialsPath,base,url:base+'/control/#conversation',scope:{...owner},sessions,configure,prepare,close};
 }catch(error){await close();throw error;}
}

const help='Commands: sessions | setup N | prepare N check-in|arrival|follow-up text|speech | quit\nN is the session number from sessions. Setup explicitly activates synthetic settings for that endpoint. Prepare only adds a synthetic event; it does not change settings, audience, capture or output. Existing cooldown and unanswered-topic restrictions still apply.';
export async function main(args=process.argv.slice(2)){
 if(args.includes('--help')){console.log('node scripts/start-initiative-review.mjs [--providers test|ai5090] [--port PORT]\nAlways creates a fresh, private synthetic realm. ai5090 requires its existing providers and credential; it never falls back.\n'+help);return;}
 const options={};for(let i=0;i<args.length;i+=2){if(!['--providers','--port'].includes(args[i])||!args[i+1])throw new Error('Unknown or incomplete option; use --help.');if(args[i]==='--providers')options.providerProfile=args[i+1];else options.port=Number(args[i+1]);}
 const review=await startInitiativeReview(options),terminal=createInterface({input:process.stdin,output:process.stdout,terminal:process.stdin.isTTY===true});let choices=[];
 const stop=()=>terminal.close();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 console.log(`Synthetic review: ${review.url}\nProvider profile: ${options.providerProfile??'test'}${options.providerProfile==='ai5090'?' (existing configured services)':' (fixture responses, not model or voice qualification)'}\nPrivate credentials file: ${review.credentialsPath}\nSign in, open Session disclosure and apply your chosen audience. Then use sessions.\n${help}`);
 try{for await(const line of terminal){const [command,number,kind,modality,...extra]=line.trim().split(/\s+/u);try{
  if(command==='quit')break;if(command==='help'){console.log(help);continue;}
  if(command==='sessions'){choices=review.sessions();console.log(choices.length?choices.map((row,i)=>`${i+1}. ${row.endpoint.privacyClass==='personal'?'Approved context allowed':'Unknown/shared audience'} · ${row.endpoint.outputModalities.join('/')} · used ${new Date(row.lastActivity).toLocaleTimeString()}`).join('\n'):'No eligible browser sessions. Sign in and apply Session disclosure first.');continue;}
  const target=choices[Number(number)-1];if(!target||extra.length)throw new Error('Use sessions, then choose one listed number.');
  if(command==='setup'&&!kind){await review.configure(target.sessionId);console.log('Synthetic Initiative settings activated for the selected endpoint. Prepare a case next; output remains off.');}
  else if(command==='prepare'){const kinds={'check-in':'availableCheckIn',arrival:'arrivalReturn','follow-up':'groundedFollowUp'};if(!kinds[kind]||!['text','speech'].includes(modality))throw new Error('Use prepare N check-in|arrival|follow-up text|speech.');const result=review.prepare(target.sessionId,kinds[kind],modality);console.log(`Prepared ${kind} (${modality}), expires ${new Date(result.expiresAt).toLocaleTimeString()}. In Conversation, refresh prepared cases, select it, enable case output and run.`);}
  else throw new Error('Unknown command; use help.');
 }catch(error){console.error(error.message);}}}finally{terminal.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await review.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{console.error('Synthetic review startup failed. Check the requested port and explicit provider readiness. No fallback or existing service change occurred.');process.exitCode=1;});
