import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from '../src/database.ts';
import {ChannelSubscriptionRepository} from '../src/channel-subscriptions.ts';
import {TelegramPairingRepository} from '../src/telegram-pairings.ts';
function fixture(path=':memory:'){
 const db=new Database({path});db.migrate();const owner=randomUUID(),person=randomUUID(),assistant=randomUUID();for(const [id,name,isOwner] of [[owner,'owner',1],[person,'person',0]] as const)db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES (?,?,?,?,?)').run(id,name,isOwner,'synthetic',Date.now());
 const subscriptions=new ChannelSubscriptionRepository(db),s=subscriptions.apply(assistant,owner,{operation:'create',principalId:person,channel:'telegram',label:'Synthetic',requestedConversations:true,requestedAlerts:true});let now=Date.now();const repo=new TelegramPairingRepository(db,()=>now),message={chatId:'1234',userId:'1234',privateChat:true,isBot:false,sentAt:now};
 return {db,owner,person,assistant,s,repo,subscriptions,message,advance:(n:number)=>now+=n};
}
test('pairing requires both account and private chat proof, then independent opt-in; no administration grant',t=>{
 const f=fixture();t.after(()=>f.db.close());assert.throws(()=>f.repo.issue(f.assistant,f.s.id,f.owner,1,'9999'));const issued=f.repo.issue(f.assistant,f.s.id,f.person,1,'9999');assert.equal(issued.state,'challenge');assert.doesNotMatch(JSON.stringify(f.db.connection.prepare('SELECT * FROM telegram_pairings').get()),new RegExp(issued.challenge));assert.equal(f.repo.binding('9999','1234','1234'),undefined);
 assert.equal(f.repo.claim('9999',issued.challenge,f.message),true);assert.equal(f.repo.claim('9999',issued.challenge,f.message),false);const claim=f.repo.inspect(f.assistant,f.s.id,f.person);assert.throws(()=>f.repo.confirm(f.assistant,f.s.id,f.person,claim.revision,'wrong'));assert.throws(()=>f.repo.confirm(f.assistant,f.s.id,f.owner,claim.revision,claim.claimId!));const paired=f.repo.confirm(f.assistant,f.s.id,f.person,claim.revision,claim.claimId!);assert.equal(paired.state,'paired');assert.equal(paired.conversationsEnabled,false);assert.equal(paired.alertsEnabled,false);
 const enabled=f.repo.enable(f.assistant,f.s.id,f.person,paired.revision,true,false),binding=f.repo.binding('9999','1234','1234')!;assert.equal(binding.principalId,f.person);assert.equal(binding.conversationsEnabled,true);assert.equal(binding.alertsEnabled,false);assert.equal(f.repo.current(binding),true);assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM local_assistant_permissions').get()!.n,0);
 f.repo.revoke(f.assistant,f.s.id,f.person,enabled.revision);assert.equal(f.repo.current(binding),false);assert.equal(f.repo.binding('9999','1234','1234'),undefined);assert.equal(f.repo.inspect(f.assistant,f.s.id,f.person).chatId,null);
});
test('groups, bots, forwarded identities, stale challenges and changes are fenced',t=>{
 const f=fixture();t.after(()=>f.db.close());const issued=f.repo.issue(f.assistant,f.s.id,f.person,1,'9999');for(const bad of [{privateChat:false},{isBot:true},{userId:'9876'},{chatId:'-1234'},{sentAt:f.message.sentAt-10000}])assert.equal(f.repo.claim('9999',issued.challenge,{...f.message,...bad}),false);assert.equal(f.repo.claim('8888',issued.challenge,f.message),false);
 f.advance(600_001);assert.equal(f.repo.claim('9999',issued.challenge,f.message),false);assert.equal(f.repo.inspect(f.assistant,f.s.id,f.person).state,'expired');assert.throws(()=>f.repo.issue(f.assistant,f.s.id,f.person,1,'9999'));const next=f.repo.issue(f.assistant,f.s.id,f.person,1,'9999',issued.revision);assert.equal(f.repo.claim('9999',issued.challenge,f.message),false);
 f.subscriptions.apply(f.assistant,f.owner,{operation:'update',id:f.s.id,expectedRevision:1,label:'Changed',requestedConversations:true,requestedAlerts:false});assert.equal(f.repo.claim('9999',next.challenge,f.message),false);assert.equal(f.repo.inspect(f.assistant,f.s.id,f.person).state,'revoked');
});
test('one chat cannot ambiguously select two Assistants; disabled accounts and subscription changes revoke active bindings',t=>{
 const f=fixture();t.after(()=>f.db.close());const pair=(assistant:string,id:string)=>{const i=f.repo.issue(assistant,id,f.person,1,'9999',f.repo.inspect(assistant,id,f.person).revision);assert.equal(f.repo.claim('9999',i.challenge,f.message),true);const c=f.repo.inspect(assistant,id,f.person);return ()=>f.repo.confirm(assistant,id,f.person,c.revision,c.claimId!);};
 const p=pair(f.assistant,f.s.id)();f.repo.enable(f.assistant,f.s.id,f.person,p.revision,true,true);const binding=f.repo.binding('9999','1234','1234')!;const secondAssistant=randomUUID(),second=f.subscriptions.apply(secondAssistant,f.owner,{operation:'create',principalId:f.person,channel:'telegram',label:'Second',requestedConversations:true,requestedAlerts:false});const confirm=pair(secondAssistant,second.id);assert.throws(confirm);
 f.db.connection.prepare('UPDATE local_accounts SET disabled=1 WHERE principal_id=?').run(f.person);assert.equal(f.repo.binding('9999','1234','1234'),undefined);f.db.connection.prepare('UPDATE local_accounts SET disabled=0 WHERE principal_id=?').run(f.person);assert.equal(f.repo.binding('9999','1234','1234'),undefined);
 f.subscriptions.apply(f.assistant,f.owner,{operation:'disable',id:f.s.id,expectedRevision:1});assert.equal(f.repo.current(binding),false);assert.equal(pair(secondAssistant,second.id)().state,'paired');const view=f.repo.inspect(secondAssistant,second.id,f.person);assert.throws(()=>f.repo.enable(secondAssistant,second.id,f.person,view.revision,true,true));
});
test('pending chat proof and pairings survive database reopen without consuming raw tokens',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ls-pairing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite'),f=fixture(path),issued=f.repo.issue(f.assistant,f.s.id,f.person,1,'9999');f.db.close();const db=new Database({path});db.migrate();t.after(()=>db.close());const repo=new TelegramPairingRepository(db);assert.equal(repo.claim('9999',issued.challenge,f.message),true);const c=repo.inspect(f.assistant,f.s.id,f.person),p=repo.confirm(f.assistant,f.s.id,f.person,c.revision,c.claimId!);assert.equal(p.state,'paired');assert.equal(p.alertsEnabled,false);
});
