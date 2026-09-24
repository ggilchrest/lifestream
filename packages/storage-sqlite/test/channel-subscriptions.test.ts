import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database} from '../src/database.ts';
import {ChannelSubscriptionRepository} from '../src/channel-subscriptions.ts';

const fixture=()=>{const db=new Database({path:':memory:'});db.migrate();const owner=randomUUID(),person=randomUUID(),assistant=randomUUID();for(const [id,name,isOwner] of [[owner,'owner',1],[person,'person',0]] as const)db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES (?,?,?,?,?)').run(id,name,isOwner,'synthetic-not-a-password',Date.now());return {db,owner,person,assistant,repo:new ChannelSubscriptionRepository(db)};};
const draft=(principalId:string,channel='telegram')=>({operation:'create',principalId,channel,label:'Private destination',requestedConversations:channel==='telegram',requestedAlerts:true});
test('multiple people and destinations retain independent intent without credentials, grants or sessions',t=>{
 const f=fixture();t.after(()=>f.db.close());const one=f.repo.apply(f.assistant,f.owner,draft(f.owner)),two=f.repo.apply(f.assistant,f.owner,draft(f.owner)),three=f.repo.apply(f.assistant,f.owner,draft(f.person));assert.equal(f.repo.list(f.assistant).length,3);assert.notEqual(one.id,two.id);assert.equal(three.principalId,f.person);assert.equal(one.status,'unpaired');assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM local_assistant_permissions').get()!.n,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM sessions').get()!.n,0);assert.doesNotMatch(JSON.stringify(one),/credential|chatId|token/);
});
test('revision, scope, closed input and account fences preserve saved configuration',t=>{
 const f=fixture();t.after(()=>f.db.close());const one=f.repo.apply(f.assistant,f.owner,draft(f.person));
 const update={operation:'update',id:one.id,expectedRevision:one.revision,label:'New label',requestedConversations:false,requestedAlerts:true};
 assert.throws(()=>f.repo.apply(randomUUID(),f.owner,update),/not_found/);assert.throws(()=>f.repo.apply(f.assistant,f.owner,{...update,chatId:'spoofed'}),/invalid/);assert.throws(()=>f.repo.apply(f.assistant,f.owner,{...update,expectedRevision:0}),/invalid/);
 const next=f.repo.apply(f.assistant,f.owner,update);assert.equal(next.revision,2);assert.throws(()=>f.repo.apply(f.assistant,f.owner,update),/stale/);assert.equal(f.repo.list(f.assistant)[0]!.label,'New label');
 f.db.connection.prepare('UPDATE local_accounts SET disabled=1 WHERE principal_id=?').run(f.person);assert.throws(()=>f.repo.apply(f.assistant,f.owner,{...update,expectedRevision:2}),/account_unavailable/);
 const disabled=f.repo.apply(f.assistant,f.owner,{operation:'disable',id:one.id,expectedRevision:2});assert.equal(disabled.status,'disabled');assert.equal(disabled.requestedAlerts,false);assert.equal(disabled.requestedConversations,false);
 const removed=f.repo.apply(f.assistant,f.owner,{operation:'remove',id:one.id,expectedRevision:3});assert.equal(removed.status,'removed');assert.equal(f.repo.list(f.assistant).length,1);assert.throws(()=>f.repo.apply(f.assistant,f.owner,{...update,expectedRevision:4}),/stale/);
});
test('invalid identities, unsafe names and unsupported mobile conversation permissions are rejected',t=>{
 const f=fixture();t.after(()=>f.db.close());for(const change of [{principalId:randomUUID()},{channel:'email'},{channel:['telegram']},{operation:['create']},{label:''},{label:'x\nunsafe'},{requestedAlerts:'yes'},{channel:'ios-push',requestedConversations:true},{enabled:true}])assert.throws(()=>f.repo.apply(f.assistant,f.owner,{...draft(f.person),...change}));
 const mobile=f.repo.apply(f.assistant,f.owner,draft(f.person,'ios-push'));assert.equal(mobile.status,'unpaired');assert.equal(mobile.requestedConversations,false);
});
test('saved subscriptions survive reopening and bounded history cannot grow without limit',t=>{
 const f=fixture();t.after(()=>f.db.close());for(let i=0;i<128;i++)f.repo.apply(f.assistant,f.owner,draft(f.owner));assert.equal(new ChannelSubscriptionRepository(f.db).list(f.assistant).length,128);assert.throws(()=>f.repo.apply(f.assistant,f.owner,draft(f.owner)),/limit/);
});
