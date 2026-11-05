// Original host/Auth/canonical approval/dispatch with a controlled GET transport.
// No GitHub, inference, media, credentials, or production state are accessed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {readSessionEndpoint} from '../dist/runtime/session-context.js';
import {GitHubPublicTransport,publicJson} from '../dist/knowledge-sources/github-public.js';
import {Database} from '@lifestream/storage-sqlite';
const envelope=(payload:unknown)=>({schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload});
const commit='1'.repeat(40),tree='2'.repeat(40),content='Synthetic public repository observation.\n',blob=createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0'+content).digest('hex');
const secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');
async function fixture(t:{after(fn:()=>unknown):void}){
 const root=mkdtempSync(join(tmpdir(),'canonical-public-github-'));chmodSync(root,0o700);let now=Date.now(),count=0,visibility=true,gate:Promise<void>|undefined,entered:(()=>void)|undefined;
 const transport:typeof fetch=async(input,init)=>{count++;const u=new URL(String(input));assert.equal(u.origin,'https://api.github.com');assert.equal(init?.redirect,'manual');assert.equal(init?.credentials,'omit');assert.equal(new Headers(init?.headers).has('authorization'),false);if(gate){entered?.();await gate;}init?.signal?.throwIfAborted();
  const base='/repos/ggilchrest/lifestream';let value:unknown;
  if(u.pathname===base)value={id:1343370271,full_name:'ggilchrest/lifestream',private:!visibility,visibility:visibility?'public':'private',owner:{id:45693305}};
  else if(u.pathname===base+'/git/commits/'+commit)value={sha:commit,tree:{sha:tree}};
  else if(u.pathname===base+'/git/trees/'+tree)value={sha:tree,truncated:false,tree:[{path:'README.md',mode:'100644',type:'blob',sha:blob,size:Buffer.byteLength(content)}]};
  else if(u.pathname===base+'/contents/README.md'&&u.search==='?ref='+commit)value={type:'file',path:'README.md',sha:blob,size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')};
  else assert.fail('Unexpected controlled transport route');return Response.json(value);
 };
 const config=loadProfile('test');config.authority.authentication='local-password';config.providers.capability='public-github';config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),password=secret(),options={config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now},githubPublic:{enabled:true as const,transport,now:()=>now}};let app=createLifestreamServer(options);await app.start();const port=app.address().port,base=`http://127.0.0.1:${port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 t.after(async()=>{gate=undefined;await app.shutdown();rmSync(root,{recursive:true,force:true});});
 const send=async(path:string,body?:unknown,extra:Record<string,string>={})=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json() as any,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await send('/api/auth/v1/setup',{username:'synthetic-owner',password,installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie!;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const assistant=await send('/api/admin/v1/assistants',{displayName:'Synthetic public repository reader'});assert.equal(assistant.status,201);const assistantId=assistant.body.assistantId;
 const session=await send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass:'desktopCompanion',bindingKey:randomUUID()});assert.equal(session.status,200);
 const relationship=await send(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relationship.status,201);
 const enrollment=`/api/admin/v1/assistants/${assistantId}/github-enrollment`,tools=`/api/authority/v1/assistants/${assistantId}/tools`;
 const enroll=()=>send(enrollment,{operation:'enroll',expectedRevision:0,repository:'ggilchrest/lifestream',context:'personal',commit});
 const prepare=async()=>{const current=await send(enrollment);const idempotencyKey=randomUUID();const r=await send(tools+'/github.public.read/prepare',{idempotencyKey,capabilityVersion:'1.0.0',input:{operation:'readRepository',enrollmentRevision:current.body.revision,scope:{userId:setup.body.session.principalId,assistantId,relationshipId:relationship.body.relationship.relationshipId,context:'personal:'+setup.body.session.principalId,audience:'authenticatedSession'},paths:['README.md'],processing:true,retentionRef:'finite:public-chat-60seconds',budget:{items:1,fileBytes:8000,totalBytes:12000,calls:30,durationMs:5000}},requestedClass:'allowSession',grantExpiresAt:new Date(now+90000).toISOString(),reviewAfter:null,expiresAt:new Date(now+45000).toISOString(),untrustedRationale:null});assert.equal(r.status,201,JSON.stringify(r.body));return {p:r.body.preparation,idempotencyKey};};
 const ready=async()=>{assert.equal((await enroll()).status,200);const {p,idempotencyKey}=await prepare();const {environmentId:_env,sideEffectClass:_effect,...payload}=p.request;const created=await send('/api/authority/v1/requests',envelope(payload));assert.equal(created.status,201,JSON.stringify(created.body));const q=created.body.result;const approved=await send(`/api/authority/v1/requests/${q.requestId}/approve`,envelope({requestId:q.requestId,expectedRevision:q.revision,confirmationDigest:q.confirmationDigest,grantClass:q.requestedClass,expiresAt:q.grantExpiresAt,reviewAfter:q.reviewAfter}));assert.equal(approved.status,200,JSON.stringify(approved.body));return {path:tools+'/invocations/'+p.request.invocationId,command:{grantId:approved.body.result.grant.grantId,idempotencyKey},grant:approved.body.result.grant};};
 return {app:()=>app,config,headers,send,enroll,prepare,ready,enrollment,tools,assistantId,relationshipId:relationship.body.relationship.relationshipId,session:setup.body.session,count:()=>count,advance:(ms:number)=>now+=ms,setPrivate:()=>visibility=false,block(){let release!:()=>void;const started=new Promise<void>(r=>entered=r);gate=new Promise<void>(r=>release=r);return {started,release:()=>{gate=undefined;release();}};},restart:async()=>{await app.shutdown();app=createLifestreamServer({...options,port});await app.start();}};
}
test('public GitHub original HTTP enroll/prepare/approve/dispatch retains metadata only, consumes evidence once and rejects expired/restarted authority',async t=>{
 const f=await fixture(t);assert.equal(f.count(),0);const r=await f.ready(),reply=await f.send(r.path+'/dispatch',r.command);assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.status,'succeeded',JSON.stringify(reply.body));const output=reply.body.result.outcome.payload.output;assert.equal(output.runtimeState,'unknown');assert.equal(output.profileAdmission,false);assert.equal(output.retention,'volatile60seconds');assert.equal(JSON.stringify(output).includes(content.trim()),false);assert.equal(output.snapshots[0].sha256,createHash('sha256').update(content).digest('hex'));
 const count=f.count();assert.equal((await f.send(r.path+'/dispatch',r.command)).body.replayed,true);assert.equal(f.count(),count+2); // original current-access verification, never initial read replay
 const internal=f.app() as any,local=internal.localAuth.hostSessionContext(f.session.sessionId),claim=await internal.integrations.repositoryEvidence(r.path.split('/').at(-1),local,f.assistantId,output.relationshipId,AbortSignal.timeout(5000),()=>true);assert.ok(claim.text.includes(content.trim()));assert.equal(claim.current(),true);await assert.rejects(()=>internal.integrations.repositoryEvidence(r.path.split('/').at(-1),local,f.assistantId,output.relationshipId,AbortSignal.timeout(5000),()=>true));assert.equal(claim.current(),true);claim.release();assert.equal(claim.current(),false);assert.ok((await f.send(r.path)).status>=400);
 const db=internal.database as Database;for(const table of ['integration_repository_custody','integration_provider_evidence'])for(const row of db.connection.prepare('SELECT * FROM '+table).all())assert.equal(JSON.stringify(row).includes(content.trim()),false);
 await f.restart();const state=await f.send(f.enrollment);assert.equal(state.body.state,'reauthRequired');assert.ok((await f.send(r.path+'/dispatch',r.command)).status>=400);
});
test('enrollment currentness is latched across a genuine endpoint privacy withdrawal and cannot publish late ready',async t=>{
 const f=await fixture(t),g=f.block(),pending=f.enroll();await g.started;assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);g.release();assert.ok((await pending).status>=400);assert.ok((await f.send(f.enrollment)).status>=400);
});
test('source visibility loss, native CSRF and unselected host cannot bypass public read authority',async t=>{
 const f=await fixture(t);assert.equal((await f.send(f.enrollment,{operation:'enroll',expectedRevision:0,repository:'ggilchrest/lifestream',context:'personal',commit},{'x-lifestream-csrf':'wrong'})).status,403);assert.equal(f.count(),0);const r=await f.ready();f.setPrivate();assert.ok((await f.send(r.path+'/dispatch',r.command)).body.status!=='succeeded');
 f.config.providers.capability='unavailable';assert.ok((await f.send(f.tools)).status>=400);
});
test('public GET transport refuses SSRF, credentials, redirects and rate overflow; metadata is byte bounded',async()=>{
 const db=new Database({path:':memory:'});db.migrate();let calls=0;const transport=new GitHubPublicTransport(db,async()=>{calls++;return Response.json({});});
 try{for(const [url,init] of [['http://127.0.0.1/',{}],['https://evil.invalid/repos/ggilchrest/lifestream',{}],['https://api.github.com/repos/ggilchrest/lifestream',{headers:{authorization:'Bearer synthetic'}}],['https://api.github.com/repos/ggilchrest/lifestream',{method:'POST'}],['https://api.github.com/repos/ggilchrest/lifestream?x=1',{}]] as const)await assert.rejects(()=>transport.fetch(url,init));assert.equal(calls,0);for(let i=0;i<60;i++)await transport.fetch('https://api.github.com/repos/ggilchrest/lifestream');await assert.rejects(()=>transport.fetch('https://api.github.com/repos/ggilchrest/lifestream'),/rate_limited/);assert.equal(calls,60);
 const redirect=new GitHubPublicTransport(db,async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1'}}),()=>Date.now()+3600001);await assert.rejects(()=>redirect.fetch('https://api.github.com/repos/ggilchrest/lifestream'),/response_refused/);
 await assert.rejects(()=>publicJson(new Response('x'.repeat(64001))),/metadata_invalid/);
 }finally{db.close();}
});
test('explicit public host selection is required and does not alter default fixture composition',async t=>{
 const root=mkdtempSync(join(tmpdir(),'public-github-selection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db'),artifactDirectory:join(root,'artifacts')};config.providers.capability='public-github';assert.throws(()=>createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken:secret()}}),/selection missing/);
 config.providers.capability='fixture';assert.throws(()=>createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken:secret()},githubPublic:{enabled:true}}),/explicit governed/);
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken:secret()}});await app.start();try{assert.equal((app as any).integrations,undefined);assert.equal((app as any).database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='github_public_enrollments'").get(),undefined);}finally{await app.shutdown();}
});

test('actual manual Lock, explicit grant revocation and evidence timeout deny retained output without replay or automatic grant',async t=>{
 const f=await fixture(t),r=await f.ready();assert.equal((await f.send(r.path+'/dispatch',r.command)).body.status,'succeeded');
 // Register the existing source-owned owner in its protected state, then use
 // the exact current original eight-field command to unlock and lock it.
 const internal=f.app() as any,selected=readSessionEndpoint(internal.database,f.session.sessionId);
 // Original default endpoint is a personal desktop; no endpoint identity rewrite.
 assert.equal(selected.endpoint?.endpointClass,'desktopCompanion');
 let state=(await f.send('/api/runtime/v1/audience/personal-session')).body;
 const command=(operation:string)=>({operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:state.revision,expectedPersonalSessionEpoch:state.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint!.endpointId,expectedEndpointRevision:selected.endpoint!.configurationRevision});
 const unlocked=await f.send('/api/runtime/v1/audience/personal-session',command('unlock'));assert.equal(unlocked.status,200,JSON.stringify(unlocked.body));state=unlocked.body;
 assert.equal((await f.send('/api/runtime/v1/audience/personal-session',command('lock'))).status,200);
 const before=f.count();assert.ok((await f.send(r.path)).status>=400);assert.equal(f.count(),before);
 const revoked=await f.send(`/api/authority/v1/grants/${r.grant.grantId}/revoke`,envelope({grantId:r.grant.grantId,expectedRevision:r.grant.revision,reason:{code:'synthetic_revoke',summary:'Explicit synthetic withdrawal'}}));assert.equal(revoked.status,200,JSON.stringify(revoked.body));assert.ok((await f.send(r.path+'/dispatch',r.command)).status>=400);
 const g=await fixture(t),other=await g.ready();assert.equal((await g.send(other.path+'/dispatch',other.command)).body.status,'succeeded');g.advance(60001);assert.ok((await g.send(other.path)).status>=400);
});

test('delegated assistant permission never supplies owner enrollment and real admin expiry does not become public authority',async t=>{
 const f=await fixture(t),password=secret(),created=await f.send('/api/auth/v1/accounts',{username:'synthetic-member',password});assert.equal(created.status,201);
 assert.equal((await f.send('/api/auth/v1/permissions',{principalId:created.body.principalId,assistantId:f.assistantId,administer:true})).status,200);
 const signed=await f.send('/api/auth/v1/sign-in',{username:'synthetic-member',password,totp:''});assert.equal(signed.status,200);const memberHeaders={cookie:signed.cookie!,'x-lifestream-csrf':signed.body.session.csrfToken};
 assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass:'desktopCompanion',bindingKey:randomUUID()},memberHeaders)).status,200);
 const denied=await f.send(f.enrollment,undefined,memberHeaders);assert.equal(denied.status,403);assert.equal(denied.body.code,'github_private_owner_required');assert.equal(f.count(),0);
 f.advance(1800001);assert.equal((await f.send(f.enrollment)).status,401);assert.equal(f.count(),0);
 const internal=f.app() as any;assert.doesNotThrow(()=>internal.localAuth.assertCurrent(internal.localAuth.hostSessionContext(f.session.sessionId),false));
});

test('prepared integration context requires actual private audience before and after original compilation, including genuine manual Lock',async t=>{
 const f=await fixture(t),path=`/api/admin/v1/assistants/${f.assistantId}/relationships/${f.relationshipId}/integrations/context`,input={userInput:'Synthetic private context preview',context:'personal:'+f.session.principalId};
 assert.equal((await f.send(path,input)).status,200);
 const internal=f.app() as any,selected=readSessionEndpoint(internal.database,f.session.sessionId);let state=(await f.send('/api/runtime/v1/audience/personal-session')).body;
 const command=(operation:string)=>({operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:state.revision,expectedPersonalSessionEpoch:state.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint!.endpointId,expectedEndpointRevision:selected.endpoint!.configurationRevision});
 state=(await f.send('/api/runtime/v1/audience/personal-session',command('unlock'))).body;assert.equal(state.privateAllowed,true);
 assert.equal((await f.send(path,input)).status,200);assert.equal((await f.send('/api/runtime/v1/audience/personal-session',command('lock'))).status,200);
 const denied=await f.send(path,input);assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(denied.body.code,'integration_private_scope_required');
 state=(await f.send('/api/runtime/v1/audience/personal-session')).body;assert.equal((await f.send('/api/runtime/v1/audience/personal-session',command('unlock'))).status,200);
 const original=internal.admin.getPreparedRelationshipContext.bind(internal.admin),local=internal.localAuth.hostSessionContext(f.session.sessionId);
 internal.admin.getPreparedRelationshipContext=(...args:any[])=>{const value=original(...args);internal.localAuth.logout(local);return value;};
 const retired=await f.send(path,input);assert.equal(retired.status,403);assert.equal(retired.body.code,'integration_private_scope_required');
});
