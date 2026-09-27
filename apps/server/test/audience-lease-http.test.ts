import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';

const path='/api/runtime/v1/audience/lease';
const secret=()=>`synthetic-${randomBytes(24).toString('hex')}`;
async function fixture(t,endpointClass='personalCompanion'){
 const root=await mkdtemp(join(tmpdir(),'ls-audience-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let now=Date.now(),authNow=now;const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>authNow},audiencePrivacy:{sourceIds:[],now:()=>now}});await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const request=(route:string,body?:unknown,extra:Record<string,string>={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request(path,{operation:'begin',leaseId:randomUUID(),expectedAudienceRevision:0})).status,401);
 const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;
 const {session}=await setup.json() as {session:{csrfToken:string;sessionId:string;principalId:string}};headers['x-lifestream-csrf']=session.csrfToken;
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass})).status,200);
 const snapshot=async()=>await (await request('/api/runtime/v1/audience')).json() as {revision:number;leaseId:string|null;privateAllowed:boolean;classification:string;basis:string;expiresAt:string|null};
 const change=async(operation:string,leaseId:string,expectedAudienceRevision?:number)=>request(path,{operation,leaseId,expectedAudienceRevision:expectedAudienceRevision??(await snapshot()).revision});
 return {app,request,snapshot,change,base,headers,session,advance:(ms:number)=>{now+=ms;},expireAdministration:()=>{authNow+=1_800_000;}};
}
test('authenticated personal phone leases enforce CSRF, payload bounds and stable continuing-conversation renewal',async t=>{
 const f=await fixture(t),id=randomUUID(),revision=(await f.snapshot()).revision,body={operation:'begin',leaseId:id,expectedAudienceRevision:revision};
 assert.equal((await f.request(path,body,{'x-lifestream-csrf':'wrong'})).status,403);
 assert.equal((await f.request(path,{...body,leaseId:'not-a-random-uuid'})).status,422);
 assert.equal((await f.request(path,{...body,seconds:300})).status,422);
 const begin=await f.request(path,body);assert.equal(begin.status,200);const active=await begin.json() as {revision:number;leaseId:string;privateAllowed:boolean};assert.equal(active.leaseId,id);assert.equal(active.privateAllowed,true);
 assert.equal((await f.snapshot()).leaseId,id);
 const activity=()=>f.app.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity,original=activity();
 f.expireAdministration();assert.equal((await f.request('/api/auth/v1/session')).status,401);
 f.advance(5000);const renewed=await f.change('renew',id,active.revision);assert.equal(renewed.status,200);assert.equal((await renewed.json() as {revision:number}).revision,active.revision);assert.equal(activity(),original);
 f.advance(20000);assert.equal((await f.snapshot()).privateAllowed,false);assert.equal((await f.change('renew',id)).status,409);
});
test('lease route rejects desktop endpoints and later scope changes retire a phone lease',async t=>{
 const desktop=await fixture(t,'desktopCompanion');assert.equal((await desktop.change('begin',randomUUID())).status,403);
 const phone=await fixture(t),id=randomUUID();assert.equal((await phone.change('begin',id)).status,200);
 assert.equal((await phone.request('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);
 assert.equal((await phone.snapshot()).leaseId,null);assert.equal((await phone.snapshot()).privateAllowed,false);assert.equal((await phone.change('renew',id)).status,403);
 assert.equal((await phone.request('/api/runtime/v1/session-context',{expectedRevision:2,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 assert.equal((await phone.change('renew',id)).status,409,'restoring disclosure does not resurrect the old process lease');
});
test('HTTP replacement and manual privacy decisions cannot be overwritten by late heartbeat or cleanup',async t=>{
 const f=await fixture(t),one=randomUUID(),two=randomUUID();assert.equal((await f.change('begin',one)).status,200);const first=await f.snapshot();
 assert.equal((await f.change('begin',two,first.revision)).status,200);assert.equal((await f.change('end',one,first.revision)).status,200);assert.equal((await f.snapshot()).leaseId,two);
 assert.equal((await f.request('/api/runtime/v1/audience',{mode:'shared',seconds:300})).status,200);assert.equal((await f.change('renew',two)).status,409);assert.equal((await f.change('end',two)).status,200);assert.equal((await f.snapshot()).classification,'shared');
 assert.equal((await f.change('begin',randomUUID())).status,409,'an automatic phone default cannot override a manual shared choice');
});
test('a delayed lease begin rechecks revocation after reading its body',async t=>{
 const f=await fixture(t),body=JSON.stringify({operation:'begin',leaseId:randomUUID(),expectedAudienceRevision:(await f.snapshot()).revision});
 let observed!:()=>void;const received=new Promise<void>(resolve=>{observed=resolve;});f.app.server.once('request',request=>request.once('data',observed));
 let send!:import('node:http').ClientRequest;const result=new Promise<number>((resolve,reject)=>{send=httpRequest(f.base+path,{method:'POST',headers:{...f.headers,'content-length':String(Buffer.byteLength(body))}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});send.on('error',reject);});t.after(()=>send.destroy());
 send.write(body.slice(0,10));await received;assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);send.end(body.slice(10));assert.equal(await result,401);
});
test('a delayed begin cannot override a later clear that leaves audience unknown',async t=>{
 const f=await fixture(t),body=JSON.stringify({operation:'begin',leaseId:randomUUID(),expectedAudienceRevision:(await f.snapshot()).revision});
 let observed!:()=>void;const received=new Promise<void>(resolve=>{observed=resolve;});f.app.server.once('request',request=>request.once('data',observed));
 let send!:import('node:http').ClientRequest;const result=new Promise<number>((resolve,reject)=>{send=httpRequest(f.base+path,{method:'POST',headers:{...f.headers,'content-length':String(Buffer.byteLength(body))}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});send.on('error',reject);});t.after(()=>send.destroy());
 send.write(body.slice(0,10));await received;assert.equal((await f.request('/api/runtime/v1/audience',{mode:'clear'})).status,200);send.end(body.slice(10));assert.equal(await result,409);assert.equal((await f.snapshot()).privateAllowed,false);
});
test('sign-out retires an active lease and publishes the loss before its audience stream closes',async t=>{
 const f=await fixture(t),id=randomUUID();assert.equal((await f.change('begin',id)).status,200);
 const stream=await f.request('/api/runtime/v1/audience/events'),reader=stream.body!.getReader();t.after(()=>reader.cancel());
 assert.match(Buffer.from((await reader.read()).value!).toString(),new RegExp(id));
 assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);
 let received='';for(;;){const item=await reader.read();if(item.done)break;received+=Buffer.from(item.value).toString();}
 assert.match(received,/"leaseId":null/);assert.match(received,/"privateAllowed":false/);
});
