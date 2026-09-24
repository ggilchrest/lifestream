import {Database,TelegramPairingRepository} from '@lifestream/storage-sqlite';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';

async function fixture(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'ls-subscribers-')),password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');t.after(()=>rm(dir,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(dir,'data.sqlite'),artifactDirectory:join(dir,'artifacts')};
 let app=createLifestreamServer({config,localAuth:{stateDirectory:join(dir,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();const port=app.address().port,base=`http://127.0.0.1:${port}`;t.after(()=>app.shutdown());
 const headers:Record<string,string>={origin:base,'content-type':'application/json'},request=(path:string,body?:unknown,override:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...override},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const setup=await request('/api/auth/v1/setup',{username:'owner',password,installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const {session}=await setup.json();headers['x-lifestream-csrf']=session.csrfToken;
 const read=async(path:string,body?:unknown,status=200)=>{const r=await request(path,body),d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
 await read('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await read('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const assistant=await read('/api/admin/v1/assistants',{displayName:'Synthetic subscriber verification'},201),assistantId=assistant.assistantId;
 await read('/api/auth/v1/accounts',{username:'second',password},201);const {accounts}=await read('/api/auth/v1/accounts'),person=accounts.find((a:{username:string})=>a.username==='second').principalId;
 const path='/api/runtime/v1/channel-subscriptions?assistantId='+assistantId,draft=(principalId=person)=>({operation:'create',principalId,channel:'telegram',label:'Synthetic private chat',requestedConversations:true,requestedAlerts:true});
 return {base,headers,request,read,path,draft,person,session,password,databasePath:config.storage.databasePath,async restart(){await app.shutdown();app=createLifestreamServer({config,port,localAuth:{stateDirectory:join(dir,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();await read('/api/runtime/v1/audience',{mode:'solo',seconds:300});}};
}
test('authenticated subscriber configuration supports several people/destinations and survives actual server restart',async t=>{
 const f=await fixture(t);let d=await f.read(f.path);assert.equal(d.accounts.length,2);assert.deepEqual(d.subscriptions,[]);assert.equal(d.transportReady,false);
 for(const who of [f.person,f.session.principalId,f.person])d=await f.read(f.path,f.draft(who));assert.equal(d.subscriptions.length,3);assert.ok(d.subscriptions.every((x:{status:string})=>x.status==='unpaired'));await f.restart();d=await f.read(f.path);assert.equal(d.subscriptions.length,3);
 const one=d.subscriptions[0];d=await f.read(f.path,{operation:'disable',id:one.id,expectedRevision:one.revision});assert.equal(d.subscriptions.find((x:{id:string})=>x.id===one.id).requestedAlerts,false);assert.equal((await f.request(f.path,{operation:'remove',id:one.id,expectedRevision:one.revision})).status,409);
 await f.read(f.path,{operation:'remove',id:one.id,expectedRevision:2});assert.equal((await f.read(f.path)).subscriptions.find((x:{id:string})=>x.id===one.id).status,'removed');
});
test('owner, Assistant, origin, CSRF and recipient boundaries reject forged configuration without granting access',async t=>{
 const f=await fixture(t);assert.equal((await fetch(f.base+f.path)).status,403);assert.equal((await f.request(f.path,f.draft(),{'x-lifestream-csrf':'bad'})).status,403);assert.equal((await f.request(f.path,f.draft(),{origin:'http://foreign.invalid'})).status,403);assert.equal((await f.request(f.path.replace(/assistantId=.*/, 'assistantId='+randomUUID()))).status,403);assert.equal((await f.request(f.path,{...f.draft(),enabled:true})).status,422);assert.equal((await f.request(f.path,{...f.draft(),principalId:randomUUID()})).status,409);
 const login=await fetch(f.base+'/api/auth/v1/sign-in',{method:'POST',headers:{origin:f.base,'content-type':'application/json'},body:JSON.stringify({username:'second',password:f.password})});assert.equal(login.status,200);assert.equal((await f.request(f.path,undefined,{cookie:login.headers.get('set-cookie')!.split(';')[0]!})).status,403);assert.deepEqual((await f.read(f.path)).subscriptions,[]);
});
test('a delayed save cannot outlive private audience authorization',async t=>{
 const f=await fixture(t),body=JSON.stringify(f.draft());let req!:ReturnType<typeof httpRequest>;const done=new Promise<number|undefined>((resolve,reject)=>{req=httpRequest(f.base+f.path,{method:'POST',headers:{...f.headers,'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});t.after(()=>req.destroy());req.write(body.slice(0,1));await new Promise(r=>setTimeout(r,30));await f.read('/api/runtime/v1/audience',{mode:'shared',seconds:300});req.end(body.slice(1));assert.equal(await done,403);await f.read('/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.deepEqual((await f.read(f.path)).subscriptions,[]);
});

test('members pair only their own assigned chats without administration or external activation',async t=>{
 const f=await fixture(t),created=await f.read(f.path,f.draft()),s=created.subscriptions[0],mine='/api/runtime/v1/my-channel-pairings';
 assert.deepEqual((await f.read(mine)).subscriptions,[]);assert.equal((await f.request(mine,{operation:'issue',id:s.id,expectedRevision:1,pairingRevision:0,botId:'9999'})).status,404);
 const login=await f.request('/api/auth/v1/sign-in',{username:'second',password:f.password});assert.equal(login.status,200);const member=await login.json();f.headers.cookie=login.headers.get('set-cookie')!.split(';')[0]!;f.headers['x-lifestream-csrf']=member.session.csrfToken;
 const list=await f.read(mine);assert.equal(list.subscriptions.length,1);assert.equal(list.transportReady,false);assert.equal((await f.request(f.path)).status,403);
 const issued=await f.read(mine,{operation:'issue',id:s.id,expectedRevision:1,pairingRevision:0,botId:'9999'});assert.ok(issued.issued.challenge);assert.equal((await f.read(mine)).issued,undefined);
 assert.equal((await f.request(mine,{operation:'claim',id:s.id,expectedRevision:1,chatId:'1234'})).status,422);assert.equal((await f.request(mine,{operation:'enable',id:s.id,expectedRevision:1})).status,422);
 const db=new Database({path:f.databasePath});t.after(()=>db.close());const pairs=new TelegramPairingRepository(db);assert.equal(pairs.claim('9999',issued.issued.challenge,{chatId:'1234',userId:'1234',privateChat:true,isBot:false,sentAt:Date.now()}),true);
 let pairing=(await f.read(mine)).subscriptions[0].pairing;assert.equal(pairing.state,'claimed');assert.equal((await f.request(mine,{operation:'confirm',id:s.id,expectedRevision:pairing.revision,claimId:pairing.claimId},{'x-lifestream-csrf':'wrong'})).status,403);
 pairing=(await f.read(mine,{operation:'confirm',id:s.id,expectedRevision:pairing.revision,claimId:pairing.claimId})).subscriptions[0].pairing;assert.equal(pairing.state,'paired');assert.equal(pairing.conversationsEnabled,false);assert.equal(pairing.alertsEnabled,false);
 assert.equal(db.connection.prepare('SELECT count(*) AS n FROM local_assistant_permissions WHERE principal_id=?').get(f.person)!.n,0);
 await f.read(mine,{operation:'revoke',id:s.id,expectedRevision:pairing.revision});assert.equal((await f.read(mine)).subscriptions[0].pairing.state,'revoked');assert.equal(pairs.binding('9999','1234','1234'),undefined);
});
